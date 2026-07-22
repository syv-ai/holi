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
 * That is why the agent is not wired up: `agent/agent-manager.ts` still imports
 * the deleted `server-client`, and the drawer is plan 5's work.
 */
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { requestFlush, type FlushChannel } from './flush'
import { createSession } from './github/electron'
import { registerIpc } from './ipc'
import { createRouter } from './router'
import { createVaultHost } from './vault/active-vault'
import { VaultRegistry, vaultRoot } from './vault/registry'

// Declared before the launch check below, which starts `main()` synchronously:
// a `let` referenced from inside it while still in its temporal dead zone would
// throw during startup, which is the worst possible place for one.
let mainWindow: BrowserWindow | null = null

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

  const router = createRouter({
    registry,
    session,
    host,
    vaultRoot: vaultRoot(),
    openExternal: async (url) => {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    },
  })

  registerIpc({ router })

  const win = createWindow()
  // FR-9: pull on focus. The interval exists for the case where the window
  // never loses focus at all.
  win.on('focus', () => host.active()?.onFocus())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow()
      next.on('focus', () => host.active()?.onFocus())
    }
  })

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
    void (async () => {
      try {
        // FR-6's flush points are a flush THEN a commit, and only the renderer
        // can do the first half — `host.close()` commits what is on disk, and
        // the editor's newest words are not there until it writes them. Every
        // other flush point is renderer-initiated; quit is the one main starts,
        // so it is the one that has to ask.
        await requestFlush(flushChannel(mainWindow))
        // `close()` commits the open vault before letting go of it (FR-6).
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
