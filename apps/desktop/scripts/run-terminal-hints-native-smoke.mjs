import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.argv.slice(2).find((arg) => arg !== '--') ?? '/tmp/holi-518/native',
)
const root = await mkdtemp(join(tmpdir(), 'holi-518-native-'))
const debugServer = createServer()
await new Promise((resolve, reject) => {
  debugServer.once('error', reject)
  debugServer.listen(0, '127.0.0.1', resolve)
})
const debugPort = debugServer.address().port
await new Promise((resolve, reject) =>
  debugServer.close((error) => (error ? reject(error) : resolve())),
)
await mkdir(evidence, { recursive: true })
assert.deepEqual(
  await readdir(evidence),
  [],
  `refusing to overwrite existing native evidence at ${evidence}`,
)
let child
let closed
let requestQuit
let log = ''
try {
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
      rollupOptions: { input: join(desktop, 'scripts/terminal-hints-native-smoke.html') },
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
        input: join(desktop, 'scripts/terminal-hints-native-smoke-main.ts'),
        external: ['electron', 'node-pty'],
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
    JSON.stringify({ name: 'holi-terminal-hints-native-518', main: 'main.cjs' }),
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron');\nconst sub=(channel,fn)=>{const listener=(_e,value)=>fn(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener)};\nipcRenderer.on('holi-smoke:start',()=>ipcRenderer.send('holi-smoke:pty-start'));\ncontextBridge.exposeInMainWorld('holiSmokeQuit',()=>ipcRenderer.send('holi-smoke:quit'));\ncontextBridge.exposeInMainWorld('holi',{trpc:(op)=>ipcRenderer.invoke('holi-smoke:trpc',op),openExternal:(url)=>ipcRenderer.invoke('holi:openExternal',url),logs:{onEntry:()=>()=>{}},terminal:{onData:(fn)=>sub('holi-smoke:pty-data',fn),onExit:(fn)=>sub('holi-smoke:pty-exit',fn),onContext:()=>()=>{}}});`,
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    ZDOTDIR: join(root, 'zsh'),
    HOLI_518_ROOT: root,
    HOLI_518_EVIDENCE: evidence,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root, `--remote-debugging-port=${debugPort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => {
    log += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
    process.stderr.write(chunk)
  })
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  // Driver is native CDP Input, using Electron's actual renderer and production components.
  const poll = async () => {
    for (let n = 0; n < 100; n++) {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null)
      if (response?.ok) return response.json()
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('Electron CDP endpoint did not become ready')
  }
  // The runner uses an isolated Chromium debugging port, not the user's profile or app.
  // BrowserWindow's command line is configured by Electron's standard environment switch.
  const targets = await poll()
  const target = targets.find((item) => item.type === 'page')
  assert(target?.webSocketDebuggerUrl, 'missing native renderer CDP target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  let ackId = -1
  const pending = new Map()
  const screencastFrames = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Page.screencastFrame') {
      screencastFrames.push({ image: Buffer.from(msg.params.data, 'base64'), at: Date.now() })
      ws.send(
        JSON.stringify({
          id: ackId--,
          method: 'Page.screencastFrameAck',
          params: { sessionId: msg.params.sessionId },
        }),
      )
      return
    }
    if (msg.id) {
      const entry = pending.get(msg.id)
      if (entry) {
        pending.delete(msg.id)
        msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result)
      }
    }
  })
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const callId = ++id
      pending.set(callId, { resolve, reject })
      ws.send(JSON.stringify({ id: callId, method, params }))
    })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const waitFor = async (expression, description) => {
    for (let n = 0; n < 100; n++) {
      const value = await evaluate(expression)
      if (value) return value
      await new Promise((r) => setTimeout(r, 100))
    }
    const diagnostics = await evaluate(`document.body.innerText`).catch((error) => String(error))
    throw new Error(`timeout waiting for ${description}; renderer text: ${diagnostics}`)
  }
  const waitForScreencastFrame = async (afterFrame) => {
    for (let attempt = 0; attempt < 100 && screencastFrames.length <= afterFrame; attempt++)
      await new Promise((r) => setTimeout(r, 20))
    assert(screencastFrames.length > afterFrame, 'no CDP screencast frame arrived')
  }
  const screenshot = async (name, afterFrame) => {
    await waitForScreencastFrame(afterFrame)
    const result = await cdp('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    await writeFile(join(evidence, name), Buffer.from(result.data, 'base64'))
  }
  requestQuit = () => evaluate('window.holiSmokeQuit()')
  const trustedKey = async (key, code = key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`) => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode:
        key === 'Enter' ? 13 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
      text: key === 'Enter' ? '\\r' : undefined,
      unmodifiedText: key === 'Enter' ? '\\r' : undefined,
    })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
  }
  const trustedControlBacktick = async () => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: '`',
      code: 'Backquote',
      modifiers: 2,
      windowsVirtualKeyCode: 192,
    })
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: '`',
      code: 'Backquote',
      modifiers: 2,
      windowsVirtualKeyCode: 192,
    })
  }
  const trustedClickAt = async (rect, label) => {
    assert(rect, `missing control ${label}`)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    })
  }
  const trustedClick = async (selector) => {
    const rect = await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await trustedClickAt(rect, selector)
  }
  const trustedTab = async (label) => {
    const rect = await evaluate(
      `(()=>{const e=[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await trustedClickAt(rect, `tab ${label}`)
  }
  await waitFor(
    `document.querySelector('[data-panel-terminal="native-shell"] .xterm-screen')`,
    'real xterm mount',
  )
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.ok&&r.data.includes('NATIVE_HINT_FIXTURE'))`,
    'real PTY replay',
  )
  let settledReplay = await evaluate(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.data)`,
  )
  let steady = 0
  while (steady < 5) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const currentReplay = await evaluate(
      `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.data)`,
    )
    if (currentReplay === settledReplay) steady++
    else {
      settledReplay = currentReplay
      steady = 0
    }
  }
  await cdp('Page.startScreencast', {
    format: 'png',
    everyNthFrame: 1,
    maxWidth: 2000,
    maxHeight: 1440,
  })
  await waitForScreencastFrame(0)
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(
    `document.activeElement.classList.contains('xterm-helper-textarea')`,
    'Show hints focuses the shell',
  )
  await waitFor(
    `document.querySelector('[data-host-hints] [data-hint-target]')?.getAttribute('data-hint-target')`,
    'host hint overlay',
  )
  const hintDetails = async () =>
    JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('[data-host-hints] [data-hint-target]')].map(e=>({target:e.getAttribute('data-hint-target'),key:e.getAttribute('data-hint-key'),text:e.textContent})))`,
      ),
    )
  const visibleHints = await hintDetails()
  assert(
    visibleHints.some((entry) => entry.target.includes('example.com')),
    'URL hint missing',
  )
  assert(
    visibleHints.some((entry) => entry.target.includes('Maximize panel')),
    'panel control missing from shared hints',
  )
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-host-hints] [data-hint-key]').length`),
    visibleHints.length,
    'dark capture started without the asserted hint labels',
  )
  await trustedKey('Escape')
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'initial dark session canceled')
  const darkFrameBaseline = screencastFrames.length
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'dark capture hint session')
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-host-hints] [data-hint-key]').length`),
    visibleHints.length,
    'dark capture lost the asserted hint labels',
  )
  await new Promise((r) => setTimeout(r, 300))
  await screenshot('dark.png', darkFrameBaseline)
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-host-hints] [data-hint-key]').length`),
    visibleHints.length,
    'dark labels did not persist through screencast capture',
  )
  await trustedKey('Escape')
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'dark capture session canceled')

  // A foreground stock Dialog cancels the old session and owns the f shortcut.
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'dialog invalidation hint session')
  await evaluate(`window.__holiNativeSmokeSetDialog(true)`)
  await waitFor(`!!document.querySelector('[role="dialog"]')`, 'stock Dialog opened')
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'opening Dialog canceled old hints')
  await trustedKey('f')
  await waitFor(
    `!!document.querySelector('[data-host-hints]')`,
    'trusted f requested hints from Dialog',
  )
  const dialogHints = await hintDetails()
  assert(
    dialogHints.some((entry) => entry.target.includes('Close smoke dialog')),
    'Dialog close control absent from foreground hints',
  )
  assert(
    !dialogHints.some((entry) => entry.target.includes('example.com')),
    'background terminal URL leaked into Dialog hints',
  )
  const dialogCloseHint = dialogHints.find((entry) => entry.target.includes('Close smoke dialog'))
  assert(dialogCloseHint, 'dialog own close control is not hintable')
  await trustedClick('[aria-label="Close smoke dialog"]')
  await waitFor(
    `!document.querySelector('[role="dialog"]')`,
    'actual Dialog close control activated with trusted native input',
  )
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'Dialog close canceled hints')

  const lightFrameBaseline = screencastFrames.length
  await evaluate(`document.documentElement.dataset.theme='light'`)
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'light capture hint session')
  const lightHints = await hintDetails()
  assert(
    lightHints.some((entry) => entry.target.includes('example.com')),
    'light theme lost the visible URL hint',
  )
  await new Promise((r) => setTimeout(r, 300))
  await screenshot('light.png', lightFrameBaseline)
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-host-hints] [data-hint-key]').length`),
    lightHints.length,
    'light labels did not persist through screencast capture',
  )
  await trustedKey('Escape')
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'light capture session canceled')
  await evaluate(`document.documentElement.dataset.theme='dark'`)
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'dark activation hint session')
  await trustedClick('[aria-label="Terminal"]')
  await waitFor(`!!document.querySelector('[role="listbox"]')`, 'terminal picker menu')
  assert.equal(
    await evaluate(`!!document.querySelector('[data-host-hints]')`),
    false,
    'terminal menu did not take foreground precedence over hints',
  )
  await trustedKey('Escape')
  await waitFor(`!document.querySelector('[role="listbox"]')`, 'terminal picker dismissed')
  await trustedTab('Output')
  await waitFor(
    `[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.trim()==='Output')?.getAttribute('aria-selected')==='true'`,
    'output tab selected',
  )
  assert(
    await evaluate(
      `!!document.querySelector('[data-panel-terminal="native-shell"] .xterm-screen')`,
    ),
    'terminal xterm unmounted when switching tabs',
  )
  await trustedTab('Terminal')
  await waitFor(
    `[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.trim()==='Terminal')?.getAttribute('aria-selected')==='true'`,
    'terminal tab restored',
  )
  await trustedClick('[aria-label="Close panel"]')
  await waitFor(`document.querySelector('[data-bottom-panel]').hidden`, 'panel hidden')
  assert(
    await evaluate(
      `!!document.querySelector('[data-panel-terminal="native-shell"] .xterm-screen')`,
    ),
    'terminal xterm unmounted when hiding the panel',
  )
  await trustedControlBacktick()
  await waitFor(
    `!document.querySelector('[data-bottom-panel]').hidden`,
    'panel restored by trusted shortcut',
  )
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'vim lifecycle hint session')
  await evaluate(`window.__holiNativeSmokeSetVim(false)`)
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'vim disable canceled hints')
  assert.equal(
    await evaluate(`!!document.querySelector('[aria-label="Show terminal hints"]')`),
    false,
    'Vim-off state left terminal hints enabled',
  )
  await evaluate(`window.__holiNativeSmokeSetVim(true)`)
  await waitFor(
    `!!document.querySelector('[aria-label="Show terminal hints"]')`,
    'vim re-enabled hints',
  )

  // Create another real shell through the production New terminal control.
  const terminalCountBeforeCreate = await evaluate(
    `document.querySelectorAll('[data-panel-terminal]').length`,
  )
  await trustedClick('[aria-label="New terminal"]')
  await waitFor(
    `document.querySelectorAll('[data-panel-terminal]').length>${terminalCountBeforeCreate}`,
    'second live terminal mounted',
  )
  const secondTerminalId = await evaluate(
    `([...document.querySelectorAll('[data-panel-terminal]')].map(e=>e.getAttribute('data-panel-terminal')).filter(id=>id!=='native-shell').at(-1))`,
  )
  assert(secondTerminalId, 'second terminal has no independent UI id')
  const secondProofSuffix = `${secondTerminalId}-proof`
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:${JSON.stringify(secondTerminalId)}}}).then(r=>r.ok&&r.data.includes('SECOND_LIVE_FIXTURE'))`,
    'second real PTY output',
  )
  await trustedClick('[aria-label="Terminal"]')
  await waitFor(`!!document.querySelector('[role="listbox"]')`, 'live terminal picker')
  const firstLiveOption = await evaluate(
    `(()=>{const e=[...document.querySelectorAll('[role="option"]')][0];if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await trustedClickAt(firstLiveOption, 'first live terminal option')
  await waitFor(
    `!document.querySelector('[data-panel-terminal="native-shell"]').classList.contains('hidden')`,
    'first shell selected before switching',
  )
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(
    `!!document.querySelector('[data-host-hints]')`,
    'first terminal hints before switch',
  )
  const staleFirstHint = (await hintDetails()).find((entry) =>
    entry.target.includes('holi-native-hint-proof'),
  )
  assert(staleFirstHint?.key, 'first terminal URL hint absent before switching')
  await trustedClick('[aria-label="Terminal"]')
  await waitFor(`!!document.querySelector('[role="listbox"]')`, 'picker opened during first hints')
  const secondOption = await evaluate(
    `(()=>{const e=[...document.querySelectorAll('[role="option"]')].at(-1);if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await trustedClickAt(secondOption, 'second live terminal option')
  await waitFor(
    `!document.querySelector('[data-panel-terminal="${secondTerminalId}"]').classList.contains('hidden')`,
    'second shell selected',
  )
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'switch canceled first-shell hints')
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'second terminal hint session')
  const secondHints = await hintDetails()
  assert(
    !secondHints.some((entry) => entry.target.includes('holi-native-hint-proof')),
    'first terminal target survived switch',
  )
  const secondUrlHint = secondHints.find((entry) => entry.target.includes(secondProofSuffix))
  assert(secondUrlHint?.key, 'second live terminal URL hint missing')
  for (const key of secondUrlHint.key) await trustedKey(key)
  await waitFor(
    `window.__holiNativeSmokeOpenedUrl?.includes(${JSON.stringify(secondProofSuffix)})`,
    'second URL activation routed from selected shell',
  )
  assert.equal(
    await readFile(join(evidence, 'external-url.txt'), 'utf8'),
    `https://example.com/${secondTerminalId}-proof`,
  )
  await trustedClick('[aria-label="Terminal"]')
  await waitFor(`!!document.querySelector('[role="listbox"]')`, 'picker return to first terminal')
  const firstOption = await evaluate(
    `(()=>{const e=[...document.querySelectorAll('[role="option"]')][0];if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await trustedClickAt(firstOption, 'first live terminal option')
  await waitFor(
    `!!document.querySelector('[data-panel-terminal="native-shell"] .xterm-screen')`,
    'first shell returned',
  )
  assert.equal(
    await evaluate(`!!document.querySelector('[data-host-hints]')`),
    false,
    'returning to first revived stale hint session',
  )
  await trustedClick('[aria-label="Terminal"]')
  await waitFor(`!!document.querySelector('[role="listbox"]')`, 'picker returns to second terminal')
  const returnSecondOption = await evaluate(
    `(()=>{const e=[...document.querySelectorAll('[role="option"]')].at(-1);if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await trustedClickAt(returnSecondOption, 'return to second live terminal')
  await waitFor(
    `!document.querySelector('[data-panel-terminal="${secondTerminalId}"]').classList.contains('hidden')`,
    'second terminal visible again',
  )
  await trustedClick(`[data-panel-terminal="${secondTerminalId}"] .xterm-screen`)
  await trustedKey('f')
  await trustedKey('Enter')
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:${JSON.stringify(secondTerminalId)}}}).then(r=>r.ok&&r.data.includes('F_ENTER_PROOF'))`,
    'selected second PTY alone received f+Enter',
  )
  assert(
    (
      await evaluate(
        `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.data)`,
      )
    ).includes('NATIVE_HINT_FIXTURE'),
    'first PTY replay lost its own output',
  )
  await trustedClick('[aria-label="Terminal"]')
  await waitFor(
    `!!document.querySelector('[role="listbox"]')`,
    'picker returns to first terminal after second input proof',
  )
  const backToFirstOption = await evaluate(
    `(()=>{const e=[...document.querySelectorAll('[role="option"]')][0];if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await trustedClickAt(backToFirstOption, 'return to first shell for remaining native checks')
  await waitFor(
    `!document.querySelector('[data-panel-terminal="native-shell"]').classList.contains('hidden')`,
    'first shell visible for remaining checks',
  )

  const baselineInput = await evaluate(
    `window.holi.trpc({path:'terminal.inputProof',type:'query'}).then(r=>r.data.input.length)`,
  )
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'URL activation hint session')
  await waitFor(
    `document.activeElement.classList.contains('xterm-helper-textarea')`,
    'URL activation focuses the shell',
  )
  const linkHint = (await hintDetails()).find((entry) => entry.target.includes('https://'))
  assert(linkHint?.key, 'could not find URL label')
  console.log(`native URL hint key=${linkHint.key}`)
  for (const key of linkHint.key) await trustedKey(key)
  await waitFor(`window.__holiNativeSmokeOpened===true`, 'validated external activation')
  const inputAfterHints = await evaluate(
    `window.holi.trpc({path:'terminal.inputProof',type:'query'}).then(r=>r.data.input.length)`,
  )
  assert.equal(inputAfterHints, baselineInput, 'hint label bytes leaked into the actual PTY')
  assert.equal(
    await readFile(join(evidence, 'external-url.txt'), 'utf8'),
    'https://example.com/holi-native-hint-proof',
  )

  // Maximize is a production panel action in the same coordinator namespace as links.
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'control hint session')
  const control = (await hintDetails()).find((entry) => entry.target.includes('Maximize panel'))
  assert(control?.key, 'maximize panel control hint missing')
  for (const key of control.key) await trustedKey(key)
  await waitFor(
    `!!document.querySelector('[aria-label="Restore panel size"]')`,
    'hint activated maximize control',
  )
  await trustedClick('[aria-label="Restore panel size"]')
  await waitFor(
    `!!document.querySelector('[aria-label="Maximize panel"]')`,
    'panel restored with real control',
  )

  await trustedClick('[data-panel-terminal="native-shell"] .xterm-screen')
  await waitFor(
    `document.activeElement.classList.contains('xterm-helper-textarea')`,
    'shell focus restored after panel control interaction',
  )

  // Ordinary f+Enter are delivered to the real foreground PTY when hints are off.
  await trustedKey('f')
  await trustedKey('Enter')
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.ok&&r.data.includes('F_ENTER_PROOF'))`,
    'ordinary f and Enter reached child',
  )

  // Clear the visible URL using real child output, then prove control-only hints also cancel on output.
  await evaluate(
    `window.holi.trpc({path:'terminal.write',type:'mutation',input:{remote:'native-smoke',id:'native-shell',data:'fixture:control-only\\n'}})`,
  )
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.ok&&r.data.includes('CONTROL_ONLY_PROOF'))`,
    'control-only child fixture output',
  )
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'control-only hint session')
  const controlOnlyHints = await hintDetails()
  assert(
    !controlOnlyHints.some((entry) => entry.target.includes('https://')),
    'control-only screen unexpectedly retained a URL target',
  )
  assert(
    controlOnlyHints.some((entry) => entry.target.includes('Maximize panel')),
    'control-only screen has no native targets',
  )

  // The harness-only bounded command traverses IPC to the actual PTY and makes real output.
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'output invalidation hint session')
  await evaluate(
    `window.holi.trpc({path:'terminal.write',type:'mutation',input:{remote:'native-smoke',id:'native-shell',data:'fixture:output\\n'}})`,
  )
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'real PTY output invalidated hints')
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.ok&&r.data.includes('FIXTURE_OUTPUT_PROOF'))`,
    'controlled output observed from real PTY',
  )

  // A long fixture URL starts above the viewport; visible continuation remains a target.
  await evaluate(
    `window.holi.trpc({path:'terminal.write',type:'mutation',input:{remote:'native-smoke',id:'native-shell',data:'fixture:long\\n'}})`,
  )
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.ok&&r.data.includes('wrapped-hint-'))`,
    'long URL fixture output',
  )
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'long URL hint session')
  const longHints = await hintDetails()
  const longLink = longHints.find((entry) => entry.target.includes('wrapped-hint-'))
  assert(longLink?.key, `wrapped URL continuation has no label: ${JSON.stringify(longHints)}`)
  for (const key of longLink.key) await trustedKey(key)
  await waitFor(
    `window.__holiNativeSmokeOpenedUrl?.includes('wrapped-hint-')`,
    'validated wrapped URL external activation',
  )
  assert(
    (await readFile(join(evidence, 'external-url.txt'), 'utf8')).includes('wrapped-hint-'),
    'long URL did not reach the safe external interception',
  )
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'scroll cancellation session')
  const scrollPoint = await evaluate(
    `(()=>{const r=document.querySelector('[data-panel-terminal=\"native-shell\"] .xterm-screen').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  const priorScrollTop = await evaluate(
    `document.querySelector('[data-panel-terminal=\"native-shell\"] .xterm-viewport').scrollTop`,
  )
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: scrollPoint.x,
    y: scrollPoint.y,
    deltaX: 0,
    deltaY: -240,
  })
  await waitFor(
    `!document.querySelector('[data-host-hints]')`,
    'trusted wheel scroll cancels hints',
  )
  assert.notEqual(
    await evaluate(
      `document.querySelector('[data-panel-terminal=\"native-shell\"] .xterm-viewport').scrollTop`,
    ),
    priorScrollTop,
    'wheel event did not move the actual xterm scrollback',
  )

  await trustedTab('Output')
  await waitFor(
    `[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.trim()==='Output')?.getAttribute('aria-selected')==='true'`,
    'output tab selected for vault switch',
  )
  await evaluate(`window.__holiNativeSmokeSetRemote('native-other')`)
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'vault switch canceled hints')
  await waitFor(
    `!document.querySelector('[data-panel-terminal="native-shell"]')`,
    'vault B unloaded terminal',
  )
  await evaluate(`window.__holiNativeSmokeSetRemote('native-smoke')`)
  await waitFor(
    `!!document.querySelector('[data-panel-terminal="native-shell"]')`,
    'vault A terminal restored',
  )
  await trustedTab('Terminal')
  await waitFor(
    `!!document.querySelector('[data-panel-terminal="native-shell"] .xterm-screen')`,
    'vault A xterm restored',
  )
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.ok&&r.data.includes('NATIVE_HINT_FIXTURE'))`,
    'vault A terminal replay restored',
  )
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'vault A hints restored')
  await trustedKey('Escape')
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'vault A hint session canceled')

  // Real native Control-C must cancel hint mode and deliver byte 0x03 to the PTY.
  await trustedClick('[aria-label="Show terminal hints"]')
  await waitFor(`!!document.querySelector('[data-host-hints]')`, 'interrupt hint session')
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Control',
    code: 'ControlLeft',
    modifiers: 2,
  })
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'c',
    code: 'KeyC',
    modifiers: 2,
    windowsVirtualKeyCode: 67,
  })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft' })
  await waitFor(`!document.querySelector('[data-host-hints]')`, 'Ctrl-C cancels hints')
  await waitFor(
    `window.holi.trpc({path:'terminal.replay',type:'query',input:{remote:'native-smoke',id:'native-shell'}}).then(r=>r.ok&&r.data.includes('SIGINT_PROOF'))`,
    'actual child SIGINT handler',
  )
  const proofBeforeQuit = await evaluate(
    `window.holi.trpc({path:'terminal.inputProof',type:'query'}).then(r=>r.data)`,
  )
  assert(proofBeforeQuit.hasInterrupt, 'actual PTY input has no Ctrl-C byte')
  assert(proofBeforeQuit.fixtureProof.includes('f-enter'), 'actual child did not observe f+Enter')
  assert(proofBeforeQuit.fixtureProof.includes('sigint'), 'actual child did not observe SIGINT')
  await evaluate(
    `window.holi.trpc({path:'terminal.write',type:'mutation',input:{remote:'native-smoke',id:'native-shell',data:'exit\\n'}})`,
  )
  await waitFor(
    `window.holi.trpc({path:'terminal.inputProof',type:'query'}).then(r=>typeof r.data.terminalExitCode==='number')`,
    'real terminal exit event',
  )
  await waitFor(
    `document.querySelector('[aria-label="Terminal"]')?.textContent?.includes('(exited)')`,
    'terminal picker reflects real exit',
  )
  await trustedClick('[aria-label="Terminal"]')
  await waitFor(`!!document.querySelector('[role="listbox"]')`, 'select second PTY for cleanup')
  const cleanupSecondOption = await evaluate(
    `(()=>{const e=[...document.querySelectorAll('[role="option"]')].at(-1);if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await trustedClickAt(cleanupSecondOption, 'select second PTY for cleanup')
  await trustedClick('[aria-label="Kill terminal"]')
  await waitFor(
    `window.holi.trpc({path:'terminal.list',type:'query',input:{remote:'native-smoke'}}).then(r=>r.ok&&r.data.some(t=>t.id===${JSON.stringify(secondTerminalId)}&&typeof t.exitCode==='number'))`,
    'second real PTY exit event',
  )

  await cdp('Page.stopScreencast')
  console.log(`CDP screencast frames=${screencastFrames.length}`)
  assert(screencastFrames.length >= 4, 'screencast did not capture an ordered interaction')
  const framesDir = join(evidence, '.frames')
  await mkdir(framesDir, { recursive: true })
  for (const [index, frame] of screencastFrames.entries())
    await writeFile(join(framesDir, `frame-${String(index).padStart(5, '0')}.png`), frame.image)
  const video = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      '5',
      '-i',
      join(framesDir, 'frame-%05d.png'),
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt',
      'yuv420p',
      join(evidence, 'interaction.mp4'),
    ],
    { encoding: 'utf8' },
  )
  assert.equal(video.status, 0, `ffmpeg interaction recording failed: ${video.stderr}`)
  await rm(framesDir, { recursive: true, force: true })
  await requestQuit()
  ws.close()
  const code = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
  ])
  assert.equal(code, 0, 'Electron smoke did not exit cleanly')
  const ptyProof = JSON.parse(
    await readFile(join(evidence, 'pty-proof.json'), 'utf8').catch(() => '{}'),
  )
  assert(ptyProof.hasInterrupt, 'final PTY proof lacks interrupt byte 0x03')
  assert(ptyProof.fixtureProof.includes('f-enter'), 'final PTY proof lacks f+Enter observation')
  assert(ptyProof.fixtureProof.includes('sigint'), 'final PTY proof lacks SIGINT observation')
  assert(ptyProof.input.flat().includes(3), 'actual PTY input log lacks control byte 0x03')
  assert(ptyProof.outputBytes > 0, 'no real PTY output was recorded')
  assert.equal(ptyProof.processCount, 0, 'PTY process registry not empty at shutdown')
  assert(ptyProof.processExited, 'real PTY child did not emit an exit before shutdown')
  const exitedIds = new Set(ptyProof.exits.map(([id]) => id))
  assert(exitedIds.has('native-shell'), 'initial actual PTY did not emit an exit')
  assert(exitedIds.has(secondTerminalId), 'second actual PTY did not emit an exit')
  assert.equal(ptyProof.exitCodes.length, 2, 'the two actual PTY exit callbacks were not recorded')
  assert.equal(typeof ptyProof.terminalExitCode, 'number', 'terminal exit code was not recorded')
  assert(!log.includes('Uncaught Error'), 'renderer reported an uncaught error')
  assert.equal(
    await stat(join(evidence, 'renderer-gone.txt'))
      .then(() => true)
      .catch(() => false),
    false,
    'renderer process crashed',
  )
  const result = {
    ok: true,
    checks: [
      'native-electron-window',
      'production-bottom-panel-and-xterm',
      'real-shell-pty-output-and-replay',
      'trusted-link-and-shared-control-hint-activation',
      'visible-hint-labels-in-dark-and-light-captures',
      'hint-label-input-isolation',
      'terminal-menu-foreground-precedence',
      'stock-dialog-cancels-hints-and-owns-foreground-targets',
      'two-live-real-pty-switch-invalidates-and-routes-only-current-terminal',
      'terminal-output-tab-switch-retains-xterm',
      'panel-hide-shortcut-return-retains-xterm',
      'vim-disable-cancels-hints',
      'vault-a-b-a-reloads-terminal-and-hints',
      'native-f-enter-child-proof',
      'control-only-screen-real-pty-output-invalidates-hints',
      'real-pty-output-invalidates-hints',
      'wrapped-long-url-label-and-activation',
      'trusted-wheel-scroll-cancellation',
      'native-control-c-cancels-and-reaches-child-sigint',
      'real-terminal-exit-and-picker-state',
      'real-pty-exit-and-cleanup',
      'safe-url-intercepted',
      'trusted-interaction-recording',
    ],
    artifacts: ['dark.png', 'light.png', 'interaction.mp4', 'external-url.txt'],
    electron: ptyProof.electron,
    chromium: ptyProof.chromium,
    ptyProof,
    isolated: true,
    implementation:
      'Production renderer, xterm, hint coordinator, URL validation, and real node-pty are used. The runner substitutes bounded harness-only terminal IPC and openExternal interception; this is not a production-router test.',
    coverageGaps: [],
  }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  for (const name of result.artifacts)
    assert((await stat(join(evidence, name))).size > 0, `missing ${name}`)
} finally {
  if (child && child.exitCode === null) {
    await requestQuit?.().catch(() => {})
    child.kill('SIGTERM')
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await writeFile(join(evidence, 'electron.log'), log)
  await rm(root, { recursive: true, force: true })
  const resultPath = join(evidence, 'result.json')
  const result = await readFile(resultPath, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)
  if (result) {
    const tempRootDeleted = !(await stat(root)
      .then(() => true)
      .catch(() => false))
    result.cleanup = { electronExitCode: child?.exitCode ?? null, tempRootDeleted }
    assert(tempRootDeleted, 'isolated profile/session/vault temp root still exists')
    await writeFile(resultPath, JSON.stringify(result, null, 2))
  }
}
