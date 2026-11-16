import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { extname } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { createCdpClient } from './native-smoke-cdp.mjs'
import { observeChild, startupDiagnostic } from './native-smoke-process.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-564-evidence-final')
const root = await mkdtemp(join(tmpdir(), 'holi-564-native-'))
const profile = join(root, 'profile')
let child
let processState
let server
let fixtureUrl
let socket
let logs = ''
let cdpClient
const browserErrors = []
const videoFrames = []
try {
  await mkdir(evidence, { recursive: true })
  for (const name of [
    'folder-subscriptions-hover.webm',
    'folder-subscriptions-keyboard.webm',
    'row-focus.png',
    'button-focus.png',
    'assertions.json',
    'electron-smoke.log',
  ])
    await rm(join(evidence, name), { force: true })
  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'fixture-subscriptions-trpc',
        enforce: 'pre',
        transform(_code, id) {
          if (id.endsWith('/src/renderer/src/lib/trpc.ts'))
            return `const calls=()=>window.__folderBellCalls;const subscriptions=new Map();export const trpc={subscriptions:{list:{query:async({paths})=>JSON.parse(paths).map(path=>({path,explicit:subscriptions.get(path)===true,coveredBy:null,baseline:null}))},set:{mutate:async({path,enabled})=>{subscriptions.set(path,enabled);calls().push({path,enabled})}}}}`
          return null
        },
      },
    ],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/folder-subscriptions-native-smoke.tsx'),
        output: { entryFileNames: 'renderer.js', assetFileNames: 'renderer.[ext]' },
      },
    },
  })
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin()],
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: join(desktop, 'scripts/folder-subscriptions-native-smoke-main.ts'),
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
    join(root, 'renderer', 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:; font-src \'self\'; connect-src \'none\'"><title>Folder subscriptions native acceptance</title><link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div><script type="module" src="./renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-folder-subscriptions-native-smoke', main: 'main.cjs' }),
  )
  server = createServer(async (req, res) => {
    const name = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.slice(1))
    if (name.includes('..')) {
      res.writeHead(400).end()
      return
    }
    const path = join(root, 'renderer', name)
    try {
      const body = await readFile(path)
      const type =
        extname(path) === '.html'
          ? 'text/html'
          : extname(path) === '.css'
            ? 'text/css'
            : 'text/javascript'
      res.writeHead(200, { 'content-type': type }).end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}/`
  const electron = createRequire(import.meta.url)('electron')
  await mkdir(profile, { recursive: true })
  const childEnv = {
    ...process.env,
    HOLI_564_ROOT: root,
    HOLI_564_PROFILE: profile,
    HOLI_564_URL: fixtureUrl,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
  }
  delete childEnv.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root, '--remote-debugging-port=0'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processState = observeChild(child)
  child.stdout.on('data', (chunk) => {
    logs += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
    process.stderr.write(chunk)
  })
  let evaluate = async () => {
    throw new Error('CDP evaluation is not available yet')
  }
  const wait = async (fn, label, ms = 30000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (processState?.exit || processState?.spawnFailure)
        throw Error(startupDiagnostic(label, processState, logs))
      try {
        const x = await fn()
        if (x) return x
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    throw Error(
      `${startupDiagnostic(label, processState, logs)}; errors=${JSON.stringify(browserErrors)}`,
    )
  }
  const port = await wait(
    () => /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(logs)?.[1],
    'DevTools',
  )
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true })
    socket.addEventListener('error', rej, { once: true })
  })
  cdpClient = createCdpClient(socket, {
    timeoutMs: 10000,
    onEvent(message) {
      if (
        message.method === 'Runtime.exceptionThrown' ||
        message.method === 'Runtime.consoleAPICalled'
      )
        browserErrors.push(message)
      if (message.method === 'Page.screencastFrame') {
        videoFrames.push(Buffer.from(message.params.data, 'base64'))
        void cdpClient
          .call(
            'Page.screencastFrameAck',
            { sessionId: message.params.sessionId },
            message.sessionId,
          )
          .catch(() => {})
      }
    },
  })
  const target = await wait(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page',
      ),
    'page target',
  )
  const page = await cdpClient.attach(target.id)
  const cdp = page.call
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  evaluate = page.evaluate
  const until = (expr, label) => wait(() => evaluate(expr), label)
  const key = async (key, modifiers = 0) => {
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
    const windowsVirtualKeyCode =
      key === 'Enter'
        ? 13
        : key === 'Tab'
          ? 9
          : key.length === 1
            ? key.toUpperCase().charCodeAt(0)
            : undefined
    const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      modifiers,
      text,
      unmodifiedText: text,
      windowsVirtualKeyCode,
    })
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    })
  }
  const screenshot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(evidence, name), Buffer.from(r.data, 'base64'))
  }
  await until(
    '!!window.__folderBellReady && !!document.querySelector(\'[role="tree"] [role="treeitem"]\')',
    'production FilesSection mounted',
  )
  const allButtons = () =>
    evaluate(
      `(()=>[...document.querySelectorAll('[data-tree-row-action]')].map(e=>({path:e.closest('[role=treeitem]')?.getAttribute('aria-label'),opacity:getComputedStyle(e).opacity,rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right}})()})))()`,
    )
  const assertAllHidden = async (label) => {
    const buttons = await allButtons()
    assert(buttons.length >= 2, `${label}: expected every visible folder action`)
    assert(
      buttons.every((button) => button.opacity === '0'),
      `${label}: every folder action must be hidden: ${JSON.stringify(buttons)}`,
    )
    return buttons
  }
  const allNoHover = () =>
    evaluate(
      `(()=>[...document.querySelectorAll('[data-slot="tree-item-label"],[data-tree-row-action]')].every(e=>!e.matches(':hover')))()`,
    )
  const metrics = () =>
    evaluate(
      `(()=>{const row=document.querySelector('[role="treeitem"][aria-label="parent"]');const label=row.querySelector('[data-slot="tree-item-label"]');const action=label.querySelector('[data-tree-row-action]');const name=label.querySelector('.truncate');const nested=document.querySelector('[role="treeitem"][aria-label="nested"]');const nestedAction=nested?.querySelector('[data-tree-row-action]');const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,width:r.width}};return{opacity:getComputedStyle(action).opacity,name:box(name),action:box(action),nestedAction:nestedAction?box(nestedAction):null,focused:document.activeElement===row,hoverLabels:[...document.querySelectorAll('[data-slot="tree-item-label"]')].filter(e=>e.matches(':hover')).length,hoverButtons:[...document.querySelectorAll('[data-tree-row-action]')].filter(e=>e.matches(':hover')).length}})()`,
    )
  // The real pointer is parked in the window's blank lower margin, outside every tree label and button.
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 680, y: 760 })
  await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  const labels = await evaluate(`document.querySelectorAll('[data-slot="tree-item-label"]').length`)
  assert(labels > 0)
  const initialButtons = await assertAllHidden('startup before focus enters tree')
  const rest = await metrics()
  assert.equal(rest.opacity, '0', 'action stays hidden at rest outside hover and focus')
  assert(await allNoHover(), 'pointer must remain outside all tree labels and buttons')
  const initialGeometry = await evaluate(
    `(()=>Object.fromEntries([...document.querySelectorAll('[role=treeitem]')].map(row=>{const name=row.querySelector('.truncate');const action=row.querySelector('[data-tree-row-action]');return[row.getAttribute('aria-label'),{nameX:name.getBoundingClientRect().x,actionRight:action.getBoundingClientRect().right}]})))()`,
  )
  const hoverStates = []
  for (const path of ['parent', 'a-long-folder-name-to-test-row-geometry']) {
    const rect = await evaluate(
      `(()=>{const e=document.querySelector('[role=treeitem][aria-label=${JSON.stringify(path)}] [data-tree-row-action]');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    await until(
      `getComputedStyle(document.querySelector('[role=treeitem][aria-label=${JSON.stringify(path)}] [data-tree-row-action]')).opacity==='1'`,
      `hover reveal ${path}`,
    )
    const state = await evaluate(
      `(()=>{const row=document.querySelector('[role=treeitem][aria-label=${JSON.stringify(path)}]');const label=row.querySelector('.truncate');const action=row.querySelector('[data-tree-row-action]');const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right}};return{path:${JSON.stringify(path)},opacity:getComputedStyle(action).opacity,label:box(label),action:box(action),hover:action.matches(':hover')}})()`,
    )
    assert.equal(state.opacity, '1')
    assert(state.hover, `pointer physically hovers ${path} action`)
    assert(state.label.x < state.action.x, `name precedes ${path} trailing action`)
    assert(
      Math.abs(state.label.x - initialGeometry[path].nameX) < 1,
      `${path} name does not shift on hover`,
    )
    assert(
      Math.abs(state.action.right - initialGeometry[path].actionRight) < 1,
      `${path} trailing edge remains fixed on hover`,
    )
    hoverStates.push(state)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 680, y: 760 })
    await until(
      `getComputedStyle(document.querySelector('[role=treeitem][aria-label=${JSON.stringify(path)}] [data-tree-row-action]')).opacity==='0'`,
      `hover exit hides ${path}`,
    )
    assert(await allNoHover(), `pointer exited ${path}`)
    await assertAllHidden(`after hover exits ${path}`)
  }
  assert(
    Math.abs(hoverStates[0].action.right - hoverStates[1].action.right) < 1,
    'short and long folder trailing action edges align',
  )
  await cdp('Page.stopScreencast')
  const hoverFrames = videoFrames.splice(0)
  await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  let focusedByKeyboard = false
  for (let i = 0; i < 40; i++) {
    await key('Tab')
    if (await evaluate(`document.activeElement?.matches('[role="treeitem"]')`)) {
      focusedByKeyboard = true
      break
    }
  }
  assert(focusedByKeyboard, 'Tab must reach an outer treeitem using native keyboard traversal')
  for (
    let i = 0;
    i < 6 && !(await evaluate(`document.activeElement.getAttribute('aria-label')==='parent'`));
    i++
  )
    await key('ArrowDown')
  await until(
    `document.activeElement?.getAttribute('aria-label')==='parent'`,
    'ArrowDown to parent row',
  )
  await until(
    `getComputedStyle(document.querySelector('[role="treeitem"][aria-label="parent"] [data-tree-row-action]')).opacity==='1'`,
    'row action fully revealed',
  )
  assert(await allNoHover())
  const rowBefore = await metrics()
  assert.equal(rowBefore.opacity, '1', 'outer focused treeitem must reveal its subscription action')
  assert.equal(rowBefore.hoverLabels, 0)
  assert.equal(rowBefore.hoverButtons, 0)
  assert(rowBefore.name.x < rowBefore.action.x, 'name must remain before trailing action')
  await screenshot('row-focus.png')
  // Tab reaches the actual folder button; Enter changes its subscription through the fixture tRPC adapter.
  await key('Tab')
  await until(
    `document.activeElement?.matches('[data-tree-row-action]')`,
    'Tab to folder subscription button',
  )
  await until(
    `getComputedStyle(document.activeElement).opacity==='1'`,
    'button action fully revealed',
  )
  const buttonFocusOpacity = await evaluate('getComputedStyle(document.activeElement).opacity')
  assert(await allNoHover())
  await screenshot('button-focus.png')
  await key('Enter')
  await until(`window.__folderBellCalls.length===1`, 'Enter activation')
  assert.deepEqual(await evaluate('window.__folderBellCalls'), [{ path: 'parent', enabled: true }])
  await until(
    `document.querySelector('[role="treeitem"][aria-label="parent"] [data-tree-row-action]')?.disabled===false`,
    'subscription mutation settles before pointer click',
  )
  const pointerPoint = await evaluate(
    `(()=>{const r=document.querySelector('[role="treeitem"][aria-label="parent"] [data-tree-row-action]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointerPoint })
  await cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: pointerPoint.x,
    y: pointerPoint.y,
    button: 'left',
    clickCount: 1,
  })
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: pointerPoint.x,
    y: pointerPoint.y,
    button: 'left',
    clickCount: 1,
  })
  await until(`window.__folderBellCalls.length===2`, 'pointer unsubscribe activation')
  assert.deepEqual(await evaluate('window.__folderBellCalls'), [
    { path: 'parent', enabled: true },
    { path: 'parent', enabled: false },
  ])
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 680, y: 760 })
  const buttonFocusedNameX = await evaluate(
    `document.querySelector('[role="treeitem"][aria-label="parent"] [data-slot="tree-item-label"] .truncate').getBoundingClientRect().x`,
  )
  assert(
    Math.abs(buttonFocusedNameX - rowBefore.name.x) < 1,
    'button focus does not shift the folder name',
  )
  // Return to the same row through native Tab traversal and use ArrowRight to expand it.
  for (
    let i = 0;
    i < 40 &&
    !(await evaluate(`document.activeElement?.matches('[role="treeitem"][aria-label="parent"]')`));
    i++
  )
    await key('Tab')
  await until(
    `document.activeElement?.matches('[role="treeitem"][aria-label="parent"]')`,
    'Tab back to outer row after pointer click',
  )
  await key('ArrowRight')
  await until(
    `document.querySelector('[role="treeitem"][aria-label="parent"]').getAttribute('aria-expanded')==='true'`,
    'ArrowRight expands parent',
  )
  await until(
    `!!document.querySelector('[role="treeitem"][aria-label="nested"]')`,
    'nested folder rendered',
  )
  assert(await allNoHover(), 'nested geometry check must be hover-free')
  const nestedBeforeHover = await evaluate(
    `(()=>{const row=document.querySelector('[role=treeitem][aria-label="nested"]');const name=row.querySelector('.truncate').getBoundingClientRect();const action=row.querySelector('[data-tree-row-action]').getBoundingClientRect();return{nameX:name.x,actionRight:action.right}})()`,
  )
  const nestedButtonPoint = await evaluate(
    `(()=>{const e=document.querySelector('[role=treeitem][aria-label="nested"] [data-tree-row-action]');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...nestedButtonPoint })
  await until(
    `getComputedStyle(document.querySelector('[role=treeitem][aria-label="nested"] [data-tree-row-action]')).opacity==='1'`,
    'hover reveal nested folder action',
  )
  const nestedHover = await evaluate(
    `(()=>{const e=document.querySelector('[role=treeitem][aria-label="nested"] [data-tree-row-action]');return{opacity:getComputedStyle(e).opacity,hover:e.matches(':hover')}})()`,
  )
  assert(nestedHover.hover, 'pointer physically hovers nested action')
  const nestedDuringHover = await evaluate(
    `(()=>{const row=document.querySelector('[role=treeitem][aria-label="nested"]');const name=row.querySelector('.truncate').getBoundingClientRect();const action=row.querySelector('[data-tree-row-action]').getBoundingClientRect();return{nameX:name.x,actionRight:action.right}})()`,
  )
  assert(
    Math.abs(nestedDuringHover.nameX - nestedBeforeHover.nameX) < 1,
    'nested name does not shift on hover',
  )
  assert(
    Math.abs(nestedDuringHover.actionRight - nestedBeforeHover.actionRight) < 1,
    'nested trailing edge remains fixed on hover',
  )
  hoverStates.push({ path: 'nested', ...nestedHover, ...nestedDuringHover })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 680, y: 760 })
  await until(
    `getComputedStyle(document.querySelector('[role=treeitem][aria-label="nested"] [data-tree-row-action]')).opacity==='0'`,
    'hover exit hides nested folder',
  )
  assert(await allNoHover(), 'pointer is outside before nested row measurements')
  const nested = await evaluate(
    `(()=>{const parent=document.querySelector('[role="treeitem"][aria-label="parent"]');const child=document.querySelector('[role="treeitem"][aria-label="nested"]');const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right}};return{parentAction:box(parent.querySelector('[data-tree-row-action]')),nestedAction:box(child.querySelector('[data-tree-row-action]')),nestedName:box(child.querySelector('.truncate')),nestedOpacity:getComputedStyle(child.querySelector('[data-tree-row-action]')).opacity,hoverLabels:[...document.querySelectorAll('[data-slot="tree-item-label"]')].filter(e=>e.matches(':hover')).length,hoverButtons:[...document.querySelectorAll('[data-tree-row-action]')].filter(e=>e.matches(':hover')).length}})()`,
  )
  assert.equal(nested.nestedOpacity, '0', 'unfocused nested action remains hidden at rest')
  assert.equal(nested.hoverLabels, 0)
  assert.equal(nested.hoverButtons, 0)
  assert(
    Math.abs(nested.parentAction.right - nested.nestedAction.right) < 1,
    'nested/parent trailing action edges align',
  )
  assert(nested.nestedName.x > rowBefore.name.x, 'nested name has the expected deeper indent')
  const restored = await metrics()
  assert(
    Math.abs(restored.name.x - rowBefore.name.x) < 1,
    'revealing the action cannot shift the name',
  )
  const hoverCheckedNodes = await evaluate(
    `document.querySelectorAll('[data-slot="tree-item-label"],[data-tree-row-action]').length`,
  )
  for (
    let i = 0;
    i < 10 && (await evaluate(`!!document.activeElement?.closest('[data-slot="tree-item"]')`));
    i++
  )
    await key('Tab')
  await until(
    `!document.activeElement?.closest('[data-slot="tree-item"]')`,
    'Tab focus exits folder row to toolbar',
  )
  await until(
    `([...document.querySelectorAll('[data-tree-row-action]')].every(e=>getComputedStyle(e).opacity==='0'))`,
    'every folder action fades to rest after focus exit',
  )
  assert(await allNoHover(), 'focus-exit assertion is pointer-free')
  const finalHiddenButtons = await assertAllHidden('after focus exits tree')
  const report = {
    result: 'PASS',
    actualProductionFilesSection: true,
    actualNativeKeyboard: true,
    hoverFree: true,
    initialFolderActions: initialButtons,
    finalFolderActions: finalHiddenButtons,
    actualPointerHover: hoverStates,
    focusExit: 'toolbar; all visible folder actions opacity 0',
    hoverCheckedNodes,
    rowFocusOpacity: rowBefore.opacity,
    buttonFocusOpacity,
    restingOpacity: rest.opacity,
    arrowNavigation: 'ArrowDown to parent; ArrowRight reveals nested row',
    nestedTrailingEdgesAligned: true,
    nameDidNotShift: true,
    enterMutation: await evaluate('window.__folderBellCalls[0]'),
    pointerMutation: await evaluate('window.__folderBellCalls[1]'),
    pointer: { x: 680, y: 760 },
    screenshots: ['row-focus.png', 'button-focus.png'],
    recordings: ['folder-subscriptions-hover.webm', 'folder-subscriptions-keyboard.webm'],
  }
  await cdp('Page.stopScreencast')
  assert(videoFrames.length > 0, 'native screencast must capture real rendered frames')
  const keyboardFrames = videoFrames.splice(0)
  const encode = (frames, filename) =>
    spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        '-framerate',
        '3',
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        join(evidence, filename),
      ],
      { input: Buffer.concat(frames), encoding: 'utf8', timeout: 30000 },
    )
  const keyboardEncoded = encode(keyboardFrames, 'folder-subscriptions-keyboard.webm')
  assert.equal(keyboardEncoded.status, 0, `keyboard video encode failed: ${keyboardEncoded.stderr}`)
  const hoverEncoded = encode(hoverFrames, 'folder-subscriptions-hover.webm')
  assert.equal(hoverEncoded.status, 0, `hover video encode failed: ${hoverEncoded.stderr}`)
  await writeFile(join(evidence, 'assertions.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  cdpClient?.close()
  socket?.close()
  if (child && !processState.exit && !processState.spawnFailure) {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      processState.closed,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ])
    if (!exited) {
      child.kill('SIGKILL')
      await Promise.race([processState.closed, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
  }
  await writeFile(join(evidence, 'electron-smoke.log'), logs)
  if (server?.listening) await new Promise((resolve) => server.close(resolve))
  if (processState?.exit || !child || processState?.spawnFailure)
    await rm(root, { recursive: true, force: true })
  else console.error(`Preserving owned profile because Electron remains alive: ${root}`)
}
