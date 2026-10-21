/** GitHub release updates for packaged Holi (docs/features/updates.md). */
import { join } from 'node:path'
import { app, powerMonitor } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { jsonFileStore } from '../json-file-store'
import {
  initialStatus,
  reduce,
  shouldCheck,
  type UpdateChannel,
  type UpdateEvent,
  type UpdateStatus,
} from './state'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 10 * 1000

export interface Updater {
  status(): UpdateStatus
  /** A person's "Check now". */
  check(): Promise<UpdateStatus>
  /** Retry a download that failed. */
  download(): Promise<UpdateStatus>
  /** Quit and install the downloaded update after the normal quit teardown. */
  installOnQuit(): boolean
  /** Quit and install the downloaded update after explicit restart confirmation. */
  install(): void
  setEnabled(enabled: boolean): Promise<UpdateStatus>
  setChannel(channel: UpdateChannel): Promise<UpdateStatus>
  dispose(): void
}

export function createUpdater(deps: {
  send: (status: UpdateStatus) => void
  /** Before the app quits to install: what a quit through ⌘Q runs too, its
   *  confirm included. False when the person kept the app open. */
  beforeInstall: () => Promise<boolean>
}): Updater {
  const prefs = jsonFileStore(join(app.getPath('userData'), 'updates.json'), (raw) => {
    const value = raw as { enabled?: unknown; channel?: unknown } | null
    return {
      enabled: value?.enabled !== false,
      channel: value?.channel === 'dev' ? ('dev' as const) : ('stable' as const),
    }
  })
  let status = initialStatus({
    supported: app.isPackaged,
    enabled: true,
    version: app.getVersion(),
  })
  let interval: ReturnType<typeof setInterval> | null = null
  let firstCheck: ReturnType<typeof setTimeout> | null = null
  let switching = false
  let generation = 0
  let operation: Promise<unknown> = Promise.resolve()
  let channelQueue: Promise<unknown> = Promise.resolve()
  let cancellationToken: { cancel(): void } | null = null
  let installChannel: UpdateChannel | null = null
  let initialized = false

  const apply = (event: UpdateEvent): void => {
    if (switching || !initialized) return
    status = reduce(status, event, Date.now())
    if (event.type === 'available' || event.type === 'downloaded') installChannel = status.channel
    deps.send(status)
  }

  const run = async (source: 'user' | 'background'): Promise<UpdateStatus> => {
    await initialization
    if (switching || !shouldCheck(status, source, Date.now())) return status
    apply({ type: 'check-started' })
    const runGeneration = generation
    const active = (async () => {
      try {
        const result = await autoUpdater.checkForUpdates()
        if (!result) return
        cancellationToken = result.cancellationToken ?? null
        if (runGeneration !== generation) cancellationToken?.cancel()
        // checkForUpdates resolves before electron-updater's auto-download.
        // Drain the download before a channel switch starts its new check.
        await result.downloadPromise
      } catch (err) {
        if (runGeneration === generation) {
          apply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      } finally {
        if (runGeneration === generation) cancellationToken = null
      }
    })()
    operation = active
    await active
    return status
  }
  const background = (): void => void run('background')

  if (status.supported) {
    // Squirrel cannot unstage ZIPs; install only the selected one after quit teardown.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = {
      info: (m: unknown) => console.log('[updates]', m),
      warn: (m: unknown) => console.warn('[updates]', m),
      error: (m: unknown) => console.error('[updates]', m),
    }
    autoUpdater.on('update-available', (info: UpdateInfo) =>
      apply({ type: 'available', version: info.version }),
    )
    autoUpdater.on('update-not-available', () => apply({ type: 'not-available' }))
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      apply({ type: 'progress', percent: p.percent }),
    )
    autoUpdater.on('update-downloaded', () => apply({ type: 'downloaded' }))
    autoUpdater.on('error', (err: Error) => apply({ type: 'error', message: err.message }))

    // A laptop shut for a week notices on the way back, not hours later;
    // `shouldCheck` holds both to the cooldown.
    interval = setInterval(background, CHECK_INTERVAL_MS)
    firstCheck = setTimeout(background, FIRST_CHECK_DELAY_MS)
    app.on('browser-window-focus', background)
    powerMonitor.on('resume', background)
  }

  const initialization = prefs.read().then(
    ({ enabled, channel }) => {
      status = { ...status, enabled, channel }
      autoUpdater.channel = channel === 'dev' ? 'dev' : 'latest'
      autoUpdater.allowPrerelease = channel === 'dev'
      initialized = true
      deps.send(status)
    },
    (err: unknown) => {
      initialized = true
      status = { ...status, lastError: err instanceof Error ? err.message : String(err) }
    },
  )

  return {
    status: () => status,
    check: () => run('user'),
    async download() {
      await initialization
      if (!status.supported || status.state !== 'available') return status
      apply({ type: 'progress', percent: 0 })
      const active = (async () => {
        try {
          await autoUpdater.downloadUpdate()
        } catch (err) {
          apply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })()
      operation = active
      await active
      return status
    },
    installOnQuit() {
      if (!status.supported || status.state !== 'ready' || installChannel !== status.channel)
        return false
      autoUpdater.quitAndInstall()
      return true
    },
    install() {
      if (!status.supported || status.state !== 'ready') return
      // The person clicked "Restart to update": that is the confirmation. The
      // vault is flushed, committed and pushed first, as on any quit.
      void deps
        .beforeInstall()
        .catch((err) => {
          console.error('[updates] teardown before install failed:', err)
          return true
        })
        .then((go) => {
          if (go && status.state === 'ready' && installChannel === status.channel) {
            autoUpdater.quitAndInstall()
          }
        })
    },
    setChannel(channel) {
      const request = channelQueue.then(() => switchChannel(channel))
      channelQueue = request.catch(() => {})
      return request
    },
    async setEnabled(enabled) {
      await prefs.update((current) => ({ ...current, enabled }))
      status = { ...status, enabled }
      deps.send(status)
      return status
    },
    dispose() {
      if (interval !== null) clearInterval(interval)
      if (firstCheck !== null) clearTimeout(firstCheck)
      app.removeListener('browser-window-focus', background)
      powerMonitor.removeListener('resume', background)
      // The updater's own listeners stay for a downloaded update's explicit
      // quit-and-install path.
    },
  }

  async function switchChannel(channel: UpdateChannel): Promise<UpdateStatus> {
    await initialization
    if (channel === status.channel) return status
    switching = true
    generation += 1
    cancellationToken?.cancel()
    cancellationToken = null
    try {
      await prefs.update((current) => ({ ...current, channel }))
    } catch (err) {
      // The old operation was invalidated before persisting. Drain it and
      // clear its transient state so a failed write cannot strand checking.
      await operation
      if (status.state === 'checking' || status.state === 'downloading') {
        installChannel = null
        status = {
          ...status,
          state: 'idle',
          availableVersion: null,
          percent: null,
          checkStartedAt: null,
        }
        deps.send(status)
      }
      switching = false
      throw err
    }
    await operation
    autoUpdater.channel = channel === 'dev' ? 'dev' : 'latest'
    autoUpdater.allowPrerelease = channel === 'dev'
    installChannel = null
    status = {
      ...status,
      channel,
      state: 'idle',
      availableVersion: null,
      percent: null,
      checkStartedAt: null,
      lastError: null,
    }
    switching = false
    deps.send(status)
    return run('user')
  }
}
