import { app, BrowserWindow, ipcMain, session } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMdxCompiler } from '../src/main/mdx-compiler'
import { createMdxDiagnostics } from '../src/main/mdx-diagnostics'

const profile = process.env.HOLI_507_PROFILE!
const vault = process.env.HOLI_507_VAULT!
app.setPath('userData', join(profile, 'userData'))
app.setPath('sessionData', join(profile, 'sessionData'))

const remote = 'fixture/isolated-mdx'
const context = 'fixture-context-507'
let authorized = true
let trusted = false
let accountGeneration = 1
let openRevision = 1
let identity = {
  accountGeneration,
  accountId: 'fixture-account-507',
  remote,
  openRevision,
  active: {},
}
let win: BrowserWindow | null = null
let recoveredWindows = 0
let installedSessionPolicy = false
const blockedRequests: string[] = []
const compiler = createMdxCompiler(join(app.getAppPath(), 'out/mdx-compiler'))
const diagnostics = createMdxDiagnostics({
  authorize: (candidate, requested) => authorized && requested === remote && candidate === identity,
  context: (token, requested) => (token === context && requested === remote ? identity : null),
  root: async (requested) => {
    if (requested !== remote) throw new Error('fixture vault unavailable')
    return vault
  },
  trusted: async (candidate) => candidate === identity && trusted,
  compile: (source, signal) => compiler.compile(source, signal),
})

const invoke = (channel: string, handler: (...args: any[]) => any) => {
  ipcMain.handle(channel, (_event, ...args) => handler(...args))
}
invoke('smoke:status', async () => ({
  userData: app.getPath('userData'),
  sessionData: app.getPath('sessionData'),
  appPath: app.getAppPath(),
  vault,
  recoveredWindows,
  blockedRequests,
  compilerAssets: await Promise.all(
    ['guest.html', 'guest.js'].map(async (name) => {
      const bytes = await readFile(join(app.getAppPath(), 'out/mdx-compiler', name))
      return { name, bytes: bytes.byteLength }
    }),
  ),
}))
invoke('smoke:trust', async (value: boolean) => {
  trusted = value
  if (!trusted) diagnostics.invalidate()
  return { trusted }
})
invoke('smoke:rotate', async () => {
  accountGeneration += 1
  openRevision += 1
  identity = { ...identity, accountGeneration, openRevision, active: {} }
  diagnostics.invalidate()
  return { accountGeneration, openRevision }
})
invoke('smoke:replaceFile', async () => {
  await writeFile(join(vault, 'notes/fixture.mdx'), `# replaced ${Date.now()}\\n`)
  return { ok: true }
})
invoke('mdx:acquire', (input) => diagnostics.acquire(input))
invoke('mdx:cancel', (input) => diagnostics.cancel(input))
invoke('mdx:compile', (input) => diagnostics.compile(input))
invoke('mdx:release', (input) => diagnostics.release(input))

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => {
    if (win?.webContents === contents) {
      win = null
      recoveredWindows += 1
      console.log(`SMOKE_RENDERER_CRASH_RECOVERY:${details.reason}:${recoveredWindows}`)
      setTimeout(() => void createEditorWindow(), 100)
    }
  })
  contents.on('will-navigate', (event, url) => {
    if (
      win &&
      contents.id === win.webContents.id &&
      url === `file://${join(app.getAppPath(), 'renderer/index.html')}`
    )
      return
    event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

async function createEditorWindow() {
  const created = new BrowserWindow({
    width: 1120,
    height: 820,
    show: true,
    webPreferences: {
      preload: join(app.getAppPath(), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  if (!installedSessionPolicy) {
    const defaultSession = session.defaultSession
    defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    defaultSession.setPermissionCheckHandler(() => false)
    defaultSession.on('will-download', (event) => event.preventDefault())
    const rendererAssets = new Set(
      ['renderer/index.html', 'renderer/renderer.js', 'renderer/renderer.css'].map((path) =>
        join(app.getAppPath(), path),
      ),
    )
    defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let localPath = ''
      try {
        localPath = details.url.startsWith('file://')
          ? decodeURIComponent(new URL(details.url).pathname)
          : ''
      } catch {}
      if (details.method === 'GET' && rendererAssets.has(localPath)) {
        callback({})
        return
      }
      blockedRequests.push(`${details.method} ${details.url.split('?')[0]}`)
      callback({ cancel: true })
    })
    installedSessionPolicy = true
  }
  win = created
  await created.loadFile(join(app.getAppPath(), 'renderer/index.html'))
}

app.whenReady().then(async () => {
  await mkdir(join(profile, 'sessionData'), { recursive: true })
  await createEditorWindow()
})
app.on('before-quit', () => diagnostics.close())
