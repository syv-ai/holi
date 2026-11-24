import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { emptyVaultSnapshot, MDX_RESOURCE_EVENTS } from '@holi/shared'
import {
  isApplicationSender,
  unauthorizedApplicationSender,
  type SenderEvent,
} from '../src/main/application-sender'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore } from '../src/main/github/token-store'
import { registerIpc } from '../src/main/ipc'
import { createMdxConsentStore } from '../src/main/mdx-consent'
import { createRouter } from '../src/main/router'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'
import { VaultRegistry } from '../src/main/vault/registry'
import { createGuestProbes } from './mdx-compiler-guest-probes'
import { fixtureOrigins, observeMdxNativeNetwork } from './mdx-native-network-observation'
import { createMdxResources } from '../src/main/mdx-resources'
import { createMdxDiagnostics } from '../src/main/mdx-diagnostics'
import { createMdxTrustStore } from '../src/main/mdx-trust'

const { HOLI_MDX_SMOKE_PROFILE, HOLI_MDX_SMOKE_VAULT } = process.env
assert(HOLI_MDX_SMOKE_PROFILE && HOLI_MDX_SMOKE_VAULT, 'Dedicated fixture paths are required')
const profile = HOLI_MDX_SMOKE_PROFILE
const vault = HOLI_MDX_SMOKE_VAULT
app.setName(basename(dirname(profile)))
app.setPath('userData', join(profile, 'userData'))
app.setPath('sessionData', join(profile, 'sessionData'))

const remote = 'fixture/isolated-mdx'
const context = 'fixture-context-507'
const path = 'notes/fixture.mdx'
const file = join(vault, path)
const entry = join(app.getAppPath(), 'renderer/index.html')
const entryDocument = pathToFileURL(entry).href
const otherDocument = join(app.getAppPath(), 'renderer/other.html')
const preload = join(app.getAppPath(), 'preload.cjs')
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
let guestCreations = 0
let inspectedSources = 0
let documentReady = false
let retireDocument = () => {}
let closeRouter = () => {}
let resourcePushes = 0
let ambientCookieHosts = 0
const blockedRequests: string[] = []
const guestProbes: Array<{ url: string; result: Record<string, unknown> }> = []
let adversaries: Awaited<ReturnType<typeof createGuestProbes>> | null = null
const compiler = createMdxResources(join(app.getAppPath(), 'out/mdx-compiler'))
const trustStore = createMdxTrustStore(join(profile, 'mdx-trust.json'))
const owner = () => ({ accountId: identity.accountId, remote })
let dependencyRaceChild: string | null = null
let graphMutation: ((source: string) => Promise<void>) | null = null
const observedCompiler: typeof compiler = {
  ...compiler,
  inspect(...args) {
    inspectedSources += 1
    return compiler.inspect(...args)
  },
}

// Keep the original injected local graph/guest scenarios separate from the
// application router. The FileView and external driver never call this instance.
const diagnostics = createMdxDiagnostics({
  authorize: (candidate, requested) => requested === remote && candidate === identity,
  context: (token, requested) => (token === context && requested === remote ? identity : null),
  root: async (requested) => {
    if (requested !== remote) throw new Error('fixture vault unavailable')
    return vault
  },
  trusted: async (candidate) => candidate === identity && trustStore.status(owner()),
  createResourceOwner: compiler.createOwner,
  retireResourceOwner: compiler.retireOwner,
  async inspect(resourceOwner, source, signal, format) {
    const result = await observedCompiler.inspect(resourceOwner, source, signal, format)
    await graphMutation?.(source)
    if (source.includes('HOLI_NATIVE_DEPENDENCY_REPLACEMENT_RACE') && dependencyRaceChild) {
      await writeFile(dependencyRaceChild, '# changed after inspection\n')
      dependencyRaceChild = null
    }
    return result
  },
})

const authorizeSender = (event: SenderEvent) =>
  documentReady &&
  isApplicationSender(event, win && !win.isDestroyed() ? win.webContents : null, entryDocument)

const invoke = (channel: string, handler: (input: unknown) => unknown) =>
  ipcMain.handle(channel, (event, input) => {
    if (!authorizeSender(event)) throw unauthorizedApplicationSender()
    return handler(input)
  })

const observedNetwork = observeMdxNativeNetwork()
invoke('smoke:arm-stream', () => observedNetwork.armStream())
invoke('smoke:stream-status', () => observedNetwork.streamStatus())

invoke('smoke:status', async () => ({
  runtime: process.versions,
  userData: app.getPath('userData'),
  sessionData: app.getPath('sessionData'),
  appPath: app.getAppPath(),
  vault,
  recoveredWindows,
  guestCreations,
  inspectedSources,
  network: observedNetwork.network,
  resourcePushes,
  ambientCookieHosts,
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
// Use the same preload and a real local document in a different WebContents.
// The production IPC guard must reject it even when handed valid current IDs.
invoke('smoke:other-document', async (operation: unknown) => {
  const other = new BrowserWindow({ show: false, webPreferences })
  try {
    await other.loadFile(otherDocument)
    return await other.webContents.executeJavaScript(
      `window.holi.trpc(${JSON.stringify(operation)})`,
    )
  } finally {
    other.destroy()
  }
})

invoke('smoke:guest-healthy', () => {
  assert(adversaries)
  adversaries.assertHealthy()
  return true
})

invoke('smoke:hold-compiler', async () => {
  assert(adversaries)
  await adversaries.hold()
  return true
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
    (await compileGraphCase('protected memory import', "import '../.holi/memory/secret.mdx'\n"))
      .length > 0,
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
    (
      await compileGraphCase(
        'module count budget',
        "import './graph/budget0.js'\n" +
          budgetFiles
            .slice(1)
            .map((name) => `import './graph/${name}'`)
            .join('\n'),
      )
    ).length > 0,
  )
  const aggregateFiles = Array.from({ length: 6 }, (_, i) => `aggregate${i}.js`)
  for (const name of aggregateFiles)
    await writeFile(
      join(vault, 'notes/graph', name),
      '/*' + ' '.repeat(200 * 1024) + '*/\nexport const value = 1',
    )
  assert(
    (
      await compileGraphCase(
        'aggregate size budget',
        aggregateFiles.map((name) => `import './graph/${name}'`).join('\n'),
      )
    ).length > 0,
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

  const graphRace = async (
    name: string,
    source: string,
    mutate: () => Promise<void>,
    restore: () => Promise<void>,
  ) => {
    graphMutation = async (parsed) => {
      if (!parsed.includes('HOLI_GRAPH_RACE_CHILD')) return
      graphMutation = null
      await mutate()
    }
    let refused = false
    try {
      await compileGraphCase(name, source)
    } catch {
      refused = true
    } finally {
      graphMutation = null
      await restore()
    }
    assert(refused, `${name} must reject stale diagnostics`)
    graphCases.push({ name, outcome: 'refused' })
  }
  await writeFile(
    join(vault, 'notes/graph/race.js'),
    "export const value = 'HOLI_GRAPH_RACE_CHILD'",
  )
  const backupVault = `${vault}-graph-race-backup`
  await graphRace(
    'root replacement',
    "import './graph/race.js'\n",
    async () => {
      await rename(vault, backupVault)
      await mkdir(join(vault, 'notes'), { recursive: true })
      await writeFile(file, '# replacement root')
    },
    async () => {
      await rm(vault, { recursive: true, force: true })
      await rename(backupVault, vault)
    },
  )
  const graphDir = join(vault, 'notes/graph')
  const backupGraph = join(vault, 'notes/graph-backup')
  await graphRace(
    'ancestor replacement',
    "import './graph/race.js'\n",
    async () => {
      await rename(graphDir, backupGraph)
      await mkdir(graphDir)
    },
    async () => {
      await rm(graphDir, { recursive: true, force: true })
      await rename(backupGraph, graphDir)
    },
  )
  await writeFile(join(graphDir, 'shared.js'), 'export const shared = 1')
  await writeFile(join(graphDir, 'left.js'), "export * from './shared.js'")
  await writeFile(
    join(graphDir, 'right.js'),
    "export * from './shared.js'\nexport const marker = 'HOLI_GRAPH_RACE_CHILD'",
  )
  await graphRace(
    'diamond snapshot replacement',
    "import './graph/left.js'\nimport './graph/right.js'\n",
    async () => {
      await writeFile(join(graphDir, 'shared.js'), 'export const shared = 200')
    },
    async () => {},
  )
  await writeFile(join(graphDir, 'case.js'), 'export const value = 1')
  await writeFile(join(graphDir, 'CASE.js'), 'export const value = ;')
  const caseSensitive =
    (await stat(join(graphDir, 'case.js'))).ino !== (await stat(join(graphDir, 'CASE.js'))).ino
  if (caseSensitive) {
    assert(
      (
        await compileGraphCase(
          'case-distinct dependency paths',
          "import './graph/case.js'\nimport './graph/CASE.js'\n",
        )
      ).length > 0,
    )
  } else {
    await writeFile(join(graphDir, 'case.js'), 'export const value = 1')
    const canonicalCase = await import('node:fs/promises').then((fs) =>
      fs.realpath(join(graphDir, 'case.js')),
    )
    const alias = canonicalCase.endsWith('/case.js') ? 'CASE.js' : 'case.js'
    assert(
      (await compileGraphCase('case-insensitive alias rejected', `import './graph/${alias}'\n`))
        .length > 0,
    )
    graphCases.push({
      name: 'case-distinct files',
      outcome: 'inapplicable: case-insensitive filesystem',
    })
  }
  assert.deepEqual(
    await compileGraphCase('fresh source after graph races', '# source remains usable'),
    [],
  )

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
        storage: { hasCookies: document.cookie !== '', local: localStorage.length, session: sessionStorage.length },
        hasCredentialMarker: localStorage.getItem('holi-native-default-credential-507') !== null,
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
      documentReady = false
      retireDocument()
      win = null
      recoveredWindows += 1
      console.log(`SMOKE_RENDERER_CRASH_RECOVERY:${details.reason}:${recoveredWindows}`)
      setTimeout(() => void createEditorWindow(), 100)
    }
  })
  contents.on('will-navigate', (event, url) => {
    if (win?.webContents === contents && url === entryDocument) return
    event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

const webPreferences = {
  preload,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
}

async function createEditorWindow() {
  const created = new BrowserWindow({ width: 1120, height: 820, show: true, webPreferences })
  win = created
  const retire = () => {
    if (win !== created) return
    documentReady = false
    retireDocument()
  }
  retire()
  created.on('closed', retire)
  created.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) retire()
  })
  created.webContents.on('did-navigate', () => {
    if (win === created) documentReady = true
  })
  await created.loadFile(entry)
}

app
  .whenReady()
  .then(async () => {
    const defaultSession = session.defaultSession
    defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    defaultSession.setPermissionCheckHandler(() => false)
    defaultSession.on('will-download', (event) => event.preventDefault())
    const extraAssets = join(app.getAppPath(), 'renderer/assets')
    const rendererAssets = new Set([
      ...(await readdir(extraAssets).catch(() => [])).map((name) => join(extraAssets, name)),
      entry,
      otherDocument,
      join(app.getAppPath(), 'renderer/renderer.js'),
      join(app.getAppPath(), 'renderer/renderer.css'),
    ])
    defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let localPath = ''
      try {
        if (details.url.startsWith('file://'))
          localPath = decodeURIComponent(new URL(details.url).pathname)
      } catch {
        // Malformed URL, still denied below.
      }
      if (details.method === 'GET' && rendererAssets.has(localPath)) callback({})
      else {
        blockedRequests.push(details.resourceType)
        callback({ cancel: true })
      }
    })
    for (const origin of fixtureOrigins) {
      const url = `${origin}/`
      const name = 'mdx-fixture-cookie'
      await defaultSession.cookies.set({
        url,
        name,
        value: 'synthetic-only',
        secure: true,
        httpOnly: true,
      })
      if ((await defaultSession.cookies.get({ url, name })).length === 1) ambientCookieHosts += 1
    }
    adversaries = await createGuestProbes()
    await mkdir(join(vault, 'notes'), { recursive: true })
    await writeFile(file, '# Café 🪿\n\nCafé 🪿 {1 + }\n')
    await writeFile(join(vault, 'notes/probe.mdx'), '# Isolated diagnostics ownership probe\n')
    const registry = new VaultRegistry(join(profile, 'vaults.json'))
    await registry.add({ remote, path: vault, name: 'isolated-mdx', lastOpenedAt: '2026-01-01' })
    // Synthetic, ephemeral credential only. Never open an OS keychain or allow
    // the unrelated GitHub API to contact the network from the fixture.
    const token = new TokenStore(join(profile, 'synthetic-auth.enc'), {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: (bytes) => bytes.toString('utf8'),
    })
    await token.write({
      accountId: 507,
      login: 'fixture-user',
      token: 'synthetic-only',
      scopes: [],
    })
    const github = await GitHubSession.load({
      store: token,
      fetch: async () => {
        throw new Error('Fixture GitHub API is offline')
      },
    })
    const activeVault = {
      remote,
      root: vault,
      repo: { root: vault, log: async () => [] },
      snapshot: async () => emptyVaultSnapshot(),
      refresh: async () => {},
    } as unknown as ActiveVault
    let active: ActiveVault | null = null
    const host = {
      active: () => active,
      get: (requested: string) => (requested === remote ? active : null),
      prepare: async () => {}, // The fixture vault already exists and never syncs.
      open: async (requested: string) => {
        assert.equal(requested, remote)
        return (active = activeVault)
      },
    } as unknown as VaultHost
    const router = createRouter({
      registry,
      session: github,
      host,
      mdxTrust: trustStore,
      mdxConsent: createMdxConsentStore(join(profile, 'mdx-consent.json')),
      mdxCompiler: observedCompiler,
      mdxApplicationReady: () => documentReady,
      onMdxDiagnosticsInvalidate: (invalidate) => {
        retireDocument = invalidate
      },
      onMdxDiagnosticsClose: (close) => {
        closeRouter = close
      },
      onMdxResourcesChanged: (remote) => {
        if (!win || win.isDestroyed()) return
        const contents = win.webContents
        if (!authorizeSender({ sender: contents, senderFrame: contents.mainFrame })) return
        resourcePushes += 1
        contents.send(`plugin:${MDX_RESOURCE_EVENTS}`, { remote, name: 'changed', payload: null })
      },
      plugins: {
        reconcile: async () => {},
        invalidate: () => {},
        setDisplayed: () => {},
        syncBackground: async () => {},
        failures: () => ({}),
        scanClaimsFor: async () => [],
      },
      vaultRoot: dirname(vault),
      seed: async () => ({ written: [], merged: [], unchanged: [] }),
      openExternal: async () => {
        throw new Error('Fixture external navigation is disabled')
      },
      trashItem: async () => {
        throw new Error('Fixture system trash is disabled')
      },
      showItemInFolder: () => {},
    })
    registerIpc({
      router,
      rootFor: async (requested) => (requested === remote ? vault : null),
      authorizeSender,
    })
    await router.createCaller({}).vaults.open({ remote })
    await createEditorWindow()
  })
  .catch(() => {
    console.error('Packaged MDX fixture startup failed')
    app.exit(1)
  })
app.on('before-quit', () => {
  documentReady = false
  closeRouter()
  diagnostics.close()
  compiler.close()
  observedNetwork.close()
  void adversaries?.close()
})
