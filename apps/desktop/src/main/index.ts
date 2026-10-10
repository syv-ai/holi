/**
 * The app: one window, one signed-in GitHub session, one open vault.
 *
 * Read the order in `whenReady` as a dependency chain: the session before the
 * host (the host hands git a closure over its token), the host before the
 * router, and the window before anything pushes to it.
 *
 * `electron-vite` resolves imports without typechecking, so an unresolvable
 * import anywhere on this path stops the window opening at all.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session as electronSession,
  shell,
  type Tray,
} from 'electron'
import { snapshotTasks } from '@holi/shared'
import { requestFlush, type FlushChannel } from './flush'
import { guardNavigation } from './window-guard'
import { vaultScheme } from './vault/asset-protocol'
import { createSession } from './github/electron'
import { createMembersCache } from './github/members-cache'
import { installHoliCli } from './bridge/cli'
import { createCapabilityHost } from './capabilities/dispatch'
import { CapabilityError } from './capabilities/error'
import { createCapabilityRegistry } from './capabilities/registry'
import { vaultCapabilities, VAULT_NAMESPACES } from './capabilities/vault-caps'
import { taskCapabilities, TASK_NAMESPACES, TASKS_PART } from './vault/task-capabilities'
import { coreSeed } from './vault/seed/core'
import { MAIN_PLUGINS } from '../plugins/main'
import { install } from './plugin-host/installed'
import { createPluginHost } from './plugin-host/host'
import type { PluginEventsDeps } from './plugin-host/events'
import { frameSchemes, schemeEntries, serveScheme } from './plugin-host/schemes'
import {
  describeUpdate,
  pendingShipped,
  updateConflictPrompt,
  updateShipped,
} from './vault/seed/update'
import { createVaultPreCommit } from './vault/hooks/pre-commit'
import { registerGitRoutes } from './vault/git-routes'
import { registerIpc } from './ipc'
import { createRouter, localToday } from './router'
import { createCoreServices, createUiReports } from './capabilities/services'
import { createVaultHost } from './vault/active-vault'
import { VaultRegistry, vaultRoot } from './vault/registry'
import { scanVault } from './vault/vault-store'
import { createDeliveredLog, createReminderRuntime } from './reminders/runtime'
import { createNotifier } from './reminders/notify'
import type { VaultTasks } from './reminders/sweep'
import { createTray } from './tray'
import { createUpdater, type Updater } from './updates/updater'
import { installAppMenu } from './menu'
import { createBridgeEnv } from './bridge/env-file'
import { createBridgeServer } from './bridge/server'

// The plugins this build has: the one place main imports them.
install(MAIN_PLUGINS)

/** What seeds every vault, core first: its `.gitignore` is written before
 *  any file that could be committed. Enabled plugins' seeds follow. */
const CORE_SEEDS = [coreSeed(MAIN_PLUGINS.map((p) => p.info))]

// Declared before the launch check below, which starts `main()` synchronously:
// a `let` still in its temporal dead zone would throw during startup.
let mainWindow: BrowserWindow | null = null

// Held at module scope, not inside `main()`: a `Tray` that gets garbage-collected
// vanishes from the menu bar, so it must outlive the setup closure.
let tray: Tray | null = null

// Every scheme this build serves, core's then each plugin's: vault assets,
// and whatever plugins add (vault apps' `holi-app:`). Electron takes them only before
// app-ready, so they are declared at module top level, not in main().
const SCHEMES = schemeEntries([vaultScheme], MAIN_PLUGINS)
protocol.registerSchemesAsPrivileged(
  SCHEMES.map(({ scheme }) => ({ scheme: scheme.scheme, privileges: scheme.privileges })),
)
const FRAME_SCHEMES = frameSchemes(SCHEMES)

// A second launch must not happen at all: one Holi process owns every vault,
// so excluding a second app excludes a second writer on every clone, without a
// per-clone lockfile's stale-lock handling. Must be claimed BEFORE `whenReady`.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

/** The main window. `show: false` for a launch at login: its page still loads
 *  and opens the vault, out of sight until the tray's Open Holi or the dock. */
function createWindow({ show = true }: { show?: boolean } = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // After the load, so the guard knows what "the app" is. A drop the renderer
  // does not claim is a navigation, and Electron answers a navigation with a
  // window — see window-guard.ts.
  guardNavigation(
    win,
    devUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href,
    (url) => {
      void shell.openExternal(url)
    },
    FRAME_SCHEMES,
  )
  return win
}

async function main(): Promise<void> {
  app.on('second-instance', () => {
    // Someone tried to launch Holi again: show them the one they have.
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  await app.whenReady()

  // After whenReady: the keychain is not available before it.
  const session = await createSession()
  const userDataDir = app.getPath('userData')
  const registry = new VaultRegistry(join(app.getPath('userData'), 'vaults.json'))

  const send = (channel: string, payload: unknown) => mainWindow?.webContents.send(channel, payload)

  const bridgeEnv = createBridgeEnv()
  /** remote → the undo of what the open vault's env file carries. */
  const vaultEnv = new Map<string, () => void>()
  /**
   * What an open vault's `bridge.local.env` carries: the bridge's port and
   * the vault's standing token (the same one git's hooks in the clone use).
   * Called at open; `bridge` exists long before any vault can open.
   */
  const contributeVaultEnv = (remote: string): (() => void) => {
    const undo: Array<() => void> = []
    const bridgePort = bridge.port()
    if (bridgePort !== null) {
      undo.push(
        bridgeEnv.contribute(remote, {
          HOLI_BRIDGE_PORT: String(bridgePort),
          HOLI_BRIDGE_TOKEN: bridge.tokenForVault(remote),
        }),
      )
    }
    return () => undo.forEach((u) => u())
  }

  /** Plugin events, both ways, over the one window. */
  const eventsDeps: PluginEventsDeps = {
    send,
    listen: (channel, handler) => {
      const listener = (_e: unknown, message: unknown) => handler(message)
      ipcMain.on(channel, listener)
      return () => void ipcMain.removeListener(channel, listener)
    },
    liveRemote: () => host.active()?.remote ?? null,
  }

  // Every capability, from every door. Created ahead of the vault host so
  // the plugin host can register into it; `host` and `rootFor` are read
  // lazily.
  const capabilities = createCapabilityRegistry()
  const plugins = createPluginHost({
    plugins: MAIN_PLUGINS,
    core: [TASKS_PART],
    registry: capabilities,
    userData: userDataDir,
    coreSeeds: CORE_SEEDS,
    active: () => host.active(),
    rootFor: (remote) => rootFor(remote),
    events: eventsDeps,
    // `capabilityHost` is built below, long before any vault opens.
    openAppDoor: (opener) => capabilityHost.openAppDoor(opener),
    // The bridge and the `holi` command exist before any vault can open.
    route: (path, route) => bridge.route(path, route),
    binDir: () => binDir,
  })

  const host = createVaultHost({
    registry,
    // A GETTER, not a string. Read lazily on every git operation, so a sign-out
    // takes effect on the next pull rather than the next restart.
    gitDeps: { token: () => session.token() },
    claims: (root) => plugins.scanClaimsFor(root),
    onSnapshot: (snapshot) => {
      send('vault:snapshot', snapshot)
      // A hand edit to the settings files arrives this way too. When it
      // changed which plugins claim files, that scan used the old claims:
      // scan again with the new ones.
      plugins.invalidate()
      const active = host.active()
      if (active === null) return
      void plugins.scanClaimsFor(active.root).then((claims) => {
        const now = new Set(claims.map((c) => c.plugin))
        const was = Object.keys(snapshot.claimed)
        if (was.length !== now.size || was.some((id) => !now.has(id))) {
          void active.refresh().catch((err) => console.error('[vault] rescan:', err))
        }
      })
    },
    onSyncState: (state) => send('vault:sync', state),
    // How everything inside the vault reaches us: its `bridge.local.env`,
    // with what each part of Holi contributes while the vault is open. Made
    // at open, so the file names this run's ports, which move on restart.
    bridgeEnv: {
      attach: async (remote, root) => {
        vaultEnv.get(remote)?.()
        vaultEnv.set(remote, contributeVaultEnv(remote))
        await bridgeEnv.attach(remote, root)
      },
      detach: async (remote) => {
        vaultEnv.get(remote)?.()
        vaultEnv.delete(remote)
        await bridgeEnv.detach(remote)
      },
    },
    // The large-file gate's held-back set (empty clears the callout). Pushed
    // every commit tick and once at open, so a vault switch resets it.
    onHeldBack: (files) => send('vault:heldback', files),
    onCommitted: (paths) => send('vault:committed', paths),
    // What plugins run in the vault is disposed here, the only place that
    // still holds the vault they ran in.
    onLeave: () => plugins.leave(),
  })

  // Serve every scheme. A plugin's answers 404 while the open vault has it off.
  for (const entry of SCHEMES) {
    protocol.handle(
      entry.scheme.scheme,
      serveScheme(entry, {
        active: () => host.active(),
        runs: async (owner, root) => (await plugins.enabled(root)).has(owner),
      }),
    )
  }

  // What the renderer reports the person is looking at: capabilities and the
  // router both read it.
  const uiReports = createUiReports()

  /**
   * Geolocation is refused outright. Electron answers it through Google's
   * network location service, which needs an API key and does not answer on
   * macOS, so a request would hang until the page's timeout. Refused, it fails
   * at once and an app can offer a place search instead. Every other
   * permission keeps Electron's answer.
   */
  electronSession.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission !== 'geolocation')
  })
  // Settings' member list reads the same cache as an app and the agent.
  const members = createMembersCache((remote) => session.api.collaborators(remote))
  /**
   * The clone the caller's vault lives in.
   *
   * Resolved from the **caller's remote**, not from `host.active()`: an
   * agent session outlives a vault switch, and a `git commit` in one clone fires
   * that clone's hook whatever Holi is showing. Resolving by what is on screen
   * would run the pre-commit transforms against the wrong repository.
   *
   * The registry is the source, so a vault that is not currently open still
   * resolves: its clone is on disk either way, and its git hook can fire.
   */
  const rootFor = async (remote: string): Promise<string | null> => {
    const active = host.active()
    if (active?.remote === remote) return active.root
    return (await registry.list()).find((e) => e.remote === remote)?.path ?? null
  }

  // What a vault app and the agent can ask for: core's capabilities, then
  // each feature's, under the namespaces each owns. A feature's table closes
  // over what it needs from the running app.
  const vaultCaps = vaultCapabilities({
    // `holi skills update` and the palette's Update skills: bring this
    // release's skills and hooks to a vault. A conflict is answered with the
    // first turn of a session that would resolve it, which the renderer
    // starts through the agent service.
    pendingSkills: async (remote) => {
      const root = await rootFor(remote)
      if (root === null) throw new CapabilityError('UNAVAILABLE', 'No vault is open.')
      return pendingShipped(root, await plugins.contributions(root))
    },
    updateSkills: async (remote) => {
      const root = await rootFor(remote)
      if (root === null) throw new CapabilityError('UNAVAILABLE', 'No vault is open.')
      const report = await updateShipped(root, await plugins.contributions(root))
      return {
        summary: describeUpdate(report, false),
        conflicts:
          report.conflicts.length === 0
            ? null
            : {
                prompt: await updateConflictPrompt(root, report.conflicts),
                summary: describeUpdate(report, true),
              },
      }
    },
  })
  const taskCaps = taskCapabilities({ today: localToday })
  capabilities.register(VAULT_NAMESPACES, vaultCaps)
  capabilities.register(TASK_NAMESPACES, taskCaps)
  // The one way every door runs a capability: the renderer's UI door (the
  // router) and the agent's `holi` CLI (the bridge server, below).
  const capabilityHost = createCapabilityHost({
    registry: capabilities,
    rootFor,
    active: () => host.active(),
    core: createCoreServices({ active: () => host.active(), members, reports: uiReports }),
    pluginEnabled: async (plugin, root) => (await plugins.enabled(root)).has(plugin),
    claims: (root) => plugins.scanClaimsFor(root),
  })
  const dispatch = capabilityHost.dispatch

  // The vault's own `.pre-commit-config.yaml`: who allowed it, and its runs.
  const preCommit = createVaultPreCommit({ file: join(userDataDir, 'pre-commit-allowed.json') })

  // Updating Holi itself. Installing is a quit, so it runs the quit's confirm
  // and teardown first and then lets the updater's own quit through.
  const updater: Updater = createUpdater({
    send: (status) => send('updates:status', status),
    beforeInstall: async () => {
      if (quitting || confirmingQuit) return false
      confirmingQuit = true
      const go = await confirmQuit().catch(() => true)
      confirmingQuit = false
      if (!go) return false
      quitting = true
      await teardown()
      return true
    },
  })

  const router = createRouter({
    updates: updater,
    loginItem: {
      get: () => app.getLoginItemSettings().openAtLogin,
      set: (open) => app.setLoginItemSettings({ openAtLogin: open }),
    },
    capabilities: capabilityHost,
    preCommit,
    seed: (root) => plugins.seed(root),
    plugins,
    members,
    reportUi: (remote, report) => {
      uiReports.set(remote, report)
      plugins.report(remote, report)
    },
    registry,
    session,
    host,
    vaultRoot: vaultRoot(),
    openExternal: async (url) => {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    },
    trashItem: async (path) => {
      const { shell } = await import('electron')
      await shell.trashItem(path)
    },
  })

  registerIpc({ router, rootFor: (remote) => rootFor(remote) })

  const holiCliPath = await installHoliCli(app.getPath('userData'))

  // The bridge: what runs inside a vault (the `holi` command, the agent's
  // hooks, git's hook and merge driver) reaching this Holi on loopback.
  const bridge = createBridgeServer({
    cli: { dispatch, commands: () => capabilities.commands() },
  })
  registerGitRoutes(bridge, {
    rootFor,
    claims: (root) => plugins.scanClaimsFor(root),
    transforms: (root) => plugins.transformsFor(root),
    preCommit,
  })
  await bridge.start()
  const binDir = dirname(holiCliPath)

  /**
   * Reminders: a tray-resident evaluator sweeps every registered vault each
   * minute (and once at launch, the catch-up for fires missed while quit) and
   * raises native notifications.
   *
   * `clonePaths` is refreshed at the head of every `corpus.all()`, before `sweep`
   * reads or the runtime marks the watermark, so the sync `DeliveredLog` resolver
   * always sees the same clones the sweep just scanned. A vault whose `scanVault`
   * throws (a stale registry entry, a missing clone) is skipped, never a stall.
   */
  const clonePaths = new Map<string, string>()
  const corpus = {
    async all(): Promise<VaultTasks[]> {
      const entries = await registry.list()
      clonePaths.clear()
      for (const e of entries) clonePaths.set(e.remote, e.path)
      const scans = await Promise.all(
        entries.map(async (e) => {
          const snap = await plugins
            .scanClaimsFor(e.path)
            .then((claims) => scanVault(e.path, claims))
            .catch(() => null)
          return snap ? { remote: e.remote, tasks: snapshotTasks(snap).items } : null
        }),
      )
      return scans.filter((v): v is VaultTasks => v !== null)
    },
  }
  const delivered = createDeliveredLog((remote) => clonePaths.get(remote) ?? null)
  /**
   * A clicked reminder brings the window forward and hands the task to the
   * renderer, which owns the vault switch (so `activeRemoteAtom` stays truthful).
   * The window may be gone entirely (tray-resident), so recreate it and
   * deliver on `did-finish-load`, or the push arrives before any renderer can
   * hear it.
   */
  const focusTask = (remote: string, path: string): void => {
    const payload = { remote, path }
    const win = mainWindow
    if (win === null || win.isDestroyed()) {
      const fresh = createWindow()
      fresh.on('focus', () => host.active()?.onFocus())
      fresh.webContents.once('did-finish-load', () =>
        fresh.webContents.send('reminders:open', payload),
      )
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('reminders:open', payload)
  }
  const notifier = createNotifier((remote, path) => focusTask(remote, path))
  const reminders = createReminderRuntime({ corpus, notifier, delivered })
  reminders.start()

  // Opened at login, Holi starts in the menu bar: the window loads (so the
  // vault opens) without showing.
  const atLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
  const win = createWindow({ show: !atLogin })
  // Pull on focus. The interval exists for the case where the window never
  // loses focus at all.
  win.on('focus', () => host.active()?.onFocus())

  // Create-or-focus the one window: the dock/`activate` path and the tray's
  // Open Holi both funnel through here.
  const openWindow = (): void => {
    const existing = mainWindow
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const fresh = createWindow()
    fresh.on('focus', () => host.active()?.onFocus())
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  // Tray-resident: the sweep keeps running with the window closed, and the tray
  // is the way back in (Open Holi) and the way out (Quit, since ⌘W is not).
  tray = createTray({ openWindow })
  // After the first window: the Developer menu sends to whatever window is
  // current, and there has to be one for the send to land.
  installAppMenu(() => mainWindow)

  /**
   * First-run only: ask once whether to launch Holi at login, since reminders
   * fire only while it is running. The "asked" flag lives in userData (never a
   * vault), so a later launch never re-asks. Fire-and-forget so the modal does
   * not hold up startup.
   */
  const appSettingsFile = join(app.getPath('userData'), 'settings.json')
  void (async () => {
    let settings: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(appSettingsFile, 'utf8'))
      if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>
    } catch {
      settings = {}
    }
    if (settings['launchPrompted'] === true) return
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Enable', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Launch Holi at login?',
      detail: 'Reminders only fire while Holi is running. Launch it automatically when you log in?',
    })
    app.setLoginItemSettings({ openAtLogin: response === 0 })
    try {
      await writeFile(
        appSettingsFile,
        JSON.stringify({ ...settings, launchPrompted: true }, null, 2) + '\n',
        'utf8',
      )
    } catch (err) {
      console.error('[login-prompt] failed to persist the asked flag:', err)
    }
  })()

  /**
   * Quit has to WAIT for the flush.
   *
   * `before-quit` is synchronous: fire the teardown unawaited and the app can
   * exit before it finishes, losing the edit the commit debounce was holding.
   * So veto the first quit, flush, then quit for real. `quitting` makes the
   * second pass fall through, or this vetoes forever.
   */
  let quitting = false
  /** A quit confirm is on screen: a second ⌘Q must not stack another. */
  let confirmingQuit = false
  /**
   * What the plugins' quit guards ask, asked at the start, before anything
   * is torn down. Several questions are put as one.
   */
  async function confirmQuit(): Promise<boolean> {
    const questions = plugins.quitQuestions()
    if (questions.length === 0) return true
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: questions.map((q) => q.message).join(' '),
      detail: questions.map((q) => q.detail).join('\n\n'),
    }
    const { response } =
      mainWindow === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(mainWindow, options)
    return response === 0
  }
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    if (confirmingQuit) return
    confirmingQuit = true
    void confirmQuit()
      .catch(() => true)
      .then((go) => {
        confirmingQuit = false
        if (!go) return
        quitting = true
        void teardownAndQuit()
      })
  })

  async function teardownAndQuit(): Promise<void> {
    await teardown()
    // Always quit, even if the flush threw: a failed teardown must not trap
    // someone in an app they are trying to leave.
    app.quit()
  }

  /** Everything a quit does before the process goes: by ⌘Q, the tray, or an
   *  update's restart. Never throws. */
  async function teardown(): Promise<void> {
    updater.dispose()
    reminders.close() // stop the sweep timer at once: no tick into a teardown
    tray?.destroy() // let go of the menu-bar item as we leave
    tray = null
    await (async () => {
      try {
        // Dispose what runs in the vault (the agent's sessions and terminals)
        // before we flush and commit: nothing a session was mid-writing
        // should race the teardown.
        await plugins.leave().catch((err) => console.error('[quit] plugins leave failed:', err))
        await bridge.stop().catch((err) => console.error('[quit] bridge stop failed:', err))
        await plugins.disposeAll().catch((err) => console.error('[quit] plugins stop failed:', err))
        // A flush point is a flush THEN a commit, and only the renderer can do
        // the first half: the editor's newest words are not on disk until it
        // writes them. Quit is the one flush point main starts, so it asks.
        await requestFlush(flushChannel(mainWindow))
        // Quit is a leave point: commit the flushed buffer, then get it
        // off-machine before the window closes. Best-effort with a 1s budget:
        // an unreachable remote must not hang quit, and the next launch drains
        // what did not make it out. Order is flush -> commit -> push -> close.
        const vault = host.active()
        if (vault !== null) {
          await vault.commitNow().catch((err) => console.error('[quit] commit failed:', err))
          await Promise.race([vault.pushNow(), new Promise((r) => setTimeout(r, 1_000))])
        }
        // `close()` commits the open vault again (a clean no-op) before letting
        // go of it.
        await host.close()
      } catch (err) {
        console.error('[quit] teardown failed:', err)
      }
    })()
  }
}

/**
 * `requestFlush`'s channel, over the one window.
 *
 * A window that is gone or destroyed has no buffer left to lose, so it answers
 * at once rather than making the quit sit out the full timeout for a renderer
 * that cannot possibly reply.
 */
function flushChannel(win: BrowserWindow | null): FlushChannel {
  const target = win !== null && !win.isDestroyed() ? win : null
  return {
    send() {
      target?.webContents.send('vault:flush')
    },
    onDone(cb) {
      if (target === null) {
        queueMicrotask(cb)
        return () => {}
      }
      ipcMain.once('vault:flush-done', cb)
      return () => ipcMain.removeListener('vault:flush-done', cb)
    },
  }
}

// Keep-alive on every platform: closing the last window does not quit, so the
// reminder sweep keeps running tray-resident. A real quit is the tray's Quit or
// ⌘Q → `before-quit`. The handler must stay registered and empty: with none,
// Electron's default quits on Windows/Linux.
app.on('window-all-closed', () => {
  // intentionally does not quit
})
