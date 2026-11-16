import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const root = process.env.HOLI_563_ROOT!
const evidence = process.env.HOLI_563_EVIDENCE!
const windows = new Set<BrowserWindow>()
const blockedRequests: string[] = []

async function run() {
  app.setPath('userData', join(root, 'userData'))
  app.setPath('sessionData', join(root, 'sessionData'))
  app.setPath('appData', join(root, 'appData'))
  await app.whenReady()
  console.log(`HOLI_563_ELECTRON=${process.versions.electron}`)
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      blockedRequests.push(details.url)
      callback({ cancel: true })
    },
  )
  const window = new BrowserWindow({
    width: 1000,
    height: 780,
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
  window.webContents.on('console-message', (_event, level, message) => {
    const zoom = /^HOLI_MAIL_SMOKE_ZOOM:(1(?:\.2)?)$/.exec(message)
    if (zoom) window.webContents.setZoomFactor(Number(zoom[1]))
    console.log(`renderer[${level}] ${message}`)
  })
  window.webContents.on('render-process-gone', (_event, details) =>
    writeFileSync(join(evidence, 'renderer-gone.json'), JSON.stringify(details)),
  )
  window.on('closed', () => windows.delete(window))
  await window.loadFile(join(root, 'renderer', 'index.html'))
  window.show()
}
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  writeFileSync(
    join(evidence, 'blocked-network-requests.json'),
    JSON.stringify(blockedRequests, null, 2),
  )
  for (const window of windows) window.destroy()
})
void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
