import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-564-evidence-final')
const root = await mkdtemp(join(tmpdir(), 'holi-564-native-'))
const profile = join(root, 'profile')
let child
let server
let fixtureUrl
let socket
let logs = ''
let nextId = 0
const pending = new Map()
const browserErrors = []
const videoFrames = []
let ackScreencastFrame = () => {}
try {
  await mkdir(evidence, { recursive: true })
  for (const name of [
    'folder-subscriptions-final.webm',
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
            return `const calls=()=>window.__folderBellCalls; export const trpc={subscriptions:{list:{query:async({paths})=>JSON.parse(paths).map(path=>({path,explicit:false,coveredBy:null,baseline:null}))},set:{mutate:async({path,enabled})=>{calls().push({path,enabled})}}}}`
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
  child.stdout.on('data', (chunk) => {
    logs += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
    process.stderr.write(chunk)
  })
  const wait = async (fn, label, ms = 30000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        const x = await fn()
        if (x) return x
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    throw Error(
      `Timed out: ${label}; body=${await evaluate('document.body.innerHTML')}; errors=${JSON.stringify(browserErrors)}`,
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
  socket.addEventListener('message', (event) => {
    const m = JSON.parse(event.data)
    if (m.method === 'Runtime.exceptionThrown' || m.method === 'Runtime.consoleAPICalled')
      browserErrors.push(m)
    if (m.method === 'Page.screencastFrame') {
      videoFrames.push(Buffer.from(m.params.data, 'base64'))
      ackScreencastFrame(m.params.sessionId)
    }
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result)
    }
  })
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId
      pending.set(id, { resolve: res, reject: rej })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const target = await wait(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page',
      ),
    'page target',
  )
  const { sessionId } = await call('Target.attachToTarget', { targetId: target.id, flatten: true })
  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId
      pending.set(id, { resolve: res, reject: rej })
      socket.send(JSON.stringify({ id, sessionId, method, params }))
    })
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text)
    return r.result.value
  }
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
    const text = key.length === 1 ? key : key === 'Enter' ? '\\r' : undefined
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
  ackScreencastFrame = (screencastSessionId) => {
    void cdp('Page.screencastFrameAck', { sessionId: screencastSessionId })
  }
  const screenshot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(evidence, name), Buffer.from(r.data, 'base64'))
  }
  await until(
    '!!window.__folderBellReady && !!document.querySelector(\'[role="tree"] [role="treeitem"]\')',
    'production FilesSection mounted',
  )
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
  const rest = await metrics()
  assert.equal(rest.opacity, '0', 'action stays hidden at rest outside hover and focus')
  assert(await allNoHover(), 'pointer must remain outside all tree labels and buttons')
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
  execFileSync('agent-browser', ['--cdp', port, 'press', 'Enter'], { encoding: 'utf8' })
  await until(`window.__folderBellCalls.length===1`, 'Enter activation')
  assert.deepEqual(await evaluate('window.__folderBellCalls'), [{ path: 'parent', enabled: true }])
  const buttonFocusedNameX = await evaluate(
    `document.querySelector('[role="treeitem"][aria-label="parent"] [data-slot="tree-item-label"] .truncate').getBoundingClientRect().x`,
  )
  assert(
    Math.abs(buttonFocusedNameX - rowBefore.name.x) < 1,
    'button focus does not shift the folder name',
  )
  // Return to the same row and use the tree's native ArrowRight to expose its nested row.
  await key('Tab', 8)
  await until(
    `document.activeElement?.getAttribute('aria-label')==='parent'`,
    'Shift+Tab back to outer row',
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
  const report = {
    result: 'PASS',
    actualProductionFilesSection: true,
    actualNativeKeyboard: true,
    hoverFree: true,
    hoverCheckedNodes,
    rowFocusOpacity: rowBefore.opacity,
    buttonFocusOpacity,
    restingOpacity: rest.opacity,
    arrowNavigation: 'ArrowDown to parent; ArrowRight reveals nested row',
    nestedTrailingEdgesAligned: true,
    nameDidNotShift: true,
    enterMutation: await evaluate('window.__folderBellCalls[0]'),
    pointer: { x: 680, y: 760 },
    screenshots: ['row-focus.png', 'button-focus.png'],
  }
  await cdp('Page.stopScreencast')
  assert(videoFrames.length > 0, 'native screencast must capture real rendered frames')
  const encoded = spawnSync(
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
      join(evidence, 'folder-subscriptions-final.webm'),
    ],
    { input: Buffer.concat(videoFrames), encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(encoded.status, 0, `ffmpeg video encode failed: ${encoded.stderr}`)
  await writeFile(join(evidence, 'assertions.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  socket?.close()
  if (child) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('close', resolve)).catch(() => {})
  }
  await writeFile(join(evidence, 'electron-smoke.log'), logs)
  if (server?.listening) await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
