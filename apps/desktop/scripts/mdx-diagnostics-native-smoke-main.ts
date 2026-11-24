import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
import { trackMdxDocument } from '../src/main/mdx-document-lifetime'
import { createRouter } from '../src/main/router'
import { toEnvelope, type TrpcEnvelope } from '../src/main/trpc-call'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'
import { VaultRegistry } from '../src/main/vault/registry'
import { createGuestProbes } from './mdx-compiler-guest-probes'
import { fixtureOrigins, observeMdxNativeNetwork } from './mdx-native-network-observation'
import { createMdxResources } from '../src/main/mdx-resources'
import { createNativeMdxScenarios } from './mdx-diagnostics-native-scenarios'
import { createMdxTrustStore } from '../src/main/mdx-trust'

const {
  HOLI_MDX_SMOKE_PROFILE,
  HOLI_MDX_SMOKE_VAULT,
  HOLI_MDX_SMOKE_FIXTURE_SHA: fixtureSha,
} = process.env
assert(HOLI_MDX_SMOKE_PROFILE && HOLI_MDX_SMOKE_VAULT, 'Dedicated fixture paths are required')
assert(fixtureSha && /^[a-f0-9]{40}$/.test(fixtureSha), 'A pinned public fixture SHA is required')
const profile = HOLI_MDX_SMOKE_PROFILE
const vault = HOLI_MDX_SMOKE_VAULT
app.setName(basename(dirname(profile)))
app.setPath('userData', join(profile, 'userData'))
app.setPath('sessionData', join(profile, 'sessionData'))

const remote = 'fixture/isolated-mdx'
const fixtureAccountId = 507
const path = 'notes/fixture.mdx'
const file = join(vault, path)
const entry = join(app.getAppPath(), 'renderer/index.html')
const entryDocument = pathToFileURL(entry).href
const otherDocument = join(app.getAppPath(), 'renderer/other.html')
const otherDocumentUrl = pathToFileURL(otherDocument).href
// This never exists. Only the current fixture window can request this one local file.
const missingDocument = pathToFileURL(join(profile, 'missing-navigation.html')).href
const preload = join(app.getAppPath(), 'preload.cjs')
let win: BrowserWindow | null = null
let recoveredWindows = 0
let guestCreations = 0
let inspectedSources = 0
let mdxDocumentReady = () => false
let retireDocument = (_retireDocument: boolean) => {}
let preventedNavigations = 0
let errorPageRace: Promise<TrpcEnvelope> | null = null
let missingNavigation: ReturnType<typeof navigationGate> | null = null
let closeRouter = () => {}
let resourcePushes = 0
let ambientCookieHosts = 0
const blockedRequests: string[] = []
const guestProbes: Array<{ url: string; result: Record<string, unknown> }> = []
let adversaries: Awaited<ReturnType<typeof createGuestProbes>> | null = null
const compiler = createMdxResources(join(app.getAppPath(), 'out/mdx-compiler'))
const trustStore = createMdxTrustStore(join(profile, 'mdx-trust.json'))
const consent = createMdxConsentStore(join(profile, 'mdx-consent.json'))
// The store supports only the MDX dependency diagnostics purpose. Match the rest
// of its scope here; the runner supplies the canonical isolated fixture root.
const isFixtureScope = (scope: Parameters<typeof consent.grant>[0]) =>
  scope.root === vault && scope.remote === remote && scope.accountId === String(fixtureAccountId)
const observedConsent: typeof consent = {
  ...consent,
  async grant(scope, stillOwned) {
    // Pause a router-admitted approval at the consent seam. Forward its original
    // ownership check to the real store; don't fabricate a write or a rejection.
    const race = missingNavigation
    if (race) {
      race.approvalAdmitted.resolve()
      await race.releaseApproval.promise
    }
    return consent.grant(scope, stillOwned)
  },
  revoke(scope) {
    // The store blocks new access synchronously at admission, not at disk removal.
    const removal = consent.revoke(scope)
    if (isFixtureScope(scope)) observedNetwork.admittedRevocation(scope.origin)
    return removal
  },
}
const observedCompiler: typeof compiler = {
  ...compiler,
  inspect(...args) {
    inspectedSources += 1
    return compiler.inspect(...args)
  },
}

// Keep the original injected local graph/guest scenarios separate from the
// application router. The FileView and external driver never call this instance.
const legacyScenarios = createNativeMdxScenarios({
  vault,
  remote,
  compiler,
  trustStore,
  inspect: observedCompiler.inspect,
})

const authorizeSender = (event: SenderEvent) =>
  mdxDocumentReady() &&
  isApplicationSender(event, win && !win.isDestroyed() ? win.webContents : null, entryDocument)

const invoke = (channel: string, handler: (input: unknown) => unknown) =>
  ipcMain.handle(channel, (event, input) => {
    if (!authorizeSender(event)) throw unauthorizedApplicationSender()
    return handler(input)
  })

const observedNetwork = observeMdxNativeNetwork(fixtureSha)
const stopObservingApprovals = consent.onSavedApproval((scope) => {
  if (isFixtureScope(scope)) observedNetwork.savedApproval(scope.origin)
})
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
  preventedNavigations,
  ambientCookieHosts,
  blockedRequests,
  guestProbes,
  ...legacyScenarios.status(),
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

invoke('smoke:scenarios', () => {
  assert(adversaries)
  return legacyScenarios.run(adversaries)
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
  contents.on('will-navigate', (event) => {
    if (win?.webContents === contents && event.url === entryDocument) return
    event.preventDefault()
    if (win?.webContents === contents && event.url === otherDocumentUrl) preventedNavigations += 1
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
  mdxDocumentReady = trackMdxDocument(created.webContents, (retire) => {
    if (win === created) retireDocument(retire)
  })
  created.webContents.on('render-process-gone', (_event, details) => {
    if (win !== created) return
    win = null
    recoveredWindows += 1
    console.log(`SMOKE_RENDERER_CRASH_RECOVERY:${details.reason}:${recoveredWindows}`)
    setTimeout(() => void createEditorWindow(), 100)
  })
  await created.loadFile(entry)
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function navigationGate(webContentsId: number) {
  return {
    webContentsId,
    requested: gate(),
    releaseRequest: gate(),
    approvalAdmitted: gate(),
    releaseApproval: gate(),
  }
}

async function exerciseErrorPage(
  current: BrowserWindow,
  routes: ReturnType<ReturnType<typeof createRouter>['createCaller']>['mdxTrust'],
  priorContext: string,
) {
  assert(adversaries)
  const contents = current.webContents
  const race = (missingNavigation = navigationGate(contents.id))
  const started = gate()
  const onStart = ({ isMainFrame, url }: { isMainFrame: boolean; url: string }) => {
    if (isMainFrame && url === missingDocument) started.resolve()
  }
  let failure: { code: number; description: string } | undefined
  const onFailure = (
    _event: unknown,
    code: number,
    description: string,
    url: string,
    main: boolean,
  ) => {
    if (main && url === missingDocument) failure = { code, description }
  }
  let didNavigate = false
  const onNavigate = () => {
    didNavigate = true
  }
  contents.on('did-start-navigation', onStart)
  contents.on('did-fail-provisional-load', onFailure)
  contents.on('did-navigate', onNavigate)
  const loading = toEnvelope(current.loadURL(missingDocument))
  const senderCurrent = () => authorizeSender({ sender: contents, senderFrame: contents.mainFrame })
  try {
    await Promise.race([
      Promise.all([started.promise, race.requested.promise]),
      loading.then(() => {
        throw new Error('Missing-file navigation did not pause in the provisional document')
      }),
    ])
    assert(senderCurrent(), 'The provisional load lost the current application sender')
    const input = { remote, path: 'notes/probe.mdx', context: priorContext }
    // Use the real routes on the main side for these two outstanding results:
    // Electron discards replies to the old renderer when its document commits away.
    // The context came from the still-current renderer via the guarded IPC route.
    const { lease } = await routes.acquireDiagnosticsLease(input)
    const source = await readFile(file, 'utf8')
    assert((await routes.compile({ lease, generation: 1, source })).length > 0)
    const state = await routes.externalResources({ lease })
    assert.deepEqual(
      state.pending.map(({ origin }) => origin),
      [fixtureOrigins[0]],
    )
    const approval = toEnvelope(
      routes.approveExternalResource({ lease, requestId: state.pending[0]!.id }),
    )
    await Promise.race([
      race.approvalAdmitted.promise,
      approval.then((result) => {
        throw new Error(`Approval did not reach the consent seam: ${JSON.stringify(result)}`)
      }),
    ])

    const work = await routes.acquireDiagnosticsLease(input)
    const held = adversaries.hold()
    const compile = toEnvelope(
      routes.compile({ ...work, generation: 1, source: '# Held across the error page\n' }),
    )
    await held
    race.releaseRequest.resolve()
    assert.equal((await loading).ok, false, 'The owned nonexistent file unexpectedly loaded')
    assert.deepEqual(failure, { code: -6, description: 'ERR_FILE_NOT_FOUND' })
    assert.equal(didNavigate, false, 'Electron emitted a successful navigation for the error page')
    assert(!senderCurrent(), 'The committed error page was accepted as the application sender')
    await assert.rejects(routes.status({ remote }), /context changed/i)
    await assert.rejects(routes.acquireDiagnosticsLease(input), /MDX context unavailable/i)
    race.releaseApproval.resolve()
    const [approvalResult, compileResult] = await Promise.all([approval, compile])
    assert(
      !approvalResult.ok && /MDX resource request unavailable/i.test(approvalResult.message),
      'The admitted approval survived the committed error page',
    )
    assert(
      !compileResult.ok && /cancel|supersed|unavailable|invalidated/i.test(compileResult.message),
      'The held compile was not cancelled by the committed error page',
    )
    return {
      error: 'ERR_FILE_NOT_FOUND',
      didNavigate,
      approvalRejected: true,
      compileRejected: true,
    }
  } finally {
    race.releaseRequest.resolve()
    race.releaseApproval.resolve()
    missingNavigation = null
    contents.off('did-start-navigation', onStart)
    contents.off('did-fail-provisional-load', onFailure)
    contents.off('did-navigate', onNavigate)
    await loading
    await current.loadFile(entry)
  }
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
      const race = missingNavigation
      if (
        race &&
        details.url === missingDocument &&
        details.webContentsId === race.webContentsId &&
        details.method === 'GET' &&
        details.resourceType === 'mainFrame'
      ) {
        race.requested.resolve()
        // Let Chromium read the real missing file only after the original
        // document has acquired fresh work during the provisional navigation.
        void race.releaseRequest.promise.then(() => callback({}))
        return
      }
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
      accountId: fixtureAccountId,
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
      mdxConsent: observedConsent,
      mdxCompiler: observedCompiler,
      mdxApplicationReady: () => mdxDocumentReady(),
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
    const routes = router.createCaller({})
    invoke('smoke:start-error-page-race', (priorContext) => {
      assert(win && !win.isDestroyed() && !errorPageRace && typeof priorContext === 'string')
      errorPageRace = toEnvelope(exerciseErrorPage(win, routes.mdxTrust, priorContext))
      return true
    })
    invoke('smoke:error-page-result', () => errorPageRace)
    await routes.vaults.open({ remote })
    await createEditorWindow()
  })
  .catch(() => {
    console.error('Packaged MDX fixture startup failed')
    app.exit(1)
  })
app.on('before-quit', () => {
  mdxDocumentReady = () => false
  closeRouter()
  legacyScenarios.close()
  compiler.close()
  stopObservingApprovals()
  observedNetwork.close()
  void adversaries?.close()
})
