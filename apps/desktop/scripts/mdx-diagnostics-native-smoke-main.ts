import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { createGuestProbes } from './mdx-compiler-guest-probes'
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMdxResources } from '../src/main/mdx-resources'
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
let guestCreations = 0
let inspectedSources = 0
let installedSessionPolicy = false
const blockedRequests: string[] = []
const guestProbes: Array<{ url: string; result: Record<string, unknown> }> = []
let adversaries: Awaited<ReturnType<typeof createGuestProbes>> | null = null
const compiler = createMdxResources(join(app.getAppPath(), 'out/mdx-compiler'))
const trustStore = createMdxTrustStore(join(profile, 'mdx-trust.json'))
const owner = () => ({ accountId: identity.accountId, remote })
let dependencyRaceChild: string | null = null
const diagnostics = createMdxDiagnostics({
  authorize: (candidate, requested) => requested === remote && candidate === identity,
  context: (token, requested) => (token === context && requested === remote ? identity : null),
  root: async (requested) => {
    if (requested !== remote) throw new Error('fixture vault unavailable')
    return vault
  },
  trusted: async (candidate) => candidate === identity && trustStore.status(owner()),
  createResourceOwner: (isCurrent) => compiler.createOwner(isCurrent),
  retireResourceOwner: (resourceOwner) => compiler.retireOwner(resourceOwner),
  inspect: (resourceOwner, source, signal, format) => {
    inspectedSources += 1
    return compiler.inspect(resourceOwner, source, signal, format).then(async (result) => {
      if (source.includes('HOLI_NATIVE_DEPENDENCY_REPLACEMENT_RACE') && dependencyRaceChild) {
        await writeFile(dependencyRaceChild, '# changed after inspection\n')
        dependencyRaceChild = null
      }
      return result
    })
  },
})

const invoke = (channel: string, handler: (...args: any[]) => any) =>
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Fixture caller is not the current application document')
    return handler(...args)
  })

invoke('smoke:status', async () => ({
  runtime: process.versions,
  userData: app.getPath('userData'),
  sessionData: app.getPath('sessionData'),
  appPath: app.getAppPath(),
  vault,
  recoveredWindows,
  savedWrites,
  guestCreations,
  inspectedSources,
  blockedRequests,
  guestProbes,
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

invoke('smoke:scenarios', async () => {
  assert(adversaries)
  const probes = adversaries
  diagnostics.invalidate()
  const policy = await probes.policy(compiler)
  const recovery = await probes.crashAndHang(compiler)
  const stale: Array<{ name: string; rejected: string }> = []
  const heldChange = async (
    name: string,
    change: (lease: string) => void | Promise<void>,
    reuse = false,
  ) => {
    const { lease } = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
    const ready = probes.hold()
    const result = diagnostics
      .compile({ lease, generation: 1, source: '# held native request\n' })
      .then(
        () => ({ ok: true, message: '' }),
        (error: Error) => ({ ok: false, message: error.message }),
      )
    await ready
    await change(lease)
    const outcome = await result
    assert.equal(outcome.ok, false, `${name} returned stale diagnostics`)
    stale.push({ name, rejected: outcome.message })
    if (reuse) {
      assert.deepEqual(
        await diagnostics.compile({ lease, generation: 2, source: '# current source\n' }),
        [],
      )
      diagnostics.release({ lease })
    } else {
      diagnostics.release({ lease })
      const fresh = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
      assert.deepEqual(
        await diagnostics.compile({
          lease: fresh.lease,
          generation: 1,
          source: '# current owner\n',
        }),
        [],
      )
      diagnostics.release(fresh)
    }
  }
  const graphCases: Array<{ name: string; outcome: string }> = []
  const compileGraphCase = async (name: string, source: string) => {
    const lease = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
    try {
      const result = await diagnostics.compile({ lease: lease.lease, generation: 1, source })
      graphCases.push({ name, outcome: result.length ? 'diagnostics' : 'clean' })
      return result
    } finally {
      diagnostics.release(lease)
    }
  }
  await mkdir(join(vault, 'notes/graph'), { recursive: true })
  await writeFile(join(vault, 'notes/graph/child.jsx'), 'export default <\n')
  const missing = await compileGraphCase(
    'missing dependency',
    "import Child from './graph/missing.jsx'\n<Child />",
  )
  assert(missing.length > 0)
  const syntaxChild = await compileGraphCase('syntax child', "import './graph/child.jsx'\n")
  assert(syntaxChild.length > 0)
  const cycleA = join(vault, 'notes/graph/a.jsx')
  const cycleB = join(vault, 'notes/graph/b.jsx')
  await writeFile(cycleA, "import './b.jsx'\nexport default 1\n")
  await writeFile(cycleB, "import './a.jsx'\nexport default 2\n")
  assert((await compileGraphCase('cycle', "import './graph/a.jsx'\n")).length > 0)
  for (const [name, path] of [
    ['protected dot-local', 'notes/graph/secret.local.jsx'],
    ['protected memory', '.holi/memory/secret.mdx'],
  ] as const) {
    let rejected = false
    try {
      await diagnostics.acquire({ remote, path, context })
    } catch {
      rejected = true
    }
    assert(rejected, `${name} path must be refused`)
    graphCases.push({ name, outcome: 'refused' })
  }
  for (const [name, source] of [
    ['external URL', "import 'https://example.invalid/x.jsx'"],
    ['dynamic import', "{import('./graph/child.jsx')}"],
    ['CommonJS', "{require('./graph/child.jsx')}"],
    ['unsupported formats', "import './graph/child.mjs'"],
    ['outward traversal', "import '../../../outside.jsx'"],
  ] as const) {
    assert((await compileGraphCase(name, source)).length > 0, `${name} must produce diagnostics`)
  }
  await mkdir(join(vault, '.holi/memory'), { recursive: true })
  await writeFile(join(vault, '.holi/memory/secret.mdx'), 'do not inspect fixture content\n')
  assert(
    (await compileGraphCase('protected memory import', "import '../.holi/memory/secret.mdx'\n")).length >
      0,
  )
  assert(
    (await compileGraphCase('protected memory case alias', "import '../.HOLI/memory/secret.mdx'\n"))
      .length > 0,
  )
  await writeFile(
    join(vault, 'notes/graph/secret.local.jsx'),
    'throw new Error("must never evaluate")',
  )
  assert(
    (await compileGraphCase('protected dependency', "import './graph/secret.local.jsx'\n")).length >
      0,
  )
  await symlink(join(vault, 'notes/graph/secret.local.jsx'), join(vault, 'notes/graph/alias.jsx'))
  assert((await compileGraphCase('symlink alias', "import './graph/alias.jsx'\n")).length > 0)
  await writeFile(join(vault, 'notes/graph/large.jsx'), ' '.repeat(256 * 1024 + 1))
  assert((await compileGraphCase('file size limit', "import './graph/large.jsx'\n")).length > 0)
  const budgetFiles = Array.from({ length: 64 }, (_, index) => `budget${index}.js`)
  for (const name of budgetFiles)
    await writeFile(join(vault, 'notes/graph', name), 'export const value = 1\n')
  assert(
    (await compileGraphCase('module count budget', "import './graph/budget0.js'\n" + budgetFiles.slice(1).map((name) => `import './graph/${name}'`).join('\n'))).length > 0,
  )
  await writeFile(join(vault, 'notes/graph/aggregate-a.js'), 'x'.repeat(600 * 1024))
  await writeFile(join(vault, 'notes/graph/aggregate-b.js'), 'x'.repeat(600 * 1024))
  assert(
    (await compileGraphCase('aggregate size budget', "import './graph/aggregate-a.js'\nimport './graph/aggregate-b.js'\n")).length > 0,
  )
  for (let index = 0; index < 18; index++) {
    await writeFile(
      join(vault, `notes/graph/depth${index}.js`),
      index === 17 ? 'export const leaf = 1' : `export * from './depth${index + 1}.js'`,
    )
  }
  assert((await compileGraphCase('graph depth limit', "import './graph/depth0.js'\n")).length > 0)
  await writeFile(
    join(vault, 'notes/graph/child.jsx'),
    "export const marker = 'HOLI_NATIVE_DEPENDENCY_REPLACEMENT_RACE'",
  )
  const raceLease = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
  dependencyRaceChild = join(vault, 'notes/graph/child.jsx')
  let raceRejected = false
  try {
    await diagnostics.compile({
      lease: raceLease.lease,
      generation: 1,
      source: "import './graph/child.jsx'\n",
    })
  } catch {
    raceRejected = true
  } finally {
    dependencyRaceChild = null
    diagnostics.release(raceLease)
  }
  assert(raceRejected, 'dependency replacement during inspection must invalidate graph snapshot')
  graphCases.push({ name: 'dependency replacement race', outcome: 'refused' })
  assert.deepEqual(await compileGraphCase('fresh source after race', '# valid source\n'), [])

  const activeOwner = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
  const activeReady = probes.hold()
  const activeResult = diagnostics
    .compile({ lease: activeOwner.lease, generation: 1, source: '# queued ownership owner\n' })
    .then(
      () => false,
      () => true,
    )
  await activeReady
  const queuedOwner = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
  const inspectedCount = inspectedSources
  const queuedResult = diagnostics
    .compile({ lease: queuedOwner.lease, generation: 1, source: '# revoked while queued\n' })
    .then(
      () => false,
      () => true,
    )
  for (let attempt = 0; attempt < 100 && inspectedSources === inspectedCount; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  diagnostics.release({ lease: queuedOwner.lease })
  assert.equal(
    await queuedResult,
    true,
    'revoking a diagnostics owner must cancel its queued compile',
  )
  diagnostics.release({ lease: activeOwner.lease })
  assert.equal(
    await activeResult,
    true,
    'releasing the active diagnostics owner must cancel in-flight work',
  )
  stale.push({ name: 'queued ownership revocation and in-flight release', rejected: 'cancelled' })

  await heldChange(
    'source generation cancellation',
    (lease) => {
      diagnostics.cancel({ lease, generation: 2 })
    },
    true,
  )
  await heldChange('view release', (lease) => {
    diagnostics.release({ lease })
  })
  await heldChange('trust revoke and reapproval', async () => {
    diagnostics.invalidate()
    await trustStore.revoke(owner())
    await trustStore.approve(owner())
  })
  await heldChange('account A–B–A', () => {
    diagnostics.invalidate()
    identity = {
      ...identity,
      accountId: 'other',
      accountGeneration: ++accountGeneration,
      active: {},
    }
    diagnostics.invalidate()
    identity = { ...identity, accountId: '507', accountGeneration: ++accountGeneration, active: {} }
  })
  await heldChange('vault A–B–A', () => {
    diagnostics.invalidate()
    identity = { ...identity, remote: 'fixture/other', openRevision: ++openRevision, active: {} }
    diagnostics.invalidate()
    identity = { ...identity, remote, openRevision: ++openRevision, active: {} }
  })
  await heldChange('native filesystem replacement watcher', async () => {
    await writeFile(`${file}.replacement`, '# atomically replaced source\n')
    await rename(`${file}.replacement`, file)
  })
  probes.assertHealthy()
  await probes.close()
  adversaries = null
  return { policy, recovery, stale, graphCases }
})

app.on('web-contents-created', (_event, contents: WebContents) => {
  if (contents.session !== session.defaultSession) {
    guestCreations += 1
    contents.once('did-finish-load', () => {
      if (contents.getURL() !== 'https://mdx-compiler.invalid/guest.html') return
      void contents
        .executeJavaScript(
          `(() => ({
        globals: { process: typeof process, require: typeof require, holi: typeof holi, electron: typeof electron, bridge: typeof holiSmoke },
        storage: { cookies: document.cookie, local: localStorage.length, session: sessionStorage.length },
        credentialMarker: localStorage.getItem('holi-native-default-credential-507'),
      }))()`,
        )
        .then((result) => {
          guestProbes.push({
            url: contents.isDestroyed() ? 'destroyed' : contents.getURL(),
            result,
          })
        })
        .catch(() => undefined)
    })
    return
  }
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
  adversaries = await createGuestProbes()
  await mkdir(join(profile, 'sessionData'), { recursive: true })
  await mkdir(join(vault, 'notes'), { recursive: true })
  await writeFile(file, '# Café 🪿\n\nCafé 🪿 {1 + }\n')
  await createEditorWindow()
})
app.on('before-quit', () => {
  diagnostics.close()
  compiler.close()
  void adversaries?.close()
})
