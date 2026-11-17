import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.argv.slice(2).find((arg) => arg !== '--') ?? `/tmp/holi-510-native-${Date.now()}`,
)
await mkdir(evidence, { recursive: true })
assert.deepEqual(await readdir(evidence), [], 'refusing to overwrite native evidence')
const root = await mkdtemp('/tmp/holi-510-runtime-')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assertions = []
let child
let closed
let ws
let quit
let log = ''
let failure
const port = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const value = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return value
}
let debugPort
let pluginPort
try {
  debugPort = await port()
  pluginPort = await port()
  const plugin = join(root, 'plugin')
  await mkdir(plugin)
  await copyFile(
    join(desktop, 'scripts/community-hints-native-smoke-serve.cjs'),
    join(plugin, 'serve.cjs'),
  )
  await writeFile(
    join(plugin, 'holi-plugin.json'),
    JSON.stringify({
      id: 'smoke-plugin',
      name: 'Community hint fixture',
      version: '0.1.0',
      opens: ['slides.md'],
      setup: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('.hint-smoke-setup', 'setup-complete')",
      ],
      serve: [process.execPath, 'serve.cjs', '{file}', '--port', '{port}'],
    }),
  )
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: plugin,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  )
  git('tag', 'v0.1.0')
  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: { input: join(desktop, 'scripts/community-hints-native-smoke.html') },
    },
  })
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: join(desktop, 'scripts/community-hints-native-smoke-main.ts'),
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
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-community-hints-native-510', main: 'main.cjs' }),
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('holiSmoke',{call:(name,params)=>ipcRenderer.invoke('community:call',name,params),quit:()=>ipcRenderer.send('smoke:quit')});contextBridge.exposeInMainWorld('holi',{trpc:op=>ipcRenderer.invoke('community:trpc',op),logs:{onEntry:()=>()=>{}}});`,
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/.test(key) && !key.startsWith('GIT_'),
    ),
  )
  Object.assign(env, {
    HOME: join(root, 'home'),
    HOLI_510_ROOT: root,
    HOLI_510_SERVER_PORT: String(pluginPort),
  })
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root, `--remote-debugging-port=${debugPort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log += chunk
      process.stdout.write(chunk)
    })
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  let target
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null) throw new Error(`fixture exited ${child.exitCode}`)
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    target = targets.find((item) => item.type === 'page')
    if (target?.webSocketDebuggerUrl) break
    await sleep(250)
  }
  assert(target?.webSocketDebuggerUrl, 'missing native CDP page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  const contexts = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.executionContextCreated' && !message.sessionId)
      contexts.set(message.params.context.id, message.params.context)
    if (message.method === 'Runtime.executionContextDestroyed')
      contexts.delete(message.params.executionContextId)
    if (message.method === 'Runtime.executionContextsCleared') contexts.clear()
    if (!message.id) return
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    clearTimeout(call.timer)
    message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result)
  })
  const cdp = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const callId = ++id
      const timer = setTimeout(() => {
        pending.delete(callId)
        reject(new Error(`CDP deadline: ${method}`))
      }, 10000)
      pending.set(callId, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: callId, method, params, sessionId }))
    })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  const guestContext = () =>
    [...contexts.values()].find(
      (context) =>
        /^http:\/\/(?:127\.0\.0\.1|localhost):/.test(context.origin) && context.auxData?.isDefault,
    )?.id
  let guestSession
  const evaluate = async (expression, guest = false) => {
    const contextId = guest ? guestContext() : undefined
    if (guest && !contextId && !guestSession) {
      const { targetInfos } = await cdp('Target.getTargets')
      const frame = targetInfos.find(
        (item) => item.type === 'iframe' && /^http:\/\/(?:127\.0\.0\.1|localhost):/.test(item.url),
      )
      if (!frame) return undefined
      guestSession = (
        await cdp('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
      ).sessionId
    }
    const result = await cdp(
      'Runtime.evaluate',
      {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      guest && !contextId ? guestSession : undefined,
    )
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async (expression, description, guest = false) => {
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw new Error('Electron stopped while waiting')
      if (await evaluate(expression, guest)) return
      await sleep(100)
    }
    throw new Error(
      `timeout: ${description}; host=${await evaluate('document.body.innerText')}; hostMessages=${JSON.stringify(await evaluate('window.smokeMessages'))}; guestMessages=${JSON.stringify(await evaluate('window.smokeMessages', true))}`,
    )
  }
  const key = async (value) => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: value,
      code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
      text: value.length === 1 ? value : undefined,
    })
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: value,
      code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
    })
  }
  const click = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }
  quit = () => evaluate('window.holiSmoke.quit()')
  await wait('!!document.querySelector("iframe")', 'real PluginFrame acquire')
  await wait('!!window.__holiHintBridgeV1__', 'served opt-in bridge', true)
  for (const guest of [false, true])
    await evaluate(
      `window.smokeMessages=[];window.addEventListener('message',event=>window.smokeMessages.push({origin:event.origin,data:event.data}))`,
      guest,
    )
  assert.equal(await evaluate('window.holi', true), undefined, 'no harness bridge in guest')
  assertions.push(
    'real release install requires consent; setup/pin/acquire start actual supervised server',
  )
  const focusGuest = async () => {
    const rect = await evaluate(
      '(()=>{const r=document.querySelector("iframe").getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()',
    )
    await click(rect.x, rect.y)
    await wait('document.activeElement===document.querySelector("iframe")', 'guest focus')
    await sleep(100)
  }
  const hints = () =>
    evaluate(
      '[...document.querySelectorAll("[data-host-hints] [data-hint-key]")].map(e=>({key:e.getAttribute("data-hint-key"),target:e.getAttribute("data-hint-target")}))',
    )
  const start = async () => {
    await focusGuest()
    await key('f')
    await wait(
      '!!document.querySelector("[data-host-hints]")',
      'actual guest f to shared host labels',
    )
  }
  await start()
  const first = await hints()
  assert.equal(
    first.some((hint) => hint.target === 'Host action'),
    false,
    'guest-started labels must exclude host chrome',
  )
  assert(
    first.some((hint) => hint.target === 'Ordinary typing') === false,
    'editable target exposed',
  )
  assert(
    first.some((hint) => hint.target === 'Offscreen fixture') === false,
    'offscreen target exposed',
  )
  const button = first.find((hint) => hint.target === 'Native button')
  assert(button?.key, 'guest native button label absent')
  const shot = async (name) => {
    await sleep(100)
    const result = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(evidence, name), Buffer.from(result.data, 'base64'))
  }
  await evaluate('document.documentElement.dataset.theme="dark"')
  await key('Escape')
  await start()
  await shot('dark.png')
  await key('Escape')
  await wait('!document.querySelector("[data-host-hints]")', 'Escape cancellation')
  assertions.push('actual cross-origin f produces shared host/guest labels; Escape cancels')
  await evaluate('document.documentElement.dataset.theme="light"')
  await start()
  await shot('light.png')
  const current = (await hints()).find((hint) => hint.target === 'Native button')
  for (const letter of current.key) await key(letter)
  await wait('window.fixtureClicks===1', 'guest default button activation', true)
  assertions.push('actual native keyboard prefix activates guest button through shared coordinator')
  await start()
  await evaluate('document.querySelector("#activate").remove()', true)
  await wait('!document.querySelector("[data-host-hints]")', 'guest mutation cancellation')
  for (const letter of current.key) await key(letter)
  assert.equal(await evaluate('window.fixtureClicks', true), 1)
  assertions.push('removed target cancels labels and cannot receive stale activation')
  await evaluate('window.communitySmoke.vim(false)')
  await focusGuest()
  await key('f')
  assert.equal(await evaluate('!!document.querySelector("[data-host-hints]")'), false)
  await evaluate('window.communitySmoke.vim(true)')
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'Vim reenable')
  await evaluate('window.communitySmoke.visible(false)')
  await wait('!document.querySelector("[data-host-hints]")', 'hide cancellation')
  await evaluate('window.communitySmoke.visible(true)')
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'new visible presentation')
  await key('Escape')
  assertions.push('Vim disable and hide invalidate; new presentation recovers')
  await evaluate('document.querySelector("input").focus()', true)
  await key('f')
  assert.equal(await evaluate('document.querySelector("input").value', true), 'f')
  assert.equal(await evaluate('!!document.querySelector("[data-host-hints]")'), false)
  assertions.push('editable native typing is not intercepted')
  await evaluate(
    'window.holiSmoke.call("community.remove",{id:"smoke-plugin"}).then(()=>window.communitySmoke.refresh())',
  )
  await wait('!document.querySelector("iframe")', 'consent/install removal detaches frame')
  assertions.push('real community removal stops process and removes eligible frame')
} catch (error) {
  failure = error
} finally {
  try {
    if (child && child.exitCode === null) {
      await quit?.().catch(() => undefined)
      await Promise.race([closed, sleep(8000)])
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await Promise.race([closed, sleep(5000)])
      }
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await closed
      }
    }
    ws?.close()
    const pid = Number(await readFile(join(root, 'vault/.hint-smoke-pid'), 'utf8').catch(() => '0'))
    if (pid > 0) {
      try {
        process.kill(pid, 0)
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
          encoding: 'utf8',
        }).trim()
        const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
          encoding: 'utf8',
        })
          .split('\n')
          .find((line) => line.startsWith('n'))
          ?.slice(1)
        const marker = join(root, 'vault/.hint-smoke-pid')
        const exact =
          command.includes(join(root, 'plugin/serve.cjs')) &&
          cwd === join(root, 'plugin') &&
          (await readFile(marker, 'utf8')) === String(pid)
        if (!exact) throw new Error(`refusing to signal unverified fixture PID ${pid}`)
        process.kill(pid, 'SIGTERM')
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            process.kill(pid, 0)
          } catch (error) {
            if (error.code === 'ESRCH') break
            throw error
          }
          await sleep(100)
        }
        try {
          process.kill(pid, 0)
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await rm(root, { recursive: true, force: true })
    await writeFile(join(evidence, 'electron.log'), log)
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          passed: !failure,
          assertions,
          failure: failure?.stack,
          cleanup: {
            runtimeRemoved: true,
            electronStopped: !child || child.exitCode !== null,
            fixtureServerStopped: true,
          },
        },
        null,
        2,
      ),
    )
  } catch (error) {
    await writeFile(join(evidence, 'cleanup-error.txt'), String(error))
    failure ??= error
  }
}
if (failure) throw failure
console.log(`Community hints native proof passed: ${evidence}`)
