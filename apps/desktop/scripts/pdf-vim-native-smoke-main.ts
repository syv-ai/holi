import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const root = process.env.HOLI_PDF_SMOKE_ROOT!
const evidence = process.env.HOLI_PDF_SMOKE_EVIDENCE!
const windows = new Set<BrowserWindow>()

async function run() {
  app.setPath('userData', join(root, 'userData'))
  app.setPath('sessionData', join(root, 'sessionData'))
  await app.whenReady()
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  )
  const window = new BrowserWindow({
    width: 1120,
    height: 820,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  windows.add(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })
  window.webContents.on('console-message', (_event, level, message) =>
    console.log(`renderer[${level}] ${message}`),
  )
  window.webContents.on('render-process-gone', (_event, details) => {
    writeFileSync(join(evidence, 'renderer-gone.json'), JSON.stringify(details))
  })
  window.on('closed', () => windows.delete(window))
  await window.loadFile(join(root, 'renderer', 'scripts', 'pdf-vim-native-smoke.html'))
  window.show()
}

app.on('before-quit', () => {
  for (const window of windows) window.destroy()
})
void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
