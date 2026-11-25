import { app, BrowserWindow, Notification } from 'electron'
import { existsSync, mkdirSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { showNotification } from '../src/main/notifications'

const result = process.env.HOLI_NOTIFICATION_RESULT!
const settingsResult = `${result}.settings`
const nativeRequire = createRequire(__filename)
const settingsAddon = nativeRequire(
  join(process.resourcesPath, 'app/notification-settings.node'),
) as {
  readSettings(): Promise<string>
}
const title = process.env.HOLI_NOTIFICATION_TITLE!
const report = (value: string) => writeFileSync(result, value)
const nativeShow = Notification.prototype.show
Notification.prototype.show = function () {
  if (this.title === title) {
    this.once('failed', (_event, error) => report(`native-failed: ${error}`))
    this.once('show', () => {
      report('shown-native')
      void settingsAddon.readSettings().then(
        (settings) => writeFileSync(settingsResult, settings),
        (error) => writeFileSync(settingsResult, JSON.stringify({ error: String(error) })),
      )
    })
  }
  return nativeShow.call(this)
}
app.setName(process.env.HOLI_NOTIFICATION_APP_NAME!)
const userData = process.env.HOLI_NOTIFICATION_USER_DATA!
const sessionData = process.env.HOLI_NOTIFICATION_SESSION_DATA!
const appData = dirname(userData)
for (const directory of [appData, userData, sessionData])
  mkdirSync(directory, { recursive: true, mode: 0o700 })
app.setPath('appData', appData)
app.setPath('userData', userData)
app.setPath('sessionData', sessionData)
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 520,
    height: 220,
    show: true,
    title: `READY ${title}`,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><h1>READY ${title}</h1>`)}`,
  )
  writeFileSync(
    `${result}.paths`,
    JSON.stringify({
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    }),
  )
  let clicked = false
  window.on('focus', () => {
    if (clicked) report('clicked-and-window-activated')
  })
  const sendSignal = `${result}.send`
  watchFile(sendSignal, { interval: 100 }, () => {
    if (!existsSync(sendSignal)) return
    unwatchFile(sendSignal)
    window.hide()
    report('notification-requested')
    showNotification({
      title,
      body: 'Holi native notification readiness probe',
      onClick: () => {
        clicked = true
        window.show()
        window.focus()
        if (window.isFocused()) report('clicked-and-window-activated')
      },
    })
  })
  app.once('before-quit', () => unwatchFile(sendSignal))
  if (!Notification.isSupported()) throw new Error('Native notifications unsupported')
  report('permission-requested')
})
app.on('window-all-closed', () => app.quit())
