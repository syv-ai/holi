// Rasterises src/main/tray-icon-{18,36}.png from build/icon.svg: the tile alone
// (no drop shadow, cropped to the squircle), 16 pt centred in an 18 pt canvas.
// Run from apps/desktop: `pnpm exec electron scripts/tray-icon.mjs`
import { readFileSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'

const svg = readFileSync('build/icon.svg', 'utf8')
  .replace(' filter="url(#shadow)"', '')
  .replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"')
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<body></body>')
  for (const size of [18, 36]) {
    const url = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = c.height = ${size}
        const pad = ${size / 18}
        c.getContext('2d').drawImage(img, pad, pad, ${size} - 2 * pad, ${size} - 2 * pad)
        resolve(c.toDataURL('image/png'))
      }
      img.src = ${JSON.stringify(src)}
    })`)
    writeFileSync(`src/main/tray-icon-${size}.png`, Buffer.from(url.split(',')[1], 'base64'))
  }
  app.quit()
})
