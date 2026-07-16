import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createAgentManager } from './agent/agent-manager'
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
    // The board is fed from the SSE stream main already owns — one connection per
    // vault. The renderer never opens a second one.
    send,
    onReminders: (event) => reminderNotifier.raise(event),
  })
  const agentManager = createAgentManager({
    client,
    vaultManager,
    getWindow: () => mainWindow,
  })
  vaultManager.setObserver(agentManager.observer)
  registerIpc({ store, vaultManager, agentManager })
  app.on('before-quit', () => {
    void agentManager.dispose().then(() => vaultManager.deactivate())
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
