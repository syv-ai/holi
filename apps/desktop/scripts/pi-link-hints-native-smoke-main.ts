import { app, BrowserWindow, ipcMain, session } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const root = process.env.HOLI_805_ROOT!
const bridge = process.env.HOLI_805_BRIDGE!
const token = process.env.HOLI_805_TOKEN!
const evidence = process.env.HOLI_805_EVIDENCE!
const remote = 'native-fixture/pi-links'
const terminalId = 'native-pi-hint-terminal'
app.setName('Holi Pi link acceptance 805')
app.setPath('userData', join(root, 'profile'))
app.setPath('sessionData', join(root, 'session'))
let window: BrowserWindow
let stopped = false
let offset = 0
let mirror = ''
const decoder = new StringDecoder('utf8')
const writes: string[] = []
const opened: string[] = []
const operations: string[] = []
async function request(path: string, data?: unknown) {
  const response = await fetch(bridge + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  if (!response.ok) throw new Error(`fixture bridge ${path}: ${response.status}`)
  return response.json()
}
async function relay() {
  while (!stopped && !window.isDestroyed()) {
    const packet = await request(`/output?offset=${offset}`)
    const bytes = Buffer.from(packet.data, 'base64')
    offset = packet.offset
    const data = decoder.write(bytes)
    if (data) {
      mirror += data
      window.webContents.send('plugin:agent', {
        remote,
        name: 'pty-data',
        payload: { id: terminalId, data },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
function checkSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('unowned fixture sender')
}
ipcMain.on('plugin:agent', (event, value) => {
  checkSender(event)
  if (value.remote !== remote || value.payload?.id !== terminalId) return
  if (value.name === 'pty-write') {
    writes.push(value.payload.data)
    void request('/input', { data: value.payload.data }).catch((error) => {
      console.error(error)
      app.exit(1)
    })
  } else if (value.name === 'pty-resize') {
    void request('/geometry', { cols: value.payload.cols, rows: value.payload.rows })
  }
})
ipcMain.handle('holi:trpc', (event, operation) => {
  checkSender(event)
  if (operation.path === 'fixture.proof')
    return { ok: true, data: { offset, writes, opened, operations } }
  if (operation.path === 'fixture.quit') {
    stopped = true
    setTimeout(() => app.quit(), 100)
    return { ok: true, data: null }
  }
  if (operation.path !== 'cap.run' || operation.input?.remote !== remote)
    return { ok: false, message: 'unowned fixture capability' }
  const name = operation.input.name
  operations.push(name)
  const params = JSON.parse(operation.input.paramsJson ?? '{}')
  if ((name === 'agent.attach' || name === 'agent.detach') && params.id !== terminalId)
    return { ok: false, message: 'unowned terminal' }
  if (name === 'agent.open' && params.attach !== 'native-pi-hint-session')
    return { ok: false, message: 'unowned session' }
  switch (name) {
    case 'agent.attach':
      return { ok: true, data: mirror }
    case 'agent.open':
      return { ok: true, data: { ok: true, terminalId } }
    // The native fixture owns this session's PTY; closing its UI window does not stop it.
    case 'agent.detach':
      return { ok: true, data: null }
    case 'agent.turns':
      return { ok: true, data: [] }
    default:
      return { ok: false, message: `unsupported fixture capability ${name}` }
  }
})
ipcMain.handle('holi:openExternal', (event, url) => {
  checkSender(event)
  if (url !== 'https://example.invalid/fixture') throw new Error('unexpected native link')
  opened.push(url)
  writeFileSync(join(evidence, 'opened-links.json'), JSON.stringify(opened))
})
ipcMain.handle('window:is-visible', () => true)
app.on('window-all-closed', () => app.quit())
app
  .whenReady()
  .then(async () => {
    const ses = session.defaultSession
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    )
    ses.on('will-download', (_event, item) => item.cancel())
    window = new BrowserWindow({
      width: 980,
      height: 680,
      show: true,
      webPreferences: {
        preload: join(root, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    window.webContents.on('console-message', (_event, level, message) =>
      console.log(`renderer[${level}] ${message}`),
    )
    await window.loadFile(join(root, 'renderer/index.html'))
    void relay().catch((error) => {
      console.error(error)
      app.exit(1)
    })
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
