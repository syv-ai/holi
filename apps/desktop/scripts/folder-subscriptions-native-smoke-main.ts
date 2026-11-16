import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
app.setPath('userData', process.env.HOLI_564_PROFILE!)
app.setPath('sessionData', join(process.env.HOLI_564_PROFILE!, 'sessionData'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 720,
    height: 820,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  await win.loadURL(process.env.HOLI_564_URL!)
})
