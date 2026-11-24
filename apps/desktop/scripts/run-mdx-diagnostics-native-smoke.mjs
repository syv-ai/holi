import { runLocalNativeAcceptance } from './mdx-local-native-smoke.mjs'
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
import { runExternalNativeAcceptance } from './mdx-external-native-smoke.mjs'
import { createMdxSmokeUi } from './mdx-native-smoke-ui.mjs'
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
const ui = createMdxSmokeUi(shutdown.signal)
const { waitFor, windowStatus } = ui
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
    let denialReceipt = null;
    contextBridge.exposeInMainWorld('holi', {
      trpc: async (op) => {
        const isDenial = op?.path === 'mdxTrust.rejectExternalResource';
        if (isDenial) denialReceipt = null;
        const response = await ipcRenderer.invoke('holi:trpc', op);
        if (isDenial) denialReceipt = { ok: response?.ok === true && response?.data?.ok === true };
        return response;
      },
      plugin: { on: (id, cb) => {
        if (id !== resourceEvents) return () => {};
        subscribers.add(cb);
        return () => { subscribers.delete(cb); };
      } },
    });
    contextBridge.exposeInMainWorld('holiSmoke', {
      denialReceipt: () => denialReceipt,
      call: (channel, input) => {
        if (!['smoke:status', 'smoke:scenarios', 'smoke:other-document', 'smoke:hold-compiler', 'smoke:guest-healthy', 'smoke:arm-stream', 'smoke:stream-status', 'smoke:start-error-page-race', 'smoke:error-page-result'].includes(channel))
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

  const local = await runLocalNativeAcceptance(page, {
    isolation,
    checks,
    report: external,
    ui,
    captureScreenshot: (name) => saveScreenshot(page, name),
  })
  positionedDiagnostics = local.positionedDiagnostics
  nativeScenarios = local.nativeScenarios
  const { editAndWaitForSave } = local
  await runExternalNativeAcceptance(page, {
    artifact,
    fixtureSha,
    checks,
    report: external,
    ui,
    editAndWaitForSave,
    captureScreenshot: (name) => saveScreenshot(page, name),
    record: recordVideo
      ? () =>
          startVideo(page, (handler) => {
            onCdpEvent = handler
          })
      : null,
    appendLog: (message) => {
      logs += message
    },
  })
  assert.equal(
    await evaluate('window.__mdxSmoke.errors.length'),
    0,
    'fixture renderer reported runtime errors',
  )
  outcome = 'passed'
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
async function saveScreenshot(page, name) {
  const { data } = await page.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(evidence, name), Buffer.from(data, 'base64'))
  evidenceFiles.push(name)
}
