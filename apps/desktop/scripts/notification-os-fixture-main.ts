import { app, BrowserWindow, Notification } from 'electron'
import { writeFileSync } from 'node:fs'
import { showNotification } from '../src/main/notifications'

const result = process.env.HOLI_NOTIFICATION_RESULT!
const title = process.env.HOLI_NOTIFICATION_TITLE!
const report = (value: string) => writeFileSync(result, value)
const nativeShow = Notification.prototype.show
Notification.prototype.show = function () {
  if (this.title === title) {
    this.once('failed', (_event, error) => report(`native-failed: ${error}`))
    this.once('show', () => report('shown-native'))
  }
  return nativeShow.call(this)
}
app.setName('Holi notification readiness')
app.setPath('userData', process.env.HOLI_NOTIFICATION_USER_DATA!)
app.setPath('sessionData', process.env.HOLI_NOTIFICATION_SESSION_DATA!)
void app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 520,
    height: 220,
    show: true,
    title: `READY ${title}`,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  window.loadURL(`data:text/html,<h1>${encodeURIComponent(`READY ${title}`)}</h1>`)
  let clicked = false
  window.on('focus', () => {
    if (clicked) report('clicked-and-window-activated')
  })
  window.hide()
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
  report('shown')
})
app.on('window-all-closed', () => app.quit())
