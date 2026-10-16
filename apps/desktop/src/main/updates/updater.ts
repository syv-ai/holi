/**
 * Updating Holi itself (docs/features/updates.md): electron-updater against
 * the GitHub releases of `syv-ai/holi`, which CI publishes signed and
 * notarized. An update downloads on its own and installs on quit; the renderer
 * observes one status, pushed whole on `updates:status`, and the one thing a
 * person does is restart once it is ready.
 *
 * A dev build is not supported: there is no packaged app to replace, and
 * electron-updater would refuse anyway.
 */
import { join } from 'node:path'
import { app, powerMonitor } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { jsonFileStore } from '../json-file-store'
import { initialStatus, reduce, shouldCheck, type UpdateChannel, type UpdateEvent, type UpdateStatus } from './state'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 10 * 1000

export interface Updater {
  status(): UpdateStatus
  /** A person's "Check now". */
  check(): Promise<UpdateStatus>
  /** Retry a download that failed. */
  download(): Promise<UpdateStatus>
  /** Quit and install the downloaded update. */
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
      channel: value?.channel === 'dev' ? 'dev' as const : 'stable' as const,
    }
  })
  let status = initialStatus({
    supported: app.isPackaged,
    enabled: true,
    version: app.getVersion(),
    channel: 'stable',
  })
  let interval: ReturnType<typeof setInterval> | null = null
  let firstCheck: ReturnType<typeof setTimeout> | null = null
  let switching = false
  let operation: Promise<unknown> = Promise.resolve()
  let installChannel: UpdateChannel | null = null

  const apply = (event: UpdateEvent): void => {
    if (switching) return
    status = reduce(status, event, Date.now())
    if (event.type === 'available' || event.type === 'downloaded') installChannel = status.channel
    deps.send(status)
  }

  const run = async (source: 'user' | 'background'): Promise<UpdateStatus> => {
    if (switching || !shouldCheck(status, source, Date.now())) return status
    apply({ type: 'check-started' })
    const active = (async () => {
      try {
        await autoUpdater.checkForUpdates()
      } catch (err) {
        // `error` usually fires too, but not for every rejection.
        apply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    operation = active
    await active
    return status
  }
  const background = (): void => void run('background')

  if (status.supported) {
    autoUpdater.autoDownload = true
    // Never let electron-updater install a cached candidate on an ordinary quit.
    // Only our channel-checked explicit install path may install it.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = {
      info: (m: unknown) => console.log('[updates]', m),
      warn: (m: unknown) => console.warn('[updates]', m),
      error: (m: unknown) => console.error('[updates]', m),
      debug: () => {},
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

  void prefs.read().then(({ enabled, channel }) => {
    status = { ...status, enabled, channel }
    autoUpdater.channel = channel === 'dev' ? 'dev' : null
    autoUpdater.allowPrerelease = channel === 'dev'
    autoUpdater.allowDowngrade = true
    deps.send(status)
  })

  return {
    status: () => status,
    check: () => run('user'),
    async download() {
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
    async setChannel(channel) {
      if (channel === status.channel) return status
      switching = true
      await prefs.update((current) => ({ ...current, channel }))
      await operation
      autoUpdater.channel = channel === 'dev' ? 'dev' : null
      autoUpdater.allowPrerelease = channel === 'dev'
      autoUpdater.allowDowngrade = true
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
      // The updater's own listeners stay: a downloaded update installs on the
      // quit this precedes.
    },
  }
}
