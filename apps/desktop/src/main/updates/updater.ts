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
import { initialStatus, reduce, shouldCheck, type UpdateEvent, type UpdateStatus } from './state'

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
  dispose(): void
}

export function createUpdater(deps: {
  send: (status: UpdateStatus) => void
  /** Before the app quits to install: what a quit through ⌘Q runs too, its
   *  confirm included. False when the person kept the app open. */
  beforeInstall: () => Promise<boolean>
}): Updater {
  const prefs = jsonFileStore(join(app.getPath('userData'), 'updates.json'), (raw) => ({
    enabled: (raw as { enabled?: unknown } | null)?.enabled !== false,
  }))
  let status = initialStatus({
    supported: app.isPackaged,
    enabled: true,
    version: app.getVersion(),
  })
  let interval: ReturnType<typeof setInterval> | null = null
  let firstCheck: ReturnType<typeof setTimeout> | null = null

  const apply = (event: UpdateEvent): void => {
    status = reduce(status, event, Date.now())
    deps.send(status)
  }

  const run = async (source: 'user' | 'background'): Promise<UpdateStatus> => {
    if (!shouldCheck(status, source, Date.now())) return status
    apply({ type: 'check-started' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // `error` usually fires too, but not for every rejection.
      apply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return status
  }
  const background = (): void => void run('background')

  if (status.supported) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
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

  void prefs.read().then(({ enabled }) => {
    status = { ...status, enabled }
    deps.send(status)
  })

  return {
    status: () => status,
    check: () => run('user'),
    async download() {
      if (!status.supported || status.state !== 'available') return status
      apply({ type: 'progress', percent: 0 })
      try {
        await autoUpdater.downloadUpdate()
      } catch (err) {
        apply({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
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
          if (go) autoUpdater.quitAndInstall()
        })
    },
    async setEnabled(enabled) {
      await prefs.update(() => ({ enabled }))
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
