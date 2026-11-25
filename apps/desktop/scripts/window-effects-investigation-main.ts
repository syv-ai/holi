import { app, BrowserWindow, ipcMain, session } from 'electron'
import { applyLiquidGlass, wantsLiquidGlass } from '../src/main/liquid-glass'
import { join } from 'node:path'

const mode = process.argv.includes('--opaque') ? 'opaque' : 'native'
const root = process.env.HOLI_WINDOW_EFFECTS_ROOT
if (!root) throw new Error('HOLI_WINDOW_EFFECTS_ROOT is required')
app.setPath('userData', join(root, 'userData'))
app.setPath('sessionData', join(root, 'sessionData'))
app.setPath('appData', join(root, 'app-data'))

const notes = new Map([
  ['notes/acceptance.md', '# Acceptance\n\nA local fixture note.\n'],
  ['notes/secondary.md', '# Secondary\n\nA second fixture note.\n'],
])
const comments: unknown[] = []
async function main() {
  ipcMain.handle('rich-text-vim:read', (_event, path: string) => notes.get(path) ?? '')
  ipcMain.handle('rich-text-vim:write', (_event, path: string, text: string) => {
    if (!notes.has(path) || typeof text !== 'string') throw new Error('Unknown fixture note')
    notes.set(path, text)
    return { ok: true }
  })
  ipcMain.handle('rich-text-vim:comments', (_event, operation: string, _text?: string, _path?: string) =>
    operation === 'list' || operation === 'read' ? comments : { ok: true },
  )
  await app.whenReady()
  const ses = session.defaultSession
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    callback({ cancel: url.protocol !== 'file:' })
  })
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  const glassSupported = mode === 'native' && wantsLiquidGlass()
  const win = new BrowserWindow({
    width: 1200, height: 800, titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    transparent: mode === 'native' && glassSupported,
    vibrancy: mode === 'native' && !glassSupported ? 'under-window' : undefined,
    backgroundColor: mode === 'opaque' ? '#f8f8f8' : undefined,
    webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== `file://${join(root, 'renderer', 'index.html')}`) event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript("document.documentElement.style.background='transparent';document.body.style.background='transparent'").catch(() => {})
  })
  if (mode === 'native' && glassSupported) await applyLiquidGlass(win)
  await win.loadFile(join(root, 'renderer', 'index.html'))
  ipcMain.handle('effects:command', async (_event, command: string, value?: unknown) => {
    if (command === 'quit') { app.quit(); return { ok: true } }
    if (command === 'state') return { pid: process.pid, mode, metrics: app.getAppMetrics().map(({pid,type}) => ({pid,type})), focused: win.isFocused(), scaleFactor: win.webContents.getZoomFactor(), bounds: win.getBounds(), editor: await win.webContents.executeJavaScript("({text:document.querySelector('[contenteditable=true]')?.innerText ?? '',ready:!!document.querySelector('[contenteditable=true]')})") }
    if (command === 'activity') { await win.webContents.executeJavaScript('window.scrollBy(0, 400)'); win.setSize(1180, 780); return { ok: true } }
    if (command === 'capture') return { ok: true }
    throw new Error('Unsupported command')
  })
  console.log(JSON.stringify({ event: 'ready', pid: process.pid, mode, glassSupported }))
}
void main().catch((error) => { console.error(error); app.exit(1) })
