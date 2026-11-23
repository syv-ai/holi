import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { showNotification } from '../src/main/notifications'

const result = process.env.HOLI_NOTIFICATION_RESULT!
const title = process.env.HOLI_NOTIFICATION_TITLE!
const report = (value: string) => writeFileSync(result, value)
app.setName('Holi notification readiness')
app.setPath('userData', process.env.HOLI_NOTIFICATION_USER_DATA!)
app.setPath('sessionData', process.env.HOLI_NOTIFICATION_SESSION_DATA!)
void app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 520, height: 220, show: true, title: `READY ${title}` })
  window.loadURL(`data:text/html,<h1>${encodeURIComponent(`READY ${title}`)}</h1>`)
  window.on('focus', () => report('clicked-and-window-activated'))
  showNotification({
    title,
    body: 'Holi native notification readiness probe',
    onClick: () => {
      report('notification-click-callback')
      window.show()
      window.focus()
    },
  })
  report('shown')
})
app.on('window-all-closed', () => app.quit())
