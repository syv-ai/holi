import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMdxCompiler } from '../src/main/mdx-compiler'
import { createMdxDiagnostics } from '../src/main/mdx-diagnostics'
import { createMdxTrustStore } from '../src/main/mdx-trust'

const profile = process.env.HOLI_507_PROFILE!
const vault = process.env.HOLI_507_VAULT!
app.setPath('userData', join(profile, 'userData'))
app.setPath('sessionData', join(profile, 'sessionData'))

const remote = 'fixture/isolated-mdx'
const context = 'fixture-context-507'
const file = join(vault, 'notes/fixture.mdx')
let accountGeneration = 1
let openRevision = 1
let identity = {
  accountGeneration,
  accountId: '507',
  remote,
  openRevision,
  active: {},
}
let win: BrowserWindow | null = null
let recoveredWindows = 0
let savedWrites = 0
let installedSessionPolicy = false
const blockedRequests: string[] = []
const compiler = createMdxCompiler(join(app.getAppPath(), 'out/mdx-compiler'))
const trustStore = createMdxTrustStore(join(profile, 'mdx-trust.json'))
const owner = () => ({ accountId: identity.accountId, remote })
const diagnostics = createMdxDiagnostics({
  authorize: (candidate, requested) => requested === remote && candidate === identity,
  context: (token, requested) => (token === context && requested === remote ? identity : null),
  root: async (requested) => {
    if (requested !== remote) throw new Error('fixture vault unavailable')
    return vault
  },
  trusted: async (candidate) => candidate === identity && trustStore.status(owner()),
  compile: (source, signal) => compiler.compile(source, signal),
})

const invoke = (channel: string, handler: (...args: any[]) => any) =>
  ipcMain.handle(channel, (_event, ...args) => handler(...args))

invoke('smoke:status', async () => ({
  userData: app.getPath('userData'),
  sessionData: app.getPath('sessionData'),
  appPath: app.getAppPath(),
  vault,
  recoveredWindows,
  savedWrites,
  blockedRequests,
  accountGeneration,
  openRevision,
  compilerAssets: await Promise.all(
    ['guest.html', 'guest.js'].map(async (name) => ({
      name,
      bytes: (await readFile(join(app.getAppPath(), 'out/mdx-compiler', name))).byteLength,
    })),
  ),
}))
invoke('smoke:trpc', async (request: { path: string; operation: string; input?: any }) => {
  const input = request.input ?? {}
  if (request.path === 'notes.read') return readFile(file, 'utf8')
  if (request.path === 'notes.write') {
    if (typeof input.text !== 'string') throw new Error('Fixture note write requires text')
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, input.text, { flag: 'wx' })
    await rename(temporary, file)
    savedWrites += 1
    return { ok: true }
  }
  if (request.path === 'mdxTrust.status') {
    return { trusted: await trustStore.status(owner()), identityAvailable: true, context }
  }
  if (request.path === 'mdxTrust.approve' || request.path === 'mdxTrust.revoke') {
    if (input.context !== context) throw new Error('MDX trust context changed')
    if (request.path.endsWith('.approve')) await trustStore.approve(owner())
    else await trustStore.revoke(owner())
    // The trust store mutation completes before the renderer can observe the new status.
    if (request.path.endsWith('.revoke')) diagnostics.invalidate()
    return { ok: true }
  }
  if (request.path === 'mdxTrust.acquireDiagnosticsLease') return diagnostics.acquire(input)
  if (request.path === 'mdxTrust.cancelCompile') return diagnostics.cancel(input)
  if (request.path === 'mdxTrust.compile') return diagnostics.compile(input)
  if (request.path === 'mdxTrust.releaseDiagnosticsLease') return diagnostics.release(input)
  if (request.path === 'history.list' || request.path === 'github.fileContributors') return []
  throw new Error(`Unsupported fixture tRPC operation: ${request.path}`)
})

app.on('web-contents-created', (_event, contents: WebContents) => {
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
      win?.webContents === contents &&
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
      } catch (error) {
        blockedRequests.push(`invalid URL ${String(error)}`)
      }
      if (details.method === 'GET' && rendererAssets.has(localPath)) callback({})
      else {
        blockedRequests.push(`${details.method} ${details.url.split('?')[0]}`)
        callback({ cancel: true })
      }
    })
    installedSessionPolicy = true
  }
  win = created
  await created.loadFile(join(app.getAppPath(), 'renderer/index.html'))
}

app.whenReady().then(async () => {
  await mkdir(join(profile, 'sessionData'), { recursive: true })
  await mkdir(join(vault, 'notes'), { recursive: true })
  await writeFile(file, '# Café 🪿\n\n<Widget>\n')
  await createEditorWindow()
})
app.on('before-quit', () => {
  diagnostics.close()
  compiler.close()
})
