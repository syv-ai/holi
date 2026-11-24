import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { MDX_RESOURCE_EVENTS } from '../../../packages/shared/src/mdx-diagnostics.ts'
import { fixtureOrigins } from './mdx-native-network-observation.ts'
import { createCdpClient } from './native-smoke-cdp.mjs'
import { encodeScreencast } from './native-smoke-recording.mjs'
import { createOwnedProcesses } from './owned-processes.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildOnly = process.argv[2] === '--build-only'
const fixtureSha = process.env.HOLI_MDX_SMOKE_FIXTURE_SHA
const recordVideo = process.env.HOLI_MDX_SMOKE_VIDEO === '1'
if (!buildOnly) {
  assert(
    /^[a-f0-9]{40}$/.test(fixtureSha ?? ''),
    'Set HOLI_MDX_SMOKE_FIXTURE_SHA to the public commit containing the synthetic ESM fixtures',
  )
  assert(
    ['darwin', 'linux'].includes(process.platform),
    'Native fixture cleanup requires a POSIX process group',
  )
}
const evidenceArgument = process.argv[buildOnly ? 3 : 2]
const evidence = evidenceArgument
  ? resolve(evidenceArgument)
  : await mkdtemp(join(tmpdir(), 'holi-665-evidence-'))
await mkdir(evidence, { recursive: true })
assert.deepEqual(await readdir(evidence), [], 'Use a new or empty evidence directory')
const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-665-mdx-native-')))
const profile = join(root, 'profile')
const vault = join(root, 'vault')
const appDir = join(root, 'app')
const owned = createOwnedProcesses()
const cleanup = { processGroupGone: false, temporaryRootRemoved: false, parentPortClosed: false }
let child
let socket
let cdp
let logs = ''
let outcome = 'failed'
let nativeScenarios = null
let runtime = null
let positionedDiagnostics = null
const external = {
  stage: 'not started',
  observation: {
    scope:
      'Electron main-process Node transport only; no Chromium, OS DNS packet, or server-side observation',
    dns: 'Public Resolver.resolve4/resolve6 invocations and aggregate Node DNS async resources; not DNS packets or cache misses',
    tls: 'Public tls.connect invocations by SNI; verifiedPeer requires an authorized handshake at the original numeric address and port 443',
    socket:
      'Aggregate Node TCP/TLS async resources, not a count of connections; unattributed resources fail traffic checks',
    http: 'Public Node HTTP diagnostics channels; evidence contains fixed route labels, statuses, and header presence booleans, not header values or bodies',
  },
  snapshots: {},
  streamRevocation: null,
}
const evidenceFiles = ['result.json', 'electron-smoke.log']
const checks = []
const portServer = createServer()

// Never inherit provider/CI tokens, NODE_OPTIONS, custom trust roots or proxies.
const desktopEnv = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY'].flatMap(
    (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  ),
)
const childEnv = {
  ...desktopEnv,
  HOME: profile,
  USERPROFILE: profile,
  TMPDIR: join(root, 'tmp'),
  XDG_CONFIG_HOME: join(profile, 'config'),
  XDG_CACHE_HOME: join(profile, 'cache'),
  XDG_DATA_HOME: join(profile, 'data'),
}
const shutdown = new AbortController()
const interrupted = (signal) => {
  // A caller interrupt also goes through finally rather than leaving the app and profile behind.
  logs += `\nRunner interrupted by ${signal}\n`
  cdp?.close()
  socket?.close()
  shutdown.abort(new Error('MDX fixture interrupted'))
}
process.once('SIGINT', interrupted)
process.once('SIGTERM', interrupted)

async function freePort() {
  await new Promise((resolve, reject) =>
    portServer.listen(0, '127.0.0.1', resolve).once('error', reject),
  )
  const { port } = portServer.address()
  await new Promise((resolve, reject) =>
    portServer.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}
async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
async function waitFor(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted()
    try {
      last = await fn()
      if (last) return last
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

try {
  await mkdir(join(vault, 'notes'), { recursive: true })
  await Promise.all(
    ['userData', 'sessionData', 'config', 'cache', 'data'].map((name) =>
      mkdir(join(profile, name), { recursive: true }),
    ),
  )
  await mkdir(childEnv.TMPDIR)
  await mkdir(join(appDir, 'renderer'), { recursive: true })
  await writeFile(join(vault, 'notes', 'fixture.mdx'), '# fixture\n')

  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: {
      target: 'chrome140',
      outDir: join(appDir, 'renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/mdx-diagnostics-native-smoke.tsx'),
        output: { entryFileNames: 'renderer.js', assetFileNames: 'renderer.[ext]' },
      },
    },
  })
  await writeFile(
    join(appDir, 'renderer', 'index.html'),
    `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'"><title>MDX diagnostics smoke</title><link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div><script type="module" src="./renderer.js"></script></body></html>`,
  )
  await writeFile(
    join(appDir, 'renderer', 'other.html'),
    '<!doctype html><meta charset="utf-8"><title>Other fixture document</title>',
  )
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: appDir,
      emptyOutDir: false,
      rollupOptions: {
        input: join(desktop, 'scripts/mdx-diagnostics-native-smoke-main.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  await writeFile(
    join(appDir, 'preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron');
    const resourceEvents = ${JSON.stringify(MDX_RESOURCE_EVENTS)};
    const subscribers = new Set();
    ipcRenderer.on('plugin:' + resourceEvents, (_event, message) => {
      for (const cb of subscribers) cb(message);
    });
    contextBridge.exposeInMainWorld('holi', {
      trpc: (op) => ipcRenderer.invoke('holi:trpc', op),
      plugin: { on: (id, cb) => {
        if (id !== resourceEvents) return () => {};
        subscribers.add(cb);
        return () => { subscribers.delete(cb); };
      } },
    });
    contextBridge.exposeInMainWorld('holiSmoke', {
      call: (channel, input) => {
        if (!['smoke:status', 'smoke:scenarios', 'smoke:other-document', 'smoke:hold-compiler', 'smoke:guest-healthy', 'smoke:arm-stream', 'smoke:stream-status'].includes(channel))
          return Promise.reject(Error('Denied fixture operation'));
        return ipcRenderer.invoke(channel, input);
      },
    });`,
  )
  await build({
    configFile: join(desktop, 'vite.mdx-compiler.config.ts'),
    build: { outDir: join(appDir, 'out/mdx-compiler'), emptyOutDir: true },
  })
  const appMetadata = {
    name: 'holi-mdx-diagnostics-native-smoke-665',
    version: '0.0.0',
    main: 'main.cjs',
  }
  await writeFile(join(appDir, 'package.json'), JSON.stringify(appMetadata))
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar')
  const artifact = join(root, 'app.asar')
  await asar.createPackage(appDir, artifact)
  const packaged = await asar.listPackage(artifact)
  for (const path of ['/out/mdx-compiler/guest.html', '/out/mdx-compiler/guest.js'])
    assert(packaged.includes(path), `packaged app.asar missing production compiler asset ${path}`)
  checks.push('production compiler assets present in app.asar')

  shutdown.signal.throwIfAborted()
  if (buildOnly) outcome = 'built, not executed'
  else {
    // Don't invoke Electron's lazy installer (or its environment overrides) from the smoke runner.
    const installed = dirname(require.resolve('electron/package.json'))
    const binary = await readFile(join(installed, 'path.txt'), 'utf8').catch(() => null)
    assert(binary, 'Install the workspace Electron binary before running native acceptance')
    await runNative(join(installed, 'dist', binary.trim()), artifact)
  }
} catch (error) {
  logs += `\nSMOKE ERROR: ${error?.stack ?? error}\n`
  throw error
} finally {
  await finalize()
}

async function runNative(electron, artifact) {
  const port = await freePort()
  shutdown.signal.throwIfAborted()
  child = owned.start(
    electron,
    [artifact, `--remote-debugging-port=${port}`, '--disable-background-networking'],
    {
      env: { ...childEnv, HOLI_MDX_SMOKE_PROFILE: profile, HOLI_MDX_SMOKE_VAULT: vault },
    },
  )
  let exited
  child.exited.then(
    (status) => {
      exited = status
    },
    () => {
      exited = { code: 'spawn error' }
    },
  )
  const version = await waitFor(async () => {
    if (exited) return { childExited: exited }
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    return response.ok ? response.json() : null
  }, 'packaged Electron DevTools')
  assert(
    !version.childExited,
    `Packaged Electron exited before DevTools were available (${version.childExited?.code})`,
  )
  const debugEndpoint = new URL(version.webSocketDebuggerUrl)
  assert(
    debugEndpoint.protocol === 'ws:' && debugEndpoint.host === `127.0.0.1:${port}`,
    'Not the isolated DevTools endpoint',
  )
  socket = new WebSocket(debugEndpoint)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let onCdpEvent = () => {}
  cdp = createCdpClient(socket, { timeoutMs: 90000, onEvent: (event) => onCdpEvent(event) })
  const entryUrl = pathToFileURL(join(artifact, 'renderer/index.html')).href
  const targets = await waitFor(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (target) => target.type === 'page' && target.url === entryUrl,
      ),
    'fixture editor page',
  )
  const page = await cdp.attach(targets.id)
  const evaluate = page.evaluate
  await page.call('Runtime.enable')
  await waitFor(
    () => evaluate(`!!window.__mdxSmoke && !!document.querySelector('.cm-editor')`),
    'production CodeMirror editor',
  )
  const isolation = await windowStatus(page)
  runtime = isolation.runtime
  assert.equal(isolation.userData, join(profile, 'userData'))
  assert.equal(isolation.sessionData, join(profile, 'sessionData'))
  assert.equal(isolation.vault, vault)
  assert.equal(isolation.appPath, artifact)
  assert(isolation.compilerAssets.every((asset) => asset.bytes > 0))
  assert.equal(
    await evaluate(
      `typeof require==='undefined' && typeof process==='undefined' && !window.__TAURI__ && !window.ipcRenderer && !window.electron && typeof window.holi?.trpc === 'function'`,
    ),
    true,
    'renderer exposed privileged globals',
  )
  assert.equal(await evaluate('sessionStorage.length'), 0)
  await evaluate(`localStorage.setItem('holi-native-default-credential-507', 'synthetic-only')`)
  checks.push('isolated profile and vault', 'production renderer has no privileged globals')

  const click = (label) =>
    evaluate(
      `(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()===${JSON.stringify(label)}); if(!button) throw Error('missing button '+${JSON.stringify(label)}); button.click(); return true })()`,
    )
  await waitFor(
    () =>
      evaluate(
        `document.body.innerText.includes('Review MDX trust') && document.querySelector('.cm-editor')`,
      ),
    'production MDX FileView and trust control',
  )
  await click('Review MDX trust')
  await waitFor(
    () =>
      evaluate(
        `!![...document.querySelectorAll('button')].find((item)=>item.textContent.trim()==='Approve vault')`,
      ),
    'production MDX approval dialog',
  )
  const preApproval = await windowStatus(page)
  assert.equal(preApproval.guestCreations, 0, 'compiler guest existed before approval')
  assert.equal(preApproval.inspectedSources, 0, 'source was delivered before approval')
  assert.equal(preApproval.guestProbes.length, 0, 'compiler guest was probed before approval')
  for (const field of ['dns', 'socket'])
    assert.equal(preApproval.network[field], isolation.network[field])
  assert.equal(preApproval.network.requests.length, 0)
  requireOnlyDestinations(preApproval.network, isolation.network, [], 'before vault trust')
  await click('Approve vault')
  const guest = await waitFor(async () => {
    const state = await windowStatus(page)
    return state.guestProbes?.find(
      (probe) => probe.url === 'https://mdx-compiler.invalid/guest.html',
    )
  }, 'actual isolated compiler guest probe')
  assert.deepEqual(guest.result.globals, {
    process: 'undefined',
    require: 'undefined',
    holi: 'undefined',
    electron: 'undefined',
    bridge: 'undefined',
  })
  assert.deepEqual(guest.result.storage, { hasCookies: false, local: 0, session: 0 })
  assert.equal(
    guest.result.hasCredentialMarker,
    false,
    'default-session fixture credential leaked into compiler guest',
  )
  checks.push('actual compiler guest has no privileged globals or session data')
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>/^\\d+ MDX diagnostic/.test(el.textContent.trim()))`,
      ),
    'production FileView compiler diagnostic',
  )
  const diagnostic = await evaluate(
    `JSON.stringify({source:window.__mdxSmoke.source(),message:[...document.querySelectorAll('[aria-live="polite"]')].map((el)=>el.textContent).find((text)=>/^\\d+ MDX diagnostic/.test(text.trim())),underlines:document.querySelectorAll('.cm-lintRange-error').length,classes:[...document.querySelectorAll('.cm-editor *')].map((node)=>node.className?.baseVal??node.className).filter((name)=>String(name).includes('lint')||String(name).includes('diagnostic'))})`,
  ).then(JSON.parse)
  positionedDiagnostics = await evaluate('window.__mdxSmoke.diagnostics()')
  assert.equal(positionedDiagnostics.length, 1)
  assert.equal(positionedDiagnostics[0].line, 3)
  assert.equal(positionedDiagnostics[0].column, 14)
  assert.match(positionedDiagnostics[0].message, /expression|acorn/i)
  await saveScreenshot(page, 'diagnostics-light.png')
  await evaluate(`window.__mdxSmoke.theme('dark')`)
  await evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  )
  await evaluate(
    `Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`,
  )
  await saveScreenshot(page, 'diagnostics-dark.png')
  assert(diagnostic.source.includes('Café 🪿'), 'Unicode source was changed')
  assert(
    diagnostic.message.includes('MDX diagnostic'),
    'production editor did not display a compiler diagnostic',
  )
  assert(
    diagnostic.underlines > 0,
    `production editor diagnostic has no underline: ${JSON.stringify(diagnostic.classes)}`,
  )
  checks.push(
    'approval awaited before actual production FileView diagnostics',
    'Unicode diagnostic shown in production FileView',
  )

  const vaultRoot = isolation.vault
  const editAndWaitForSave = async (source, label) => {
    await evaluate(`window.__mdxSmoke.setSource(${JSON.stringify(source)})`)
    await waitFor(
      async () => (await readFile(join(vaultRoot, 'notes/fixture.mdx'), 'utf8')) === source,
      `${label} durable save`,
    )
  }
  await editAndWaitForSave('# Café 🪿\n\nA valid paragraph.\n', 'valid source')
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>el.textContent.includes('syntax is valid')) && document.querySelector('.cm-lintRange-error') === null`,
      ),
    'production editor clean compile',
  )
  await mkdir(join(vaultRoot, 'notes/graph'), { recursive: true })
  await writeFile(join(vaultRoot, 'notes/graph/root.jsx'), "export { value } from './nested.js'\n")
  await writeFile(join(vaultRoot, 'notes/graph/nested.js'), "export { value } from './leaf.js'\n")
  await writeFile(join(vaultRoot, 'notes/graph/leaf.js'), 'export const value = 1\n')
  await editAndWaitForSave(
    "import { value } from './graph/root.jsx'\n\nA valid graph.\n",
    'dependency graph',
  )
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>el.textContent.includes('syntax is valid')) && document.querySelector('.cm-lintRange-error') === null`,
      ),
    'production diagnostics accept a nested MDX to JavaScript dependency graph',
  )
  checks.push(
    'nested MDX-to-JavaScript static dependency graph accepted through production FileView',
  )
  const hostile =
    "import Evil from 'file:///etc/passwd'\n\n{globalThis.__mdxSmokeExecuted = true}\n"
  await editAndWaitForSave(hostile, 'hostile source')
  await waitFor(
    () =>
      evaluate(
        `window.__mdxSmoke.diagnostics().some((item)=>/dependency|file|module/i.test(item.message))`,
      ),
    'hostile file dependency is rejected with a diagnostic',
  )
  assert(
    (await evaluate('window.__mdxSmoke.diagnostics()')).length > 0,
    'hostile dependency produced no diagnostic',
  )
  assert.equal(
    await evaluate(`globalThis.__mdxSmokeExecuted===true`),
    false,
    'compiled MDX expression was evaluated in FileView',
  )
  checks.push(
    'valid source clean',
    'hostile MDX dependency refused',
    'hostile MDX expression not evaluated by the renderer',
  )
  for (const [label, source] of [
    ['missing dependency', "import './graph/missing.jsx'\n"],
    ['protected dependency', "import './graph/secret.local.jsx'\n"],
    ['external dependency', "import 'https://example.invalid/module.js'\n"],
  ]) {
    await editAndWaitForSave(source, `${label} editable source`)
    await waitFor(
      () => evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      `${label} diagnostic`,
    )
    assert.equal(await readFile(join(vaultRoot, 'notes/fixture.mdx'), 'utf8'), source)
    checks.push(`${label}: FileView source remains editable and saved`)
  }
  await editAndWaitForSave('# recovered source\n', 'source recovery after dependency refusals')
  await waitFor(() => cleanDiagnostics(page), 'clean editor before separate local scenarios')
  assert.equal(
    await evaluate('window.__mdxSmoke.errors.length'),
    0,
    'fixture renderer reported runtime errors',
  )

  nativeScenarios = await evaluate(`window.holiSmoke.call('smoke:scenarios')`)
  assert(nativeScenarios.policy.executionChecks > 0)
  assert.equal(nativeScenarios.policy.outboundRequests, 0)
  assert.equal(nativeScenarios.recovery.crashRejected, true)
  assert.equal(nativeScenarios.recovery.timeoutRejected, true)
  assert.equal(nativeScenarios.recovery.recovered, true)
  assert.deepEqual(
    nativeScenarios.stale.map((item) => item.name).sort(),
    [
      'queued ownership revocation and in-flight release',
      'source generation cancellation',
      'view release',
      'trust revoke and reapproval',
      'account A–B–A',
      'vault A–B–A',
      'native filesystem replacement watcher',
    ].sort(),
  )
  assert(Array.isArray(nativeScenarios.graphCases) && nativeScenarios.graphCases.length >= 8)
  checks.push(
    ...nativeScenarios.graphCases.map((item) => `native graph ${item.name}: ${item.outcome}`),
  )
  checks.push(
    'real guest policy denies network, files, app URLs, popup, permission, media, navigation and download traffic',
    'real guest compiled output was not evaluated and storage was cleared',
    'real guest crash and deadline recover with fresh successful compilations',
    ...nativeScenarios.stale.map((item) => `native held compile rejects stale ${item.name}`),
  )
  await runExternal(page, editAndWaitForSave, (handler) => {
    onCdpEvent = handler
  })
  assert.equal(
    await evaluate('window.__mdxSmoke.errors.length'),
    0,
    'fixture renderer reported runtime errors',
  )
  outcome = 'passed'
}

async function runExternal(page, editAndWaitForSave, onEvent) {
  const remote = 'fixture/isolated-mdx'
  const probePath = 'notes/probe.mdx'
  const [rawOrigin, redirectOrigin, cdnOrigin] = fixtureOrigins
  const publicEntry = `${rawOrigin}/syv-ai/holi/${fixtureSha}/apps/desktop/scripts/fixtures/mdx-external/entry.js`
  const source = `import '${publicEntry}'\n\n# External diagnostics fixture\n`
  const allow = (origin) => `Allow ${origin}`
  const deny = (origin) => `Deny ${origin}`
  const revoke = (origin) => `Revoke ${origin}`
  const trigger = 'MDX resources'
  const parts = ['entry', 'relative', 'redirect', 'cdn']
  const button = (label) =>
    page.evaluate(`(() => {
    const match = Array.from(document.querySelectorAll('button,[role="button"]')).find(item =>
      (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(label)} &&
      !item.closest('[aria-hidden="true"],[inert]') && item.getClientRects().length &&
      getComputedStyle(item).visibility === 'visible' && !item.matches(':disabled,[aria-disabled="true"]'));
    if (!match) return null;
    const {x, y, width, height} = match.getBoundingClientRect();
    return {x: x + width / 2, y: y + height / 2};
  })()`)
  const clickAt = async (point) => {
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await page.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    await page.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    })
  }
  const click = async (label) => clickAt(await waitFor(() => button(label), label))
  const openResources = (expected) =>
    waitFor(async () => {
      if (await button(expected)) return true
      // Mutations may close the panel or leave it open while state refreshes.
      const open = await page.evaluate(`Array.from(document.querySelectorAll('button')).some(item =>
        (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(trigger)} &&
        (item.getAttribute('aria-expanded') === 'true' || item.getAttribute('data-state') === 'open'))`)
      const point = !open && (await button(trigger))
      if (point) await clickAt(point)
      return false
    }, expected)
  const ready = () =>
    waitFor(
      () => page.evaluate('!!window.__mdxSmoke && !!document.querySelector(".cm-editor")'),
      'current FileView document',
    )
  const wire = (name, input, type = 'mutation') => ({ path: `mdxTrust.${name}`, type, input })
  const rpc = (operation) => page.evaluate(`window.holi.trpc(${JSON.stringify(operation)})`)
  const call = async (name, input, type) => {
    const response = await rpc(wire(name, input, type))
    assert(response?.ok, `${name} refused by the application router`)
    return response.data
  }
  const refuse = async (response, label, message) => {
    const result = await response
    assert(result?.ok === false && message.test(result.message), label)
  }
  const staleResource = /MDX (?:lease|resource request) unavailable|MDX context changed/i
  const cancelled = /cancel|supersed|unavailable|invalidated/i
  const probeLease = async () => {
    const { context } = await call('status', { remote }, 'query')
    assert(context, 'Current trusted document has no context')
    return (await call('acquireDiagnosticsLease', { remote, context, path: probePath })).lease
  }
  const pending = async (lease, generation) => {
    const diagnostics = await call('compile', { lease, generation, source })
    assert(diagnostics.length > 0, 'An unapproved graph must report diagnostics')
    const state = await call('externalResources', { lease }, 'query')
    assert.equal(state.generation, generation)
    assert.deepEqual(
      state.pending.map(({ origin }) => origin),
      [rawOrigin],
    )
    assert.equal(state.approved.length, 0)
    assert(state.pending[0].purpose, 'The server did not describe the purpose')
    return state.pending[0].id
  }
  const capture = async (stage) => {
    const status = await windowStatus(page)
    external.snapshots[stage] = { ...status.network, pushes: status.resourcePushes }
    return external.snapshots[stage]
  }
  const noNewTraffic = (before, after, label) => {
    for (const field of ['dns', 'socket'])
      assert.equal(after[field], before[field], `${label}: ${field} activity`)
    assert.equal(after.requests.length, before.requests.length, `${label}: HTTP activity`)
    requireOnlyDestinations(after, before, [], label)
  }
  const requireRoutes = (snapshot, start, allowed) => {
    const sent = snapshot.requests.slice(start.requests.length)
    assert(
      sent.every(({ route, get, credentials }) => allowed.includes(route) && get && !credentials),
      'An unapproved route or credential-bearing/non-GET request reached Node HTTPS',
    )
    assert.deepEqual(
      [...new Set(sent.map(({ route }) => route))].sort(),
      [...allowed].sort(),
      'Expected production HTTPS requests were not observed',
    )
  }
  const requireResponse = (snapshot, route, test) => {
    assert(
      snapshot.responses.some((entry) => entry.route === route && test(entry.status)),
      `No expected public HTTPS response for ${route}`,
    )
  }

  try {
    external.stage = 'pre-consent and denial'
    const isolated = await windowStatus(page)
    assert.equal(isolated.ambientCookieHosts, 3)
    const before = await capture('beforeEditing')
    await editAndWaitForSave(source, 'unapproved external source')
    await openResources(allow(rawOrigin))
    await waitFor(
      () => page.evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      'unapproved external import diagnostic',
    )
    await page.evaluate(`window.__mdxSmoke.theme('light')`)
    await settledPaint(page)
    await saveScreenshot(page, 'resources-light.png')
    await page.evaluate(`window.__mdxSmoke.theme('dark')`)
    await settledPaint(page)
    await saveScreenshot(page, 'resources-dark.png')
    await click(deny(rawOrigin))
    await waitFor(
      async () => !(await button(allow(rawOrigin))),
      'denied origin no longer actionable',
    )
    noNewTraffic(
      before,
      await capture('denied'),
      'vault trust and explicit denial do not authorize the public origin',
    )
    checks.push(
      'unapproved source remains editable and saved with zero observed Node DNS, socket and HTTP activity',
      'production resource denial does not authorize traffic',
    )

    external.stage = 'stale requests and application ownership'
    let lease = await probeLease()
    let requestId = await pending(lease, 1)
    const approval = () => wire('approveExternalResource', { lease, requestId })
    await refuse(
      page.evaluate(`window.holiSmoke.call('smoke:other-document', ${JSON.stringify(approval())})`),
      'A different native document could use the current view approval',
      /only to the current Holi application document/i,
    )
    await call('cancelCompile', { lease, generation: 2 })
    await refuse(rpc(approval()), 'An older source generation could be approved', staleResource)
    requestId = await pending(lease, 2)
    const write = await rpc({
      path: 'notes.write',
      type: 'mutation',
      input: { remote, path: probePath, text: '# Changed on disk\n' },
    })
    assert(write?.ok, 'The probe source was not saved through the router')
    await refuse(
      rpc(approval()),
      'The previous saved source could still be approved',
      staleResource,
    )
    lease = await probeLease()
    requestId = await pending(lease, 1)
    const retiredDocument = approval()
    await page.call('Page.enable')
    await page.call('Page.reload')
    await waitFor(
      () => page.evaluate('performance.getEntriesByType("navigation")[0]?.type === "reload"'),
      'new native application document',
    )
    await ready()
    await refuse(
      rpc(retiredDocument),
      'A reloaded application document could approve an old request',
      staleResource,
    )
    await openResources(allow(rawOrigin))
    noNewTraffic(before, await capture('staleRequests'), 'stale or wrong native ownership')
    checks.push(
      'wrong native document, superseded generation, saved-source replacement and document reload refuse stale approval IDs',
    )

    external.stage = 'relative and transitive graph'
    await click(allow(rawOrigin))
    await openResources(allow(redirectOrigin))
    const allowTransitive = await waitFor(
      () => button(allow(redirectOrigin)),
      'transitive approval',
    )
    const transitive = await capture('transitiveConsentPending')
    requireOnlyDestinations(transitive, before, [rawOrigin], 'before transitive origin consent')
    requireTransport(transitive, before, [rawOrigin])
    requireRoutes(transitive, before, ['entry', 'relative'])
    for (const route of ['entry', 'relative'])
      requireResponse(transitive, route, (code) => code === 200)
    assert(transitive.pushes > before.pushes, 'Production approval did not push invalidation')
    checks.push(
      'approved HTTPS entry and relative child fetched; zero observed Node DNS, TLS/socket or HTTP for the transitive origin, redirect target or unexpected/unattributed traffic',
    )

    external.stage = 'cross-origin redirect'
    await clickAt(allowTransitive)
    await openResources(allow(cdnOrigin))
    const video = recordVideo ? await startVideo(page, onEvent) : null
    if (video) await delay(700)
    const allowRedirectTarget = await waitFor(
      () => button(allow(cdnOrigin)),
      'redirect target approval',
    )
    const redirect = await capture('redirectConsentPending')
    requireOnlyDestinations(
      redirect,
      transitive,
      [rawOrigin, redirectOrigin],
      'before redirect target consent',
    )
    requireTransport(redirect, transitive, [rawOrigin, redirectOrigin])
    requireRoutes(redirect, transitive, ['entry', 'relative', 'redirect'])
    requireResponse(redirect, 'redirect', (code) => [301, 302, 303, 307, 308].includes(code))
    checks.push(
      'actual HTTPS redirect discovered a new origin with zero observed Node DNS, TLS/socket or HTTP for it or unexpected/unattributed traffic',
    )

    external.stage = 'approved dependency success'
    await clickAt(allowRedirectTarget)
    await waitFor(
      () => cleanDiagnostics(page),
      'clean FileView diagnostics after approval of all three public origins',
    )
    const approved = await capture('allApproved')
    const origins = [rawOrigin, redirectOrigin, cdnOrigin]
    requireOnlyDestinations(approved, redirect, origins, 'after all origins approved')
    requireTransport(approved, redirect, origins)
    requireRoutes(approved, redirect, parts)
    requireResponse(approved, 'cdn', (code) => code === 200)
    assert(approved.pushes > redirect.pushes, 'Final approval did not push invalidation')
    assert.equal(
      await page.evaluate('globalThis.__mdxSmokeExecuted === undefined'),
      true,
      'External fixture code executed in FileView',
    )
    assert.equal(
      await page.evaluate(`window.holiSmoke.call('smoke:guest-healthy')`),
      true,
      'The compiler guest policy probe failed during external diagnostics',
    )
    checks.push(
      'all three approved origins produced clean diagnostics with no cookie, authorization or proxy-authorization headers on observed Node HTTPS requests',
    )

    external.stage = 'userinfo rejection and pre-transport revoke'
    lease = await probeLease()
    const credentialUrl = publicEntry.replace('https://', 'https://synthetic-user:synthetic-only@')
    const unsafe = await call('compile', {
      lease,
      generation: 1,
      source: `import '${credentialUrl}'`,
    })
    assert(unsafe.length > 0, 'A credential-bearing URL was accepted')
    assert.equal((await call('externalResources', { lease }, 'query')).pending.length, 0)
    noNewTraffic(approved, await capture('userinfoRejected'), 'credential-bearing URL')
    checks.push(
      'URL userinfo is rejected even for an approved origin without observed Node DNS, socket or HTTP activity',
    )

    await openResources(revoke(rawOrigin))
    if (video) await delay(700)
    const held = wire('compile', { lease, generation: 2, source })
    await page.evaluate(`(async () => {
      const ready = window.holiSmoke.call('smoke:hold-compiler');
      window.__mdxHeld = window.holi.trpc(${JSON.stringify(held)});
      return ready;
    })()`)
    await click(revoke(rawOrigin))
    await refuse(
      page.evaluate('window.__mdxHeld'),
      'The native compile held before transport returned stale diagnostics',
      cancelled,
    )
    await openResources(allow(rawOrigin))
    const revoked = await capture('originRevoked')
    noNewTraffic(
      approved,
      revoked,
      'revoked origin including in-flight native compiler and pushed retry',
    )
    assert(revoked.pushes > approved.pushes, 'Revocation did not push invalidation')
    assert.equal(await button(revoke(rawOrigin)), null, 'Revoked origin still appeared granted')
    const remaining = await call('externalResources', { lease }, 'query')
    assert.deepEqual(remaining.approved.map(({ origin }) => origin).sort(), [
      cdnOrigin,
      redirectOrigin,
    ])
    await waitFor(
      () => page.evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      'diagnostic restored after revocation',
    )
    await saveScreenshot(page, 'resources-revoked.png')
    if (video) await delay(700)
    await call('releaseDiagnosticsLease', { lease })
    await editAndWaitForSave(
      '# Editable after resource revocation\n',
      'source after resource revocation',
    )
    await waitFor(
      () => cleanDiagnostics(page),
      'local diagnostics remain usable after resource revocation',
    )
    assert.equal(
      await page.evaluate(
        'window.__mdxSmoke.source() === "# Editable after resource revocation\\n"',
      ),
      true,
    )
    checks.push(
      'revocation cancels a held native compiler before transport; push restores the request without traffic and editing/saving still work',
    )
    external.stage = 'client-side HTTPS stream revocation'
    // The FileView is on a clean local source; the probe lease streams using
    // the same account/vault approval while the real revoke control stays ready.
    await openResources(revoke(cdnOrigin))
    if (video) await delay(700)
    lease = await probeLease()
    const streamUrl = await page.evaluate(`window.holiSmoke.call('smoke:arm-stream')`)
    const observeStream = () => page.evaluate(`window.holiSmoke.call('smoke:stream-status')`)
    const beforeStream = await capture('beforeStream')
    const streaming = wire('compile', { lease, generation: 1, source: `import '${streamUrl}'` })
    const streamEvidence = {
      backpressure:
        'Fixture paused one real TLS socket after a buffered body chunk, suppressing socket resumes until close; client-side evidence only',
      beforeRevoke: null,
      afterRevoke: null,
      compileRejected: false,
    }
    external.streamRevocation = streamEvidence
    const started = performance.now()
    await page.evaluate(
      `void (window.__mdxStreaming = window.holi.trpc(${JSON.stringify(streaming)}))`,
    )
    try {
      await waitFor(
        async () => {
          const observed = await observeStream()
          return (observed?.active || observed?.closed) && observed
        },
        'authorized TLS socket with a buffered incomplete response',
        6500,
      )
      const point = await button(revoke(cdnOrigin))
      assert(point, 'The FileView revoke control is not actionable while the probe streams')
      streamEvidence.beforeRevoke = await observeStream()
      assert(
        streamEvidence.beforeRevoke?.active && streamEvidence.beforeRevoke.requests === 1,
        'Did not observe exactly one active, paused HTTPS stream at the revoke click',
      )
      await clickAt(point)
      streamEvidence.afterRevoke = await waitFor(
        async () => {
          const observed = await observeStream()
          return observed?.closed && observed
        },
        'revocation-driven TLS socket close',
        2000,
      )
      // Do not credit an AbortError/close from the independent 8-second fetch deadline.
      streamEvidence.closeObservedWithinMs = Math.ceil(performance.now() - started)
      assert(
        streamEvidence.closeObservedWithinMs < 8000,
        'Closure was not observed before the transport deadline',
      )
      assert(streamEvidence.afterRevoke.abortError, 'Client transport reported no AbortError')
      assert(
        streamEvidence.afterRevoke.incompleteAtClose,
        'HTTPS response completed instead of being cancelled',
      )
      await refuse(
        page.evaluate('window.__mdxStreaming'),
        'The native compile streaming over HTTPS returned stale diagnostics',
        cancelled,
      )
      streamEvidence.compileRejected = true
    } finally {
      streamEvidence.lastObservation = await observeStream().catch(() => null)
    }

    const retrySource = `import '${streamUrl}'\n\n# Stalled stream retry requires consent\n`
    await editAndWaitForSave(retrySource, 'source after streaming origin was revoked')
    await openResources(allow(cdnOrigin))
    const streamRevoked = await capture('streamOriginRevoked')
    requireOnlyDestinations(
      streamRevoked,
      beforeStream,
      [cdnOrigin],
      'HTTPS stream and revoked retry',
    )
    requireTransport(streamRevoked, beforeStream, [cdnOrigin])
    requireRoutes(streamRevoked, beforeStream, ['stream'])
    for (const field of ['resolve4', 'resolve6', 'tls', 'httpCreated', 'httpStarted']) {
      assert.equal(
        streamRevoked.destinations[cdnOrigin][field] - beforeStream.destinations[cdnOrigin][field],
        1,
        `More than one operation for the streamed or revoked origin: ${field}`,
      )
    }
    assert(
      streamRevoked.pushes > beforeStream.pushes,
      'Stream revocation did not push invalidation',
    )
    assert.deepEqual(
      (await call('externalResources', { lease }, 'query')).approved.map(({ origin }) => origin),
      [redirectOrigin],
    )
    await saveScreenshot(page, 'resources-stream-revoked.png')
    checks.push(
      'FileView revocation aborts a real authorized HTTPS stream stalled by forced client backpressure, closes its socket before response completion/deadline, rejects the compile, and prevents a subsequent fetch',
    )
    await call('releaseDiagnosticsLease', { lease })
    if (video) {
      await delay(700)
      await video()
    }
    external.stage = 'complete'
  } finally {
    // Preserve only bounded counts and booleans even on public DNS/CDN failures.
    await capture('finalObservation').catch(() => {})
  }
}

function requireOnlyDestinations(current, baseline, allowed, label) {
  const destinations = [...fixtureOrigins, 'unexpected', 'unattributed']
  for (const destination of destinations) {
    assert(current.destinations?.[destination], `${label}: destination observation unavailable`)
    if (!allowed.includes(destination)) {
      assert.deepEqual(
        current.destinations[destination],
        baseline.destinations[destination],
        `${label}: unexpected Node network activity for ${destination}`,
      )
    }
  }
  for (const [field, total] of [
    ['dnsResources', current.dns],
    ['socketResources', current.socket],
    ['httpStarted', current.requests.length],
  ]) {
    assert.equal(
      destinations.reduce((sum, origin) => sum + current.destinations[origin][field], 0),
      total,
      `${label}: ${field} observations do not account for the aggregate`,
    )
  }
}

function requireTransport(current, baseline, origins) {
  for (const origin of origins) {
    for (const field of [
      'resolve4',
      'resolve6',
      'dnsResources',
      'socketResources',
      'tls',
      'verifiedPeer',
      'httpCreated',
      'httpStarted',
    ]) {
      assert(
        current.destinations[origin]?.[field] > baseline.destinations[origin]?.[field],
        `Actual ${field} observation unavailable for ${origin}`,
      )
    }
    const now = current.destinations[origin]
    const before = baseline.destinations[origin]
    assert.equal(
      now.verifiedPeer - before.verifiedPeer,
      now.tls - before.tls,
      `Not all TLS connections for ${origin} had a verified matching peer`,
    )
  }
}

function cleanDiagnostics(page) {
  return page.evaluate(`
    [...document.querySelectorAll('[aria-live="polite"]')].some(el => el.textContent.includes('syntax is valid')) &&
    window.__mdxSmoke.diagnostics().length === 0
  `)
}

async function settledPaint(page) {
  await page.evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  )
}

async function startVideo(page, onEvent) {
  const frames = []
  let firstTime
  onEvent(({ method, params }) => {
    if (method !== 'Page.screencastFrame') return
    void page.call('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    const time = params.metadata.timestamp
    firstTime ??= time
    if (frames.length < 500)
      frames.push({ image: Buffer.from(params.data, 'base64'), timestamp: time - firstTime })
  })
  await page.call('Page.startScreencast', {
    format: 'png',
    maxWidth: 960,
    maxHeight: 720,
    everyNthFrame: 2,
  })
  return async () => {
    await page.call('Page.stopScreencast')
    onEvent(() => {})
    assert(frames.length >= 3, 'Only a few actual Chromium frames were captured')
    const filename = 'resources-approval-revoke.webm'
    await encodeScreencast(frames, {
      root,
      evidence,
      filename,
      run: (file, args, options) => spawnSync(file, args, { ...options, env: childEnv }),
    })
    assert((await stat(join(evidence, filename))).size > 0)
    evidenceFiles.push(filename)
  }
}

async function finalize() {
  process.removeListener('SIGINT', interrupted)
  process.removeListener('SIGTERM', interrupted)
  cdp?.close()
  socket?.close()
  const steps = await Promise.allSettled([
    (async () => {
      await owned.stopAll()
      cleanup.processGroupGone = true
      await rm(root, { recursive: true, force: true })
      cleanup.temporaryRootRemoved = true
    })(),
    (async () => {
      if (portServer.listening) {
        await new Promise((resolve, reject) =>
          portServer.close((error) => (error ? reject(error) : resolve())),
        )
      }
      cleanup.parentPortClosed = !portServer.listening
    })(),
  ])
  if (steps.some((step) => step.status === 'rejected')) outcome = 'failed'
  const diagnosticLog = ((child?.output ?? '') + logs).replace(
    /ws:\/\/127\.0\.0\.1:\d+\/devtools\/\S+/g,
    '[local DevTools endpoint]',
  )
  await writeFile(join(evidence, 'electron-smoke.log'), diagnosticLog)
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        issue: 665,
        outcome,
        checks: { passed: checks.length, names: checks },
        nativeScenarios,
        external: { ...external, fixtureSha: fixtureSha ?? null },
        runtime,
        positionedDiagnostics,
        artifact: 'unsigned Electron app.asar',
        cleanup,
        retained: {
          processGroups: owned.remainingPids,
          temporaryRoot: cleanup.temporaryRootRemoved ? null : root,
        },
        resources: {
          temporaryRoot: root,
          userData: join(profile, 'userData'),
          sessionData: join(profile, 'sessionData'),
          vault,
          appAsar: join(root, 'app.asar'),
        },
        evidence: evidenceFiles,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`MDX fixture evidence: ${evidence}`)
  if (steps.some((step) => step.status === 'rejected')) throw new Error('Fixture cleanup failed')
}

async function windowStatus(page) {
  return await page.evaluate(`window.holiSmoke.call('smoke:status')`)
}
async function saveScreenshot(page, name) {
  const { data } = await page.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(evidence, name), Buffer.from(data, 'base64'))
  evidenceFiles.push(name)
}
