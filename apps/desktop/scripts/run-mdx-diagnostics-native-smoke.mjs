import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { externalizeDepsPlugin } from 'electron-vite'
import { createCdpClient } from './native-smoke-cdp.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-507-mdx-diagnostics-evidence')
const root = await mkdtemp(join(tmpdir(), 'holi-507-native-'))
const profile = join(root, 'profile')
const vault = join(root, 'vault')
const appDir = join(root, 'app')
let child
let socket
let cdp
let logs = ''
let outcome = 'failed'
const checks = []
const portServer = createServer()
await mkdir(evidence, { recursive: true })
for (const name of [
  'result.json',
  'electron-smoke.log',
  'diagnostics-light.png',
  'diagnostics-dark.png',
])
  await rm(join(evidence, name), { force: true })

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
function ownedKill(signal) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}
async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
async function waitFor(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

try {
  await mkdir(evidence, { recursive: true })
  await mkdir(vault, { recursive: true })
  await mkdir(join(appDir, 'renderer'), { recursive: true })
  await writeFile(join(vault, 'notes', 'fixture.mdx'), '# fixture\n', { flag: 'w' }).catch(
    async () => {
      await mkdir(join(vault, 'notes'), { recursive: true })
      await writeFile(join(vault, 'notes', 'fixture.mdx'), '# fixture\n')
    },
  )

  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@/lib/trpc': join(desktop, 'scripts/mdx-diagnostics-smoke-trpc.ts') } },
    plugins: [react()],
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
    `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('holiSmoke', { call: (channel, input) => { if (!['smoke:status','smoke:trust','smoke:rotate','mdx:acquire','mdx:cancel','mdx:compile','mdx:release','smoke:replaceFile'].includes(channel)) return Promise.reject(Error('Denied fixture operation')); return ipcRenderer.invoke(channel, input) }, trust: (value) => ipcRenderer.invoke('smoke:trust', value) });`,
  )
  await build({
    configFile: false,
    root: desktop,
    build: {
      target: 'es2022',
      outDir: join(appDir, 'out/mdx-compiler'),
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'src/mdx-compiler/guest.html'),
        output: { entryFileNames: 'guest.js', format: 'iife', assetFileNames: '[name][extname]' },
      },
    },
  })
  const appMetadata = {
    name: 'holi-mdx-diagnostics-native-smoke-507',
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

  const electron = require('electron')
  const port = await freePort()
  const env = {
    ...process.env,
    HOLI_507_PROFILE: profile,
    HOLI_507_VAULT: vault,
    HOME: profile,
    USERPROFILE: profile,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [artifact, `--remote-debugging-port=${port}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  child.stdout.on('data', (chunk) => {
    logs += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
    process.stderr.write(chunk)
  })
  const childClosed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    return response.ok ? response.json() : null
  }, 'packaged Electron DevTools')
  socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  cdp = createCdpClient(socket, { timeoutMs: 5000 })
  const targets = await waitFor(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (target) => target.type === 'page',
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
  assert.equal(isolation.userData, join(profile, 'userData'))
  assert.equal(isolation.sessionData, join(profile, 'sessionData'))
  assert.equal(isolation.vault, vault)
  assert(isolation.compilerAssets.every((asset) => asset.bytes > 0))
  assert.equal(
    await evaluate(
      `typeof require==='undefined' && typeof process==='undefined' && !window.holi && !window.__TAURI__`,
    ),
    true,
    'renderer exposed privileged globals',
  )
  assert.equal(
    await evaluate(`sessionStorage.length`),
    0,
    'fixture started with nonempty session storage',
  )
  checks.push(
    'isolated userData/sessionData/HOME/vault',
    'renderer privilege globals absent',
    'fresh renderer session storage',
  )

  // The source is withheld until the fixture's explicit trust action.
  await delay(450)
  assert.equal(await evaluate(`window.__mdxSmoke.state.kind`), 'unavailable')
  await evaluate(`window.__mdxSmoke.setTrusted(true)`)
  await waitFor(
    () => evaluate(`window.__mdxSmoke.state.kind==='syntax-error'`),
    'real compiler diagnostics in production hook',
  )
  const diagnostic = await evaluate(
    `JSON.stringify({text:document.querySelector('[data-testid="diagnostic-message"]').textContent,source:window.__mdxSmoke.source,underlines:document.querySelectorAll('.cm-lintRange-error').length})`,
  ).then(JSON.parse)
  assert(diagnostic.text.length > 0, 'malformed Unicode MDX did not show a diagnostic')
  assert(diagnostic.source.includes('Café 🪿'), 'Unicode fixture source was altered')
  assert(diagnostic.underlines > 0, 'production editor did not render diagnostic underline')
  checks.push(
    'trust required before source compilation',
    'production MDX diagnostic shown in CodeMirror',
    'Unicode source retained',
  )
  await screenshot(page, join(evidence, 'diagnostics-light.png'))
  await evaluate(`document.documentElement.dataset.theme='dark'`)
  await screenshot(page, join(evidence, 'diagnostics-dark.png'))

  await evaluate(
    `window.__mdxSmoke.setSource(${JSON.stringify('# Café 🪿\\n\\nA valid paragraph.\\n')})`,
  )
  await waitFor(
    () => evaluate(`window.__mdxSmoke.state.kind==='clean'`),
    'clean production editor state',
  )
  await evaluate(
    `window.__mdxSmoke.setSource(${JSON.stringify("import Evil from 'file:///etc/passwd'\\n\\n{globalThis.__mdxSmokeExecuted = true}\\n")})`,
  )
  await waitFor(
    () =>
      evaluate(
        `window.__mdxSmoke.state.kind==='clean' || window.__mdxSmoke.state.kind==='syntax-error'`,
      ),
    'hostile MDX compile',
  )
  assert.equal(
    await evaluate(`globalThis.__mdxSmokeExecuted===true`),
    false,
    'MDX expression was executed',
  )
  assert.equal(
    await evaluate(`window.__mdxSmoke.state.kind==='clean'`),
    true,
    'valid hostile MDX did not compile cleanly',
  )
  checks.push('valid source clean', 'hostile MDX output was not evaluated')

  const probes = await evaluate(
    `(async()=>{const out={fetch:false,websocket:false,open:false,file:false,holi:false};try{await fetch('https://example.invalid/')}catch{out.fetch=true}navigator.sendBeacon('https://example.invalid/','x');try{const ws=new WebSocket('wss://example.invalid');out.websocket=await Promise.race([new Promise(r=>ws.addEventListener('error',()=>r(true),{once:true})),new Promise(r=>setTimeout(()=>r(ws.readyState===WebSocket.CLOSED),500))])}catch{out.websocket=true}out.open=window.open('https://example.invalid')===null;try{await fetch('file:///etc/passwd')}catch{out.file=true}try{await fetch('holi://vault/secret')}catch{out.holi=true}return out})()`,
  )
  assert(
    probes.fetch && probes.websocket && probes.open && probes.file && probes.holi,
    `network/window probes not denied: ${JSON.stringify(probes)}`,
  )
  const requestPolicy = await windowStatus(page)
  assert(requestPolicy.blockedRequests.some((request) => request.includes('example.invalid')))
  checks.push('fetch/beacon/websocket/pop-up/file/Holi-scheme probes denied by CSP/session policy')

  await evaluate(`window.holiSmoke.call('smoke:rotate')`)
  await evaluate(`window.__mdxSmoke.retry()`)
  await waitFor(
    () => evaluate(`window.__mdxSmoke.state.kind==='checking'`),
    'rotated account and vault generation',
  )
  await waitFor(
    () => evaluate(`window.__mdxSmoke.state.kind==='clean'`),
    'fresh production lease after generation change',
  )
  const rotated = await windowStatus(page)
  assert.equal(rotated.accountGeneration, 2)
  assert.equal(rotated.openRevision, 2)
  checks.push('stale account/vault/view generation lease replaced')

  await evaluate(`window.holiSmoke.call('smoke:replaceFile')`)
  await evaluate(
    `window.__mdxSmoke.setSource(${JSON.stringify('# Changed after external replacement\\n')})`,
  )
  await waitFor(
    () => evaluate(`window.__mdxSmoke.state.kind==='unavailable'`),
    'raw file replacement revokes active lease',
  )
  checks.push('external raw-file replacement revokes diagnostics lease')

  await page.call('Page.crash')
  const recoveredTarget = await waitFor(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (target) => target.type === 'page' && target.id !== targets.id,
      ),
    'actual renderer crash recovery',
  )
  const recoveredPage = await cdp.attach(recoveredTarget.id)
  await recoveredPage.call('Runtime.enable')
  await waitFor(
    () => recoveredPage.evaluate(`!!window.__mdxSmoke && !!document.querySelector('.cm-editor')`),
    'recovered fixture editor',
  )
  const recovered = await recoveredPage.evaluate(`window.holiSmoke.call('smoke:status')`)
  assert.equal(recovered.recoveredWindows, 1)
  checks.push('native renderer crash recovered with isolated editor')
  outcome = 'passed'
} catch (error) {
  logs += `\nSMOKE ERROR: ${error?.stack ?? error}\n`
  throw error
} finally {
  cdp?.close()
  socket?.close()
  if (child?.pid) {
    ownedKill('SIGTERM')
    await Promise.race([delay(3000), childClosed ?? Promise.resolve()])
    if (child.exitCode === null && child.signalCode === null) ownedKill('SIGKILL')
  }
  await writeFile(join(evidence, 'electron-smoke.log'), logs)
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        issue: 507,
        outcome,
        checks: { passed: checks.length, names: checks },
        artifact: 'unsigned Electron app.asar',
        resources: {
          temporaryRoot: root,
          userData: join(profile, 'userData'),
          sessionData: join(profile, 'sessionData'),
          vault,
          appAsar: join(root, 'app.asar'),
          cdpPort: 'allocated from port 0',
          listeners: 'runner-owned child and CDP socket',
        },
        commands: [
          'pnpm --filter @holi/desktop smoke:mdx-diagnostics:typecheck',
          'pnpm --filter @holi/desktop smoke:mdx-diagnostics:native <evidence-dir>',
        ],
        evidence: [
          'result.json',
          'electron-smoke.log',
          'diagnostics-light.png',
          'diagnostics-dark.png',
        ],
      },
      null,
      2,
    ),
  )
  await rm(root, { recursive: true, force: true })
  await portServer.close().catch(() => {})
}

async function windowStatus(page) {
  return await page.evaluate(`window.holiSmoke.call('smoke:status')`)
}
async function screenshot(page, destination) {
  const { data } = await page.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(destination, Buffer.from(data, 'base64'))
}
