import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createAgentManager } from './agent/agent-manager'
import { createUserStream } from './events/user-stream'
import { registerIpc } from './ipc'
import { createReminderNotifier } from './reminders/notifier'
import { createServerClient, type ServerClient } from './server-client'
import { electronSessionStore, type SessionStore } from './session'
import { createVaultManager } from './vault/vault-manager'

let mainWindow: BrowserWindow | null = null

/**
 * Dev-only: land on a vault instead of the empty sign-in screen. If there's no
 * cached session, mint one from the server's `auth.devSession` bootstrap and
 * save it, so the renderer's first `auth.get` is already signed in. Bounded
 * retry because the server may still be booting under `pnpm dev`. Never runs in
 * a packaged build; a failure just falls back to the manual dev-token field.
 */
async function maybeDevSignIn(store: SessionStore, client: ServerClient): Promise<void> {
  if (app.isPackaged || store.load()) return
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const { token, user } = await client.auth.devSession.mutate()
      store.save({
        token,
        userId: user.id,
        email: user.email,
        name: user.name,
        cachedAt: new Date().toISOString(),
      })
      console.log(`[dev] auto-signed in as ${user.email}`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 800)) // server still coming up
    }
  }
  console.warn('[dev] auto sign-in failed (server unreachable) — use the dev-token field')
}

function createWindow(): void {
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
}

app.whenReady().then(async () => {
  const store = electronSessionStore()
  const client = createServerClient(() => store.load()?.token ?? null)
  await maybeDevSignIn(store, client)
  const send = (channel: string, payload: unknown) =>
    mainWindow?.webContents.send(channel, payload)
  const reminderNotifier = createReminderNotifier({ getWindow: () => mainWindow, send })
  const vaultManager = createVaultManager({
    store,
    // The board and the tree are fed from the one SSE stream main owns — one connection
    // per signed-in user (D50). The renderer never opens its own.
    send,
    onReminders: (vaultId, event) => reminderNotifier.raise(vaultId, event),
  })
  const userStream = createUserStream({
    getToken: () => store.load()?.token ?? null,
    client,
    onEnvelope: (channel, vaultId, event) => vaultManager.handleEnvelope(channel, vaultId, event),
    onReconnect: () => {
      vaultManager.handleReconnect()
      // The renderer's tree and switcher have no reconcile of their own, and there is no
      // resume cursor on the wire — so a gap is the one moment they can silently go
      // stale on exactly the path this slice exists to fix. Refetch both.
      send('stream:resync', {})
    },
  })
  const agentManager = createAgentManager({
    client,
    vaultManager,
    getWindow: () => mainWindow,
  })
  vaultManager.setObserver(agentManager.observer)
  registerIpc({ store, vaultManager, agentManager, userStream, send })
  // A cached session or a dev auto-sign-in means we are already signed in; the other
  // routes in (Google, a pasted dev token) start it from `registerIpc`.
  if (store.load()) userStream.start()
  // Quit has to WAIT for the doc state to hit disk (D59). `before-quit` is synchronous:
  // fire the teardown off unawaited and the app can exit before it finishes, which loses
  // whatever the persist debounce was still holding — i.e. the edit the user just made,
  // the exact thing this exists to keep. So: veto the first quit, flush, then quit for
  // real. `quitting` makes the second pass fall through, or this vetoes forever.
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    userStream.stop()
    void (async () => {
      try {
        await vaultManager.flushPersist()
        await agentManager.dispose()
        await vaultManager.deactivate()
      } catch (err) {
        console.error('[quit] teardown failed:', err)
      } finally {
        // Always quit, even if teardown threw — a failed flush must not trap the app.
        app.quit()
      }
    })()
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
