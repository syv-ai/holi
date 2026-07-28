/**
 * The app: one window, one signed-in GitHub session, one open vault.
 *
 * Read the order in `whenReady` as a dependency chain — the session must exist
 * before the host, because the host hands git a closure over its token; the
 * host must exist before the router, because half the router is about the open
 * vault; and the window must exist before anything pushes to it.
 *
 * **Nothing here may import a module that no longer exists.** `electron-vite`
 * resolves imports even though it does not typecheck, so an unresolvable import
 * anywhere on this path is the one thing that stops a window opening at all.
 *
 * The agent is wired here: `createAgentManager` over the vault `host`, its
 * `agent-pty:*`/`agent:*` seam registered alongside the tRPC one. It sits after
 * the router because it shares the host, and before the window because its
 * `getWindow` closure reads `mainWindow` lazily.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, protocol, type Tray } from 'electron'
import { requestFlush, type FlushChannel } from './flush'
import { assetAbsPath, mimeFor } from './vault/asset-protocol'
import { createSession } from './github/electron'
import { registerIpc } from './ipc'
import { createRouter } from './router'
import { createVaultHost } from './vault/active-vault'
import { VaultRegistry, vaultRoot } from './vault/registry'
import { scanVault } from './vault/vault-store'
import { createDeliveredLog, createReminderRuntime } from './reminders/runtime'
import { createNotifier } from './reminders/notify'
import type { VaultTasks } from './reminders/sweep'
import { createTray } from './tray'
import { createAgentManager, type AgentManager } from './agent/agent-manager'
import { createHookServer } from './agent/hook-server'
import { ensureTypst, resolveTypstBin } from './pdf/typst-bin'
import { registerAgentIpc } from './agent-ipc'

// Declared before the launch check below, which starts `main()` synchronously:
// a `let` referenced from inside it while still in its temporal dead zone would
// throw during startup, which is the worst possible place for one.
let mainWindow: BrowserWindow | null = null

// Held at module scope, not inside `main()`: a `Tray` that gets garbage-collected
// vanishes from the menu bar, so it must outlive the setup closure.
let tray: Tray | null = null

/**
 * A second launch must not happen at all.
 *
 * `prd/vaults-sync.md` names the hazard as "the app opened twice would race on
 * commits" and asks for a lock on the clone — but one Holi process owns every
 * vault, so excluding a second *app* is exactly excluding a second writer on
 * every clone, and it covers vaults that are not even open, which a per-clone
 * lock could not. A lockfile would also need stale-lock handling, and getting
 * that wrong locks someone out of their own vault after a single crash.
 *
 * Must be claimed BEFORE `whenReady`.
 */
// Privileged custom scheme for vault binary assets (images). `standard` so URLs
// parse with a host + path; `secure`/`supportFetchAPI`/`stream` so <img> and
// fetch treat it like https and can stream large files. Must be declared before
// app-ready, so it lives at module top level, not in main().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'holi-vault',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

async function main(): Promise<void> {
  app.on('second-instance', () => {
    // Someone tried to launch Holi again — show them the one they have.
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  await app.whenReady()

  // After whenReady: the keychain is not available before it.
  const session = await createSession()
  const registry = new VaultRegistry(join(app.getPath('userData'), 'vaults.json'))

  const send = (channel: string, payload: unknown) =>
    mainWindow?.webContents.send(channel, payload)

  const host = createVaultHost({
    registry,
    // A GETTER, not a string. Read lazily on every git operation, so a sign-out
    // takes effect on the next pull rather than the next restart.
    gitDeps: { token: () => session.token() },
    onSnapshot: (snapshot) => send('vault:snapshot', snapshot),
    onSyncState: (state) => send('vault:sync', state),
  })

  // Serve `holi-vault://vault/<vaultRelPath>` from the active vault, read-only.
  // Resolving against the active vault (not a remote in the URL) is safe: there
  // is exactly one ActiveVault and a vault switch resets the workspace, so the
  // open note is always in the active vault.
  protocol.handle('holi-vault', async (request) => {
    const vault = host.active()
    if (vault === null) return new Response(null, { status: 404 })
    const abs = assetAbsPath(vault.root, request.url)
    if (abs === null) return new Response(null, { status: 403 })
    try {
      const bytes = await readFile(abs)
      return new Response(bytes, { headers: { 'content-type': mimeFor(abs) } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  // Shared by the UI's Convert-to-PDF router and the agent's $TYPST_BIN.
  const typstCacheDir = join(app.getPath('userData'), 'typst')

  const router = createRouter({
    registry,
    session,
    host,
    vaultRoot: vaultRoot(),
    openExternal: async (url) => {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    },
    downloadsDir: app.getPath('downloads'),
    typstCacheDir,
  })

  registerIpc({ router })

  // The vault agent: one live `claude` per user, in the active vault's clone.
  // `getWindow` is lazy — the window is created just below and is up long before
  // the agent streams anything, so registering the seam here is safe.
  //
  // Git coexistence: the hook server learns turn start/end from the agent's own
  // Claude Code hooks and drives the manager's pause/resume. The forward ref is
  // safe — its callbacks fire only at runtime, long after `agent` is assigned.
  let agent: AgentManager
  const hookServer = createHookServer({
    onTurnStart: () => agent.setTurnActive(true),
    onTurnEnd: () => agent.setTurnActive(false),
  })
  await hookServer.start()
  agent = createAgentManager({
    host,
    getWindow: () => mainWindow,
    hookPort: () => hookServer.port(),
    hookToken: () => hookServer.token(),
    // $TYPST_BIN for the md-to-pdf skill: find-only for the env, download-warm
    // fire-and-forget so a machine that never rendered has typst next time.
    resolveTypstBin: () => resolveTypstBin({ cacheDir: typstCacheDir }),
    warmTypst: () => {
      void ensureTypst({ cacheDir: typstCacheDir })
    },
  })
  registerAgentIpc({ agent })

  /**
   * Reminders: a tray-resident evaluator sweeps every registered vault each
   * minute (and once at launch — the launch run is the catch-up for fires missed
   * while quit) and raises native notifications.
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
          const snap = await scanVault(e.path).catch(() => null)
          return snap ? { remote: e.remote, tasks: snap.tasks } : null
        }),
      )
      return scans.filter((v): v is VaultTasks => v !== null)
    },
  }
  const delivered = createDeliveredLog((remote) => clonePaths.get(remote) ?? null)
  /**
   * A clicked reminder brings the window forward and hands the task to the
   * renderer, which owns the vault switch (so `activeRemoteAtom` stays truthful).
   * The window may be gone entirely — closed on macOS, or tray-resident once
   * keep-alive lands — so recreate it and deliver on `did-finish-load`, or the
   * push arrives before any renderer can hear it.
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

  const win = createWindow()
  // FR-9: pull on focus. The interval exists for the case where the window
  // never loses focus at all.
  win.on('focus', () => host.active()?.onFocus())

  // Create-or-focus the one window — the dock/`activate` path and the tray's
  // Open Holi both funnel through here, so keep-alive has a single way back in.
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
  // is the way back in (Open Holi) and the way out (Quit — ⌘W no longer is one).
  tray = createTray({ openWindow })

  /**
   * First-run only: ask once whether to launch Holi at login — reminders fire
   * only while it is running. The answer is applied via `setLoginItemSettings`;
   * the "asked" flag lives in userData (never a vault, never committed), so a
   * later launch never re-asks, whatever the answer was. Fire-and-forget so the
   * modal does not hold up the rest of startup. (A settings toggle to change the
   * choice later is out of scope — a follow-up.)
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
   * exit before it finishes, losing whatever the commit debounce was still
   * holding — which is precisely the edit the user just made. So veto the first
   * quit, flush, then quit for real. `quitting` makes the second pass fall
   * through, or this vetoes forever.
   */
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    reminders.close() // stop the sweep timer at once — no tick into a teardown
    tray?.destroy() // let go of the menu-bar item as we leave
    tray = null
    void (async () => {
      try {
        // Kill the agent's PTY (and its process group) before we flush and
        // commit — nothing the session was mid-writing should race the teardown.
        await agent.dispose().catch((err) => console.error('[quit] agent dispose failed:', err))
        await hookServer.stop().catch((err) => console.error('[quit] hook server stop failed:', err))
        // FR-6's flush points are a flush THEN a commit, and only the renderer
        // can do the first half — `host.close()` commits what is on disk, and
        // the editor's newest words are not there until it writes them. Every
        // other flush point is renderer-initiated; quit is the one main starts,
        // so it is the one that has to ask.
        await requestFlush(flushChannel(mainWindow))
        // Quit is a leave point (D61): commit the flushed buffer, then get it
        // off-machine before the window closes. Best-effort with a 1s budget —
        // `pushNow` never rejects, and an unreachable remote must not hang quit;
        // the work is committed on disk, and the next launch drains what did not
        // make it out. Order is flush -> commit -> push -> close.
        const vault = host.active()
        if (vault !== null) {
          await vault.commitNow().catch((err) => console.error('[quit] commit failed:', err))
          await Promise.race([vault.pushNow(), new Promise((r) => setTimeout(r, 1_000))])
        }
        // `close()` commits the open vault again (a clean no-op) before letting
        // go of it (FR-6).
        await host.close()
      } catch (err) {
        console.error('[quit] teardown failed:', err)
      } finally {
        // Always quit, even if the flush threw — a failed teardown must not
        // trap someone in an app they are trying to leave.
        app.quit()
      }
    })()
  })
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

// Keep-alive on every platform: closing the last window no longer quits, so the
// reminder sweep keeps running tray-resident (macOS already behaved this way).
// A real quit is the tray's Quit or ⌘Q → `before-quit`. The handler must stay
// registered and empty — with none, Electron's default quits on Windows/Linux.
app.on('window-all-closed', () => {
  // intentionally does not quit
})
