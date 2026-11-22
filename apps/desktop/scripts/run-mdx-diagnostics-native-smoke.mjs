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
import tailwindcss from '@tailwindcss/vite'
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
let nativeScenarios = null
let runtime = null
let positionedDiagnostics = null
const checks = []
const portServer = createServer()
let childClosed = Promise.resolve(null)
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
  await mkdir(join(vault, 'notes'), { recursive: true })
  await mkdir(join(appDir, 'renderer'), { recursive: true })
  await writeFile(join(vault, 'notes', 'fixture.mdx'), '# fixture\n')

  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: {
      alias: [
        { find: '@/lib/trpc', replacement: join(desktop, 'scripts/mdx-diagnostics-smoke-trpc.ts') },
        { find: '@', replacement: join(desktop, 'src/renderer/src') },
      ],
    },
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
    `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('holiSmoke', { call: (channel, input) => { if (!['smoke:status','smoke:trpc','smoke:scenarios'].includes(channel)) return Promise.reject(Error('Denied fixture operation')); return ipcRenderer.invoke(channel, input) } });`,
  )
  await build({
    configFile: join(desktop, 'vite.mdx-compiler.config.ts'),
    build: { outDir: join(appDir, 'out/mdx-compiler'), emptyOutDir: true },
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
  childClosed = new Promise((resolve) =>
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
  cdp = createCdpClient(socket, { timeoutMs: 30000 })
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
  runtime = isolation.runtime
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
  assert.equal(preApproval.compileSources, 0, 'source was delivered before approval')
  assert.equal(preApproval.guestProbes.length, 0, 'compiler guest was probed before approval')
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
  assert.deepEqual(guest.result.storage, { cookies: '', local: 0, session: 0 })
  assert.equal(
    guest.result.credentialMarker,
    null,
    'default-session fixture credential leaked into compiler guest',
  )
  checks.push('actual compiler guest has no privileged globals or session data')
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>/^\\d+ MDX diagnostic/.test(el.textContent.trim()))`,
      ),
    'production FileView compiler diagnostic',
  ).catch(async (error) => {
    const state = await evaluate(
      `JSON.stringify({status:[...document.querySelectorAll('[aria-live="polite"]')].map((el)=>el.textContent),body:document.body.innerText,errors:window.__mdxSmoke.errors})`,
    )
    throw new Error(`Production diagnostic failure ${state}: ${error.message}`)
  })
  const diagnostic = await evaluate(
    `JSON.stringify({source:window.__mdxSmoke.source(),message:[...document.querySelectorAll('[aria-live="polite"]')].map((el)=>el.textContent).find((text)=>/^\\d+ MDX diagnostic/.test(text.trim())),underlines:document.querySelectorAll('.cm-lintRange-error').length,classes:[...document.querySelectorAll('.cm-editor *')].map((node)=>node.className?.baseVal??node.className).filter((name)=>String(name).includes('lint')||String(name).includes('diagnostic'))})`,
  ).then(JSON.parse)
  positionedDiagnostics = await evaluate('window.__mdxSmoke.diagnostics()')
  assert.equal(positionedDiagnostics.length, 1)
  assert.equal(positionedDiagnostics[0].line, 3)
  assert.equal(positionedDiagnostics[0].column, 14)
  assert.match(positionedDiagnostics[0].message, /expression|acorn/i)
  await screenshot(page, join(evidence, 'diagnostics-light.png'))
  await evaluate(`window.__mdxSmoke.theme('dark')`)
  await evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  )
  await evaluate(
    `Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`,
  )
  await screenshot(page, join(evidence, 'diagnostics-dark.png'))
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

  const editAndWaitForSave = async (source, label) => {
    const previous = (await windowStatus(page)).savedWrites
    await evaluate(`window.__mdxSmoke.setSource(${JSON.stringify(source)})`)
    await waitFor(
      async () => (await windowStatus(page)).savedWrites > previous,
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
  const hostile =
    "import Evil from 'file:///etc/passwd'\n\n{globalThis.__mdxSmokeExecuted = true}\n"
  await editAndWaitForSave(hostile, 'hostile source')
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>el.textContent.includes('syntax is valid')) && document.querySelector('.cm-lintRange-error') === null`,
      ),
    'valid hostile MDX compiles cleanly after source save without Retry',
  )
  assert.equal(
    await evaluate(`globalThis.__mdxSmokeExecuted===true`),
    false,
    'compiled MDX expression was evaluated in FileView',
  )
  checks.push('valid source clean', 'hostile MDX expression not evaluated by the renderer')
  const runtimeErrors = await evaluate(`JSON.stringify(window.__mdxSmoke.errors)`)
  assert.deepEqual(JSON.parse(runtimeErrors), [], 'fixture renderer reported runtime errors')

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
  checks.push(
    'real guest policy denies network, files, app URLs, popup, permission, media, navigation and download traffic',
    'real guest compiled output was not evaluated and storage was cleared',
    'real guest crash and deadline recover with fresh successful compilations',
    ...nativeScenarios.stale.map((item) => `native held compile rejects stale ${item.name}`),
  )
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
    if (child.exitCode === null && child.signalCode === null) {
      ownedKill('SIGKILL')
      await childClosed
    }
  }
  await writeFile(join(evidence, 'electron-smoke.log'), logs)
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        issue: 507,
        outcome,
        checks: { passed: checks.length, names: checks },
        nativeScenarios,
        runtime,
        positionedDiagnostics,
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
  if (portServer.listening) {
    await new Promise((resolve, reject) =>
      portServer.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => {
      logs += `\nPORT SERVER CLOSE ERROR: ${error?.stack ?? error}\n`
      outcome = 'failed'
    })
  }
}

async function windowStatus(page) {
  return await page.evaluate(`window.holiSmoke.call('smoke:status')`)
}
async function screenshot(page, destination) {
  const { data } = await page.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(destination, Buffer.from(data, 'base64'))
}
