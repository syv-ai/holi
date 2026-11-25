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
ipcMain.handle('rich-text-vim:read', (_event, path: string) => notes.get(path) ?? '')
ipcMain.handle('rich-text-vim:write', (_event, path: string, text: string) => {
  if (!notes.has(path)) throw new Error('Unknown fixture note')
  notes.set(path, text)
  return { ok: true }
})
ipcMain.handle('rich-text-vim:comments', (_event, operation: string, _text?: string, _path?: string) =>
  operation === 'list' || operation === 'read' ? comments : { ok: true },
)
ipcMain.handle('rich-text-vim:fixture', (_event, operation: string) =>
  operation === 'state' ? { ready: true, mode } : { ok: true },
)

await app.whenReady()
const ses = session.defaultSession
ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
const options = {
  width: 1200,
  height: 800,
  titleBarStyle: 'hiddenInset' as const,
  trafficLightPosition: { x: 14, y: 12 },
  transparent: mode === 'native' && wantsLiquidGlass(),
  backgroundColor: mode === 'opaque' ? '#f8f8f8' : undefined,
  webPreferences: {
    preload: join(root, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
  },
}
const window = new BrowserWindow(options)
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
window.webContents.on('will-navigate', (event) => event.preventDefault())
if (mode === 'native') {
  const glass = require('electron-liquid-glass')
  if (!glass || typeof glass.addView !== 'function') throw new Error('Liquid glass module unavailable')
  const addView = glass.addView.bind(glass)
  glass.addView = (...args: unknown[]) => {
    const id = addView(...args)
    console.log(JSON.stringify({ event: 'glass-view', id }))
    return id
  }
  await applyLiquidGlass(window)
}
await window.loadFile(join(root, 'renderer', 'index.html'))
console.log(JSON.stringify({ event: 'ready', pid: process.pid, mode }))
