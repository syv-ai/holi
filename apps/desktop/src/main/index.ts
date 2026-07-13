import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createAgentManager } from './agent/agent-manager'
import { registerIpc } from './ipc'
import { createServerClient } from './server-client'
import { electronSessionStore } from './session'
import { createVaultManager } from './vault/vault-manager'

let mainWindow: BrowserWindow | null = null

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

app.whenReady().then(() => {
  const store = electronSessionStore()
  const client = createServerClient(() => store.load()?.token ?? null)
  const vaultManager = createVaultManager({ store })
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
