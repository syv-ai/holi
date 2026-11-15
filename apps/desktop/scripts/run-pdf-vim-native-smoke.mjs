import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  process.argv.slice(2).find((arg) => arg !== '--') ?? '/tmp/holi-pr512-native',
)
let root
let evidenceReady = false
let child
let closed
let succeeded = false
let closeWindow
let log = ''
let ws
let id = 0
const pending = new Map()
const frames = []
const makePdf = () => {
  const stream = [
    'BT /F1 12 Tf 72 720 Td (Holi PDF Vim native fixture) Tj ET',
    'BT /F1 12 Tf 72 690 Td (Searchable synthetic document) Tj ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  ]
  let text = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text, 'latin1'))
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(text, 'latin1')
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<</Size ${offsets.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text, 'latin1')
}
const pdf = makePdf()
try {
  await mkdir(evidence, { recursive: true })
  assert.deepEqual(await readdir(evidence), [], `refusing to overwrite ${evidence}`)
  evidenceReady = true
  root = await mkdtemp(join(tmpdir(), 'holi-pr512-native-'))
  await mkdir(join(root, 'vaults', 'synthetic-vault-a', 'docs'), { recursive: true })
  await mkdir(join(root, 'vaults', 'synthetic-vault-b', 'docs'), { recursive: true })
  await writeFile(join(root, 'vaults', 'synthetic-vault-a', 'docs', 'fixture.pdf'), pdf)
  await writeFile(join(root, 'vaults', 'synthetic-vault-b', 'docs', 'fixture.pdf'), pdf)
  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'pdf-vim-smoke-capability-seam',
        enforce: 'pre',
        transform(code, id) {
          if (!id.endsWith('/plugins/pdf/renderer/pdf-cap.ts')) return null
          return {
            code: `const bytes = Uint8Array.from(atob(${JSON.stringify(pdf.toString('base64'))}), c => c.charCodeAt(0));\nexport const pdfCap = { signatures: async () => '[]', saveSignatures: async () => ({}) };\nexport const readPdf = async (remote, path) => { const calls = window.__holiPdfCalls ??= []; calls.push({op:'read',remote,path}); return bytes.slice() };\nexport const writePdf = async (remote,path,data) => { const calls = window.__holiPdfCalls ??= []; calls.push({op:'write',remote,path,size:data.length}); return {updatedAt:'smoke-write'} };\nexport const readNoteText = async () => '';`,
            map: null,
          }
        },
      },
    ],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: { input: join(desktop, 'scripts/pdf-vim-native-smoke.html') },
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
        input: join(desktop, 'scripts/pdf-vim-native-smoke-main.ts'),
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
    JSON.stringify({ name: 'holi-pr512-pdf-vim-smoke', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const portServer = createServer()
  await new Promise((resolve, reject) => {
    portServer.once('error', reject)
    portServer.listen(0, '127.0.0.1', resolve)
  })
  const debugPort = portServer.address().port
  await new Promise((resolve, reject) =>
    portServer.close((error) => (error ? reject(error) : resolve())),
  )
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    HOLI_PDF_SMOKE_ROOT: root,
    HOLI_PDF_SMOKE_EVIDENCE: evidence,
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
  let evaluate = async () => {
    throw new Error('renderer evaluation is unavailable before CDP attachment')
  }
  const wait = async (fn, description, timeout = 30000) => {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const value = await fn().catch(() => null)
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const diagnostics = await evaluate(
      `JSON.stringify({url:location.href,title:document.title,body:document.body?.innerText,html:document.body?.innerHTML?.slice(0,1200),shadow:document.querySelector('holi-pdf-container')?.shadowRoot?.innerHTML?.slice(-3500),calls:window.__holiPdfCalls,nodes:[...document.querySelector('holi-pdf-container')?.shadowRoot?.querySelectorAll('*')??[]].filter(e=>e.tagName!=='STYLE').map(e=>({tag:e.tagName,cls:e.className?.toString?.().slice(0,80),data:e.getAttributeNames().filter(n=>n.startsWith('data-')).slice(0,4),text:e.textContent?.trim().slice(0,25)})).slice(0,50)})`,
    ).catch((error) => String(error))
    throw new Error(`timeout waiting for ${description}; ${diagnostics}`)
  }
  // Find Electron's ephemeral debugging endpoint from its stdout.
  const endpoint = await wait(
    async () =>
      fetch(`http://127.0.0.1:${debugPort}/json/version`)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    'Electron CDP endpoint',
  )
  ws = new WebSocket(endpoint.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const browserCall = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const callId = ++id
      pending.set(callId, { resolve, reject })
      ws.send(JSON.stringify({ id: callId, method, params }))
    })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Page.screencastFrame') {
      frames.push(Buffer.from(msg.params.data, 'base64'))
      ws.send(
        JSON.stringify({
          id: -frames.length,
          sessionId: msg.sessionId,
          method: 'Page.screencastFrameAck',
          params: { sessionId: msg.params.sessionId },
        }),
      )
    }
    if (msg.id) {
      const entry = pending.get(msg.id)
      if (entry) {
        pending.delete(msg.id)
        msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result)
      }
    }
  })
  await browserCall('Target.setDiscoverTargets', { discover: true })
  const targets = await browserCall('Target.getTargets')
  const page = targets.targetInfos.find((target) => target.type === 'page')
  assert(page, 'native Electron page not found')
  const attached = await browserCall('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  })
  const sessionId = attached.sessionId
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const callId = ++id
      pending.set(callId, { resolve, reject })
      ws.send(JSON.stringify({ id: callId, sessionId, method, params }))
    })
  // Flattened sessions place target responses on the browser websocket.
  await call('Page.enable')
  await call('Runtime.enable')
  evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  closeWindow = () => evaluate('window.close()')
  const until = async (expression, description) =>
    wait(async () => evaluate(expression), description)
  const settle = () =>
    evaluate(
      `(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`,
    )
  const key = async (keyName) => {
    await settle()
    if (keyName === 'f') await readyPdf()
    const code = keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyName,
      code,
      windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : undefined,
      text: keyName.length === 1 ? keyName : undefined,
      unmodifiedText: keyName.length === 1 ? keyName : undefined,
    })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code })
  }
  const click = async (selector, shadow = false) => {
    await settle()
    const rect = await evaluate(
      `(()=>{const e=${shadow ? "document.querySelector('holi-pdf-container')?.shadowRoot?.querySelector(" + JSON.stringify(selector) + ')' : 'document.querySelector(' + JSON.stringify(selector) + ')'};if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    assert(rect, `no visible control ${selector}`)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
  }
  await until(
    `!!document.querySelector('holi-pdf-container')?.shadowRoot?.querySelector('[data-epdf-i$="-toolbar"] button')`,
    'EmbedPDF toolbar ready',
  )
  const readyPdf = () =>
    until(
      `(()=>{const viewer=document.querySelector('[data-pane-focused="true"] [data-pdf-viewer]');const host=viewer?.querySelector('[class*="motion-in-fade"]');const root=viewer?.querySelector('holi-pdf-container')?.shadowRoot;const search=root?.querySelector('[data-epdf-i$="-toolbar"] button[aria-label="Search"]');if(!host||!search)return false;const style=getComputedStyle(host);const rect=search.getBoundingClientRect();return Number(style.opacity)>0.9&&style.visibility==='visible'&&rect.width>0&&rect.height>0&&[...root.querySelectorAll('img')].some(i=>i.complete&&i.naturalWidth>0)})()`,
      'focused PDF page is rendered and its toolbar is interactive',
    )
  await readyPdf()
  await call('Page.startScreencast', {
    format: 'jpeg',
    quality: 75,
    everyNthFrame: 1,
    maxWidth: 1280,
    maxHeight: 900,
  })
  const screenshot = async (name) => {
    const result = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(evidence, name), Buffer.from(result.data, 'base64'))
  }
  const hintCount = () =>
    evaluate(`document.querySelectorAll('[data-host-hints] [data-hint-key]').length`)
  const details = () =>
    evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-host-hints] [data-hint-target]')].map(e=>({key:e.dataset.hintKey,label:e.dataset.hintTarget})))`,
    ).then(JSON.parse)
  const assertTrusted = () =>
    evaluate(`window.__holiPdfTrustedKeys?.length>0 && window.__holiPdfTrustedKeys.every(Boolean)`)
  await evaluate(
    `window.__holiPdfTrustedKeys=[];document.addEventListener('keydown',e=>window.__holiPdfTrustedKeys.push(e.isTrusted),true)`,
  )
  await click('[data-smoke-host-action]')
  await key('f')
  await until(`!!document.querySelector('[data-host-hints]')`, 'native f opens host hints')
  const labels = await details()
  console.log(
    'native PDF hint labels:',
    JSON.stringify(labels),
    'surface registrations:',
    await evaluate('JSON.stringify(window.__holiPdfSmoke.surfaces())'),
  )
  assert(
    labels.some((entry) => entry.label.includes('Search')),
    'real PDF Search target missing',
  )
  assert(
    labels.some((entry) => !entry.label.includes('Search')),
    'host target missing',
  )
  assert(labels.length > 0, 'no host/PDF hints discovered')
  assert.equal(new Set(labels.map((entry) => entry.key)).size, labels.length, 'hint keys collide')
  for (const entry of labels) assert(entry.key.length >= 1, 'empty native hint key')
  for (const left of labels)
    for (const right of labels) {
      if (left !== right)
        assert(!right.key.startsWith(left.key), `hint key ${left.key} prefixes ${right.key}`)
    }
  await screenshot('dark.png')
  await key('Escape')
  await until(`!document.querySelector('[data-host-hints]')`, 'Escape cancels hints')
  await click('[data-pdf-fixture="a"]')
  await key('f')
  await until(`!!document.querySelector('[data-host-hints]')`, 'viewer-focused host hints')
  const focusedLabels = await details()
  assert(
    focusedLabels.some((entry) => entry.label.includes('Search')),
    'focused PDF lost Search target',
  )
  const searchHint = focusedLabels.find((entry) => entry.label.includes('Search'))
  assert(searchHint, 'Search hint unavailable for activation')
  for (const character of searchHint.key) await key(character)
  const fieldSelector = `document.querySelector('holi-pdf-container').shadowRoot.querySelector('[data-sidebar-id="search-panel"] input[type="text"]')`
  await until(`${fieldSelector}`, 'real PDF Search opened by its native hint label')
  await click('[data-sidebar-id="search-panel"] input[type="text"]', true)
  await until(
    `document.querySelector('holi-pdf-container').shadowRoot.activeElement === ${fieldSelector}`,
    'native click focuses actual PDF Search input',
  )
  assert.equal(await hintCount(), 0, 'Search hint activation left hint overlay open')
  await key('f')
  await until(
    `${fieldSelector}.value.includes('f')`,
    'native search accepts f without host shortcut interception',
  )
  assert.equal(await hintCount(), 0, 'search typing unexpectedly opened or retained host hints')
  await key('Escape')
  await until(
    `!document.querySelector('holi-pdf-container')?.shadowRoot?.querySelector('[data-sidebar-id="search-panel"]')`,
    'search Escape closes actual panel',
  )
  await evaluate(`window.__holiPdfSmoke.vim(false)`)
  await key('f')
  assert.equal(await hintCount(), 0, 'Vim disabled still opened host hints')
  await evaluate(`window.__holiPdfSmoke.vim(true)`)
  await key('f')
  await until(`!!document.querySelector('[data-host-hints]')`, 'hints reopened')
  await evaluate(`window.__holiPdfSmoke.mutateShadow()`)
  await until(`!document.querySelector('[data-host-hints]')`, 'shadow DOM mutation cancels hints')
  await key('f')
  await until(`!!document.querySelector('[data-host-hints]')`, 'wheel cancellation session')
  await call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 500,
    y: 400,
    deltaX: 0,
    deltaY: 240,
  })
  await until(`!document.querySelector('[data-host-hints]')`, 'native wheel geometry cancels hints')
  await key('f')
  await until(`!!document.querySelector('[data-host-hints]')`, 'occlusion filter session')
  await evaluate(`window.__holiPdfSmoke.setOverlay(true)`)
  await until(`!document.querySelector('[data-host-hints]')`, 'overlay invalidated hints')
  await key('f')
  await settle()
  assert.equal(await hintCount(), 0, 'covered PDF controls leaked through the light-DOM occluder')
  await evaluate(`window.__holiPdfSmoke.setOverlay(false)`)
  await key('f')
  await until(`!!document.querySelector('[data-host-hints]')`, 'light capture hints')
  await evaluate(`window.__holiPdfSmoke.mode('light')`)
  await until(
    `document.documentElement.dataset.theme==='light'`,
    'activeModeAtom switches to light theme',
  )
  await settle()
  await screenshot('light.png')
  await key('Escape')
  await until(`!document.querySelector('[data-host-hints]')`, 'cancel light capture')

  // Exercise Chromium's state-preserving native move rather than recreating the viewer.
  await evaluate(
    `(()=>{const owner=document.querySelector('holi-pdf-container');window.__pdfMove={owner,root:owner.shadowRoot,parent:owner.parentElement};const parking=document.createElement('div');parking.style.height='600px';parking.dataset.smokeParking='';document.querySelector('[data-pane-id="b"]').append(parking);parking.moveBefore(owner,null)})()`,
  )
  await settle()
  assert.equal(
    await evaluate(
      `window.__pdfMove.owner.shadowRoot===window.__pdfMove.root && window.__pdfMove.owner.isConnected`,
    ),
    true,
    'native move replaced the PDF shadow root',
  )
  await evaluate(
    `(()=>{const state=window.__pdfMove;state.parent.moveBefore(state.owner,null);document.querySelector('[data-smoke-parking]').remove()})()`,
  )
  await readyPdf()
  await key('f')
  await until(
    `!!document.querySelector('[data-host-hints]')`,
    'retained viewer hints after native move',
  )
  assert(
    (await details()).some((entry) => entry.label === 'Search'),
    'native move lost owned PDF registration',
  )
  await key('Escape')

  // Isolation/lifetime checks through actual production PdfViewer instances and the host shell.
  await evaluate(`window.__holiPdfSmoke.remote('synthetic/vault-b')`)
  await until(`window.__holiPdfSmoke.state().remote==='synthetic/vault-b'`, 'vault B active')
  await key('f')
  await until(
    `!!document.querySelector('[data-host-hints]')`,
    'vault B hints available after A-B scope transition',
  )
  const vaultBLabels = await details()
  await evaluate(`window.__holiPdfSmoke.remote('synthetic/vault-a')`)
  await until(`window.__holiPdfSmoke.state().remote==='synthetic/vault-a'`, 'vault A restored')
  await until(`!document.querySelector('[data-host-hints]')`, 'A-B-A invalidates B hint session')
  const staleTarget = vaultBLabels.find((entry) => entry.label.includes('Search'))
  if (staleTarget) for (const character of staleTarget.key) await key(character)
  assert.equal(await hintCount(), 0, 'stale B hint activation survived A-B-A transition')
  await key('f')
  await until(
    `!!document.querySelector('[data-host-hints]')`,
    'old viewer session active before source replacement',
  )
  const oldLabels = await details()
  const oldSearch = oldLabels.find((entry) => entry.label === 'Search')
  assert(oldSearch, 'old PDF Search target missing before replacement')
  await evaluate(`window.__holiPdfSmoke.viewer('docs/replaced.pdf',true,true)`)
  await until(
    `!document.querySelector('[data-host-hints]')`,
    'source replacement invalidates old labels',
  )
  await until(
    `document.querySelector('[data-pdf-viewer="docs/replaced.pdf"]') && [...document.querySelector('holi-pdf-container')?.shadowRoot?.querySelectorAll('img')??[]].some(i=>i.complete&&i.naturalWidth>0)`,
    'replacement PDF ready',
  )
  for (const character of oldSearch.key) await key(character)
  assert.equal(await hintCount(), 0, 'old hint session survived source replacement')
  assert.equal(
    await evaluate(
      `!!document.querySelector('holi-pdf-container')?.shadowRoot?.querySelector('[data-sidebar-id="search-panel"]')`,
    ),
    false,
    'stale Search label opened replacement Search',
  )
  await settle()
  await key('f')
  await until(`!!document.querySelector('[data-host-hints]')`, 'replacement viewer hints')
  const replacementSearch = (await details()).find((entry) => entry.label === 'Search')
  assert(replacementSearch, 'replacement PDF has no actual Search target')
  await evaluate(`window.__holiPdfSmoke.focusPane('b')`)
  await until(
    `document.querySelector('[data-pane-id="b"]').getAttribute('data-pane-focused')==='true'`,
    'split pane B receives focus',
  )
  await click('[data-pdf-fixture="b"]')
  await key('f')
  await until(
    `!!document.querySelector('[data-host-hints]')`,
    'inactive pane does not own hints; active split pane does',
  )
  assert.equal(
    (await details()).filter((entry) => entry.label === 'Search').length,
    1,
    'split panes duplicated PDF targets',
  )
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('[data-host-hints] [data-hint-key]')).every(e=>e.getBoundingClientRect().left>=innerWidth/2)`,
    ),
    true,
    'inactive pane A leaked targets into B hint session',
  )
  await evaluate(`window.__holiPdfSmoke.focusPane('a')`)
  await until(
    `!document.querySelector('[data-host-hints]')`,
    'pane ownership change invalidates hint session',
  )
  await evaluate(`window.__holiPdfSmoke.viewer('docs/replaced.pdf',false,false)`)
  await until(
    `!document.querySelector('[data-host-hints]')`,
    'hidden/inactive viewer hint session canceled',
  )
  const publicState = await evaluate(
    `JSON.stringify({calls:window.__holiPdfCalls??[], hints:document.querySelectorAll('[data-host-hints] [data-hint-key]').length})`,
  )
  assert(
    JSON.parse(publicState).calls.some(
      (entry) => entry.op === 'read' && entry.remote === 'synthetic/vault-a',
    ),
    'synthetic PDF read seam did not run',
  )
  await call('Page.stopScreencast')
  assert(frames.length > 0, 'no actual interaction frames recorded')
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      '8',
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-pix_fmt',
      'yuv420p',
      join(evidence, 'interaction.mp4'),
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  )
  let encoderLog = ''
  ffmpeg.stderr.on('data', (chunk) => {
    encoderLog += chunk
  })
  const encoded = new Promise((resolve, reject) => {
    ffmpeg.once('error', reject)
    ffmpeg.once('close', resolve)
  })
  ffmpeg.stdin.on('error', () => {})
  ffmpeg.stdin.end(Buffer.concat(frames))
  assert.equal(await encoded, 0, `native recording encoding failed: ${encoderLog}`)
  const result = {
    task: 'PR512 PDF Vim native Electron smoke',
    checks: [
      'production-PdfViewer-PdfDocument-PdfViewerAdapter-EmbedPDF-HostHintLayer-useShortcutDispatcher',
      'trusted-native-prefix-free-combined-hints-and-Search-activation',
      'Search-f-typing-and-Escape',
      'Vim-disabled-passthrough',
      'shadow-DOM-mutation-cancellation',
      'trusted-native-wheel-cancellation',
      'light-DOM-occlusion-and-theme-capture',
      'vault-A-B-A-and-viewer-source-replacement',
      'inactive-viewer cancellation',
      'retained-native-moves-preserve-owned-shadow-root-and-hints',
      'focused-split-pane-excludes-inactive-viewer-targets',
      'stale-Search-label-cannot-open-replacement-viewer',
      'native-interaction-recording',
    ],
    evidence: ['dark.png', 'light.png', 'interaction.mp4', 'fixture.pdf', 'electron.log'],
    recordedFrames: frames.length,
    synthetic: true,
    networkDenied: true,
    permissionsDenied: true,
    trustedNativeKeyboard: await assertTrusted(),
    fixtureCalls: JSON.parse(publicState).calls,
    limits: [
      'PDF files.read/files.write and pdf signatures are harness-only in-memory adapters; production main IPC, real vault filesystem, networked session and packaged application are out of scope.',
      'Vim toggle, focus/visibility, vault identity and source replacement are driven through the fixture control surface; this does not validate app-shell tab switching or actual vault watcher delivery.',
    ],
  }
  assert(result.trustedNativeKeyboard, 'native keyboard events were not trusted')
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  await writeFile(join(evidence, 'fixture.pdf'), pdf)
  succeeded = true
} finally {
  if (child && child.exitCode === null) {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        await closeWindow()
      } catch {}
    }
    const exited = await Promise.race([
      closed.then((code) => ({ code })),
      new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
    ])
    if (!exited && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
    }
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await closed.catch(() => {})
    }
    if (succeeded) assert.equal(child.exitCode, 0, 'Electron did not exit cleanly')
  }
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  if (evidenceReady) await writeFile(join(evidence, 'electron.log'), log).catch(() => {})
  if (root) await rm(root, { recursive: true, force: true })
  const resultPath = join(evidence, 'result.json')
  const result = evidenceReady
    ? await readFile(resultPath, 'utf8')
        .then(JSON.parse)
        .catch(() => null)
    : null
  if (result) {
    result.cleanup = {
      electronExitCode: child?.exitCode ?? null,
      tempRootDeleted: root
        ? !(await stat(root)
            .then(() => true)
            .catch(() => false))
        : true,
      processExited: child ? child.exitCode !== null : true,
    }
    await writeFile(resultPath, JSON.stringify(result, null, 2))
  }
}
