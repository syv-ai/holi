import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, copyFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, clipboard, ipcMain, protocol } from 'electron'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'holi-vault',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])
import { readMarkdownCaptionEnvelopes, readMarkdownCodeCaptions } from '@holi/shared'
import { init } from '@embedpdf/pdfium'
import { PdfiumNative } from '@embedpdf/engines/pdfium'
import { createRouter, type RouterDeps } from '../src/main/router'
import { openRepo } from '../src/main/git'
import { VaultRegistry } from '../src/main/vault/registry'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore } from '../src/main/github/token-store'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { noCoreServices } from '../src/main/capabilities/services'
import { createBridgeServer } from '../src/main/bridge/server'
import { installHoliCli } from '../src/main/bridge/cli'
import { publishCliEndpoint } from '../src/main/bridge/cli-endpoint'
import {
  pdfCapabilities,
  PDF_NAMESPACES,
  type PdfCapabilityDeps,
} from '../src/plugins/pdf/main/capabilities'

const exec = promisify(execFile)
const root = process.env.HOLI_535_ROOT!
const evidence = process.env.HOLI_535_EVIDENCE!
const typst = process.env.HOLI_535_TYPST!
assert(root && evidence && typst, 'runner must provide isolated roots and Typst')
const remote = 'fixture/captions'
const vault = join(root, 'vault')
const path = 'notes/Code-caption.md'
const note = join(vault, path)
const head = '---\ntitle:  Byte-sensitive caption\n# Keep this comment\ntags: [kept]\n---\n\n'
const originalFence = '~~~typescript extra-info\nconst value = 1\n~~~'
const initial = `${head}# Code caption\n\nBefore the code.\n\n${originalFence}\n\nAfter the code.\n`
const imageSource = '![Smoke photo](../assets/smoke.png "Photo title")'
const imageCaption = 'Image **portable** caption.'
const renderedImageCaption = 'Image portable caption.'
const checks: string[] = []
const captures: string[] = []
const rendererErrors: string[] = []
const imageRequests: { url: string; bytes?: number; status: number }[] = []
const denied: string[] = []
const calls: { door: string; name: string }[] = []
const roots = { app: root, profile: join(root, 'profile'), session: join(root, 'session'), vault }
// Profile and session paths must be fixed synchronously, before Electron can
// become ready during any fixture filesystem await.
for (const dir of [roots.profile, roots.session, join(root, 'app-data')])
  mkdirSync(dir, { recursive: true })
app.setName('Holi image captions QA 535')
app.setPath('appData', join(root, 'app-data'))
app.setPath('userData', roots.profile)
app.setPath('sessionData', roots.session)
assert.equal(app.isReady(), false)
assert.equal(app.getPath('userData'), roots.profile)
assert.equal(app.getPath('sessionData'), roots.session)

let writes = 0
let historyReads = 0
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const mark = (name: string) => {
  checks.push(name)
  console.log(`PASS ${name}`)
}

async function inspectPdf(file: string) {
  const require = createRequire(join(process.env.HOLI_535_DESKTOP!, 'package.json'))
  const wasm = await readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  const module = await init({
    wasmBinary: wasm.buffer.slice(
      wasm.byteOffset,
      wasm.byteOffset + wasm.byteLength,
    ) as ArrayBuffer,
  })
  module.PDFiumExt_Init()
  const engine = new PdfiumNative(module)
  const bytes = await readFile(file)
  const doc = await engine
    .openDocumentBuffer({
      id: file,
      content: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    })
    .toPromise()
  try {
    assert.equal(doc.pages.length, 1)
    const page = doc.pages[0]!
    const glyphs = await engine.getPageGlyphs(doc, page).toPromise()
    const slices = await engine
      .getTextSlices(
        doc,
        glyphs.map((_glyph, charIndex) => ({ pageIndex: 0, charIndex, charCount: 1 })),
      )
      .toPromise()
    const text = slices.join('')
    const textGlyphs = slices.flatMap((part, index) => part.split('').map(() => glyphs[index]!))
    assert.match(text.replace(/\s+/g, ' '), /Image portable caption\./)
    assert(!text.includes('holi:figure') && !text.includes('holi:caption'))
    const at = text.indexOf('Image portable caption.')
    assert(at >= 0)
    const caption = textGlyphs
      .slice(at, at + renderedImageCaption.length)
      .filter((g) => g.size.width > 0 && !g.isEmpty)
    assert(caption.length > 10)
    assert(Buffer.from(await readFile(file)).includes(Buffer.from('/Subtype /Image')))
    const left = Math.min(...caption.map((g) => g.origin.x))
    const right = Math.max(...caption.map((g) => g.origin.x + g.size.width))
    assert(
      Math.abs((left + right) / 2 - page.size.width / 2) < 3,
      `PDF caption center ${(left + right) / 2} must match page center ${page.size.width / 2}`,
    )
    for (const g of glyphs.filter((g) => g.size.width > 0 && g.size.height > 0)) {
      assert(g.origin.x >= 0 && g.origin.x + g.size.width <= page.size.width + 1)
      assert(g.origin.y >= 0 && g.origin.y + g.size.height <= page.size.height + 1)
    }
    return {
      text,
      pages: doc.pages.length,
      captionCenter: (left + right) / 2,
      pageWidth: page.size.width,
    }
  } finally {
    await engine.closeDocument(doc).toPromise()
  }
}

async function run() {
  for (const dir of [
    roots.profile,
    roots.session,
    join(root, 'app-data'),
    join(vault, 'notes'),
    join(vault, 'assets'),
  ])
    await mkdir(dir, { recursive: true })
  await writeFile(note, initial)
  await writeFile(join(vault, 'notes/Clipboard.md'), '# Clipboard target\n\nReceiver text.\n')
  await writeFile(join(vault, '.holi/vault'), '1\n')
  await exec('git', ['init', '-b', 'main'], { cwd: vault })
  await exec('git', ['add', '-f', path], { cwd: vault })
  await exec(
    'git',
    [
      '-c',
      'user.name=Holi acceptance',
      '-c',
      'user.email=acceptance@holi.invalid',
      'commit',
      '-m',
      'seed image caption fixture',
    ],
    { cwd: vault },
  )
  const historyRepo = openRepo(vault, {
    identity: { name: 'Holi acceptance', email: 'acceptance@holi.invalid' },
  })
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const registry = new VaultRegistry(join(roots.profile, 'vaults.json'))
  await registry.add({
    remote,
    path: vault,
    name: 'Caption fixture',
    lastOpenedAt: new Date().toISOString(),
  })
  const session = await GitHubSession.load({
    store: new TokenStore(join(roots.profile, 'github-auth.enc'), {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    }),
    fetch: async () => {
      throw new Error('No GitHub access in caption acceptance')
    },
  })
  const capabilities = createCapabilityRegistry()
  capabilities.register(
    PDF_NAMESPACES,
    pdfCapabilities({
      typst: async () => typst,
      diagrams: async () => {
        throw new Error('Ordinary-code fixture must not draw Mermaid')
      },
      signatures: {
        read: async () => [],
        write: async () => {},
      } as unknown as PdfCapabilityDeps['signatures'],
    }),
  )
  const host = createCapabilityHost({
    registry: capabilities,
    rootFor: async (r) => (r === remote ? vault : null),
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async () => true,
    claims: async () => [],
  })
  const trackedHost = {
    ...host,
    dispatch: async (call: Parameters<typeof host.dispatch>[0]) => {
      calls.push({ door: call.door, name: call.name })
      return host.dispatch(call)
    },
  }
  const caller = createRouter({
    registry,
    session,
    host: { active: () => null } as unknown as RouterDeps['host'],
    capabilities: trackedHost,
    seed: async () => ({ written: [] }),
    vaultRoot: root,
    plugins: {
      reconcile: async () => {},
      invalidate: () => {},
      setDisplayed: () => {},
      syncBackground: async () => {},
      failures: () => ({}),
      scanClaimsFor: async () => [],
    },
    openExternal: async () => {
      throw new Error('No external opens')
    },
    trashItem: async () => {
      throw new Error('No trash in fixture')
    },
    showItemInFolder: () => {},
  }).createCaller({})
  let endpoint: Awaited<ReturnType<typeof publishCliEndpoint>> | undefined
  const bridge = createBridgeServer({
    cli: {
      dispatch: trackedHost.dispatch,
      commands: () => capabilities.commands(),
      rootFor: async () => vault,
      machine: {
        token: () => endpoint?.token ?? '',
        resolveTarget: async (selector, cwd) =>
          selector === remote ||
          (selector === null && cwd !== null && (await realpath(cwd)) === (await realpath(vault)))
            ? { remote, root: vault, live: true }
            : null,
      },
    },
  })
  await bridge.start()
  endpoint = await publishCliEndpoint(join(roots.profile, 'cli-endpoint.json'), bridge.port()!)
  const cli = await installHoliCli(roots.profile)
  const win = new BrowserWindow({
    width: 1250,
    height: 900,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: `caption-535-${process.pid}`,
      preload: join(root, 'preload.cjs'),
    },
  })
  const url = pathToFileURL(join(root, 'renderer.html')).href
  await win.webContents.session.protocol.handle('holi-vault', async (request) => {
    assert(
      ['holi-vault://vault/assets/smoke.png', 'holi-vault://vault/assets/second.png'].includes(
        request.url,
      ),
    )
    try {
      const bytes = await readFile(join(vault, new URL(request.url).pathname))
      imageRequests.push({ url: request.url, bytes: bytes.byteLength, status: 200 })
      return new Response(bytes, { headers: { 'content-type': 'image/png' } })
    } catch {
      imageRequests.push({ url: request.url, status: 404 })
      return new Response(null, { status: 404 })
    }
  })
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  )
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.webContents.session.on('will-download', (event) => {
    event.preventDefault()
    denied.push('download')
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    denied.push(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, next) => {
    if (next !== url) {
      event.preventDefault()
      denied.push(next)
    }
  })
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
    const allowed =
      details.url.startsWith(pathToFileURL(root).href + '/') ||
      ['holi-vault://vault/assets/smoke.png', 'holi-vault://vault/assets/second.png'].includes(
        details.url,
      ) ||
      details.url.startsWith('data:')
    if (!allowed) denied.push(details.url)
    done({ cancel: !allowed })
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') rendererErrors.push(event.message)
  })
  ipcMain.handle(
    'holi-caption-fixture',
    async (
      event,
      op: {
        path: string
        input: { remote: string; path: string; text: string; name: string; paramsJson: string }
      },
    ) => {
      try {
        assert(event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === url)
        if (op.path !== 'history.list') assert.equal(op.input.remote, remote)
        let data: unknown
        switch (op.path) {
          case 'notes.read':
            data = await caller.notes.read(op.input)
            break
          case 'notes.write':
            data = await caller.notes.write(op.input)
            writes++
            break
          case 'settings.read':
            data = await caller.settings.read(op.input)
            break
          case 'comments.list':
            data = await caller.comments.list(op.input)
            break
          case 'history.list':
            historyReads++
            data = await historyRepo.log({ path: op.input.path, limit: 200 })
            break
          case 'github.fileContributors':
            data = []
            break
          case 'cap.names':
            data = await caller.cap.names(op.input)
            break
          case 'cap.run':
            if (op.input.name === 'agent.providers') data = []
            else {
              assert(['pdf.templates', 'pdf.render'].includes(op.input.name))
              data = await caller.cap.run(op.input)
            }
            break
          default:
            throw new Error(`Unexpected fixture operation: ${op.path}`)
        }
        return { ok: true, data }
      } catch (error) {
        if (op.path === 'history.list') console.error('history fixture failed', op, error)
        return { ok: false, message: String(error) }
      }
    },
  )
  const js = async <T = unknown>(code: string): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(`(async()=>{${code}})()`),
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Renderer evaluation timed out: ${code}`)),
            15000,
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  async function wait(code: string, label: string) {
    const until = Date.now() + 15000
    while (Date.now() < until) {
      if (await js(`try{return Boolean(${code})}catch{return false}`)) return
      await sleep(50)
    }
    throw new Error(`Timed out: ${label}; ${await js('return document.body.innerText')}`)
  }
  async function capture(name: string) {
    const shot = (await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
      fromSurface: true,
    })) as { data: string }
    await writeFile(join(evidence, name), Buffer.from(shot.data, 'base64'))
    captures.push(name)
  }
  function press(keyCode: string, modifiers: ('meta' | 'control' | 'shift' | 'alt')[] = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  async function setRightFocus(focused: boolean) {
    await js(`window.captionFixture.rightFocused(${focused}); return true`)
    if (focused)
      await wait(`window.captionFixture.state('secondary').editable`, 'secondary focus owns editor')
    else await wait(`window.captionFixture.state('primary').editable`, 'primary focus owns editor')
  }
  async function click(selector: string) {
    const rect = await js<{ x: number; y: number }>(
      `const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...rect })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 })
    await sleep(100)
  }
  async function doubleClick(selector: string) {
    const point = await js<{ x: number; y: number }>(
      `const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 2 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 2 })
    await sleep(100)
  }
  async function menu(label: string) {
    press('/', ['meta'])
    await wait(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).some(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}))`,
      label,
    )
    await js(
      `document.querySelectorAll('[data-caption-action]').forEach(e=>e.removeAttribute('data-caption-action')); const e=Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})); e.setAttribute('data-caption-action','selected')`,
    )
    await click('[data-caption-action="selected"]')
    await wait(
      `!document.querySelector('[role="menu"][data-state="open"]') && document.activeElement?.closest('[role="textbox"]')`,
      `${label} returned editor focus`,
    )
  }
  async function dragImageDirect() {
    const source = await js<{ x: number; y: number }>(
      `const r=document.querySelector('[data-pane="primary"] figure img').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}`,
    )
    const destination = await js<{ x: number; y: number }>(
      `const r=document.querySelector('[data-pane="primary"] [role="textbox"] > p:last-of-type').getBoundingClientRect();return {x:r.right-4,y:r.bottom-1}`,
    )
    let data: Record<string, unknown> | undefined
    const intercepted = (
      _event: Electron.Event,
      method: string,
      params: { data: Record<string, unknown> },
    ) => {
      if (method === 'Input.dragIntercepted') data = params.data
    }
    win.webContents.debugger.on('message', intercepted)
    await win.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: true })
    try {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...source,
        button: 'none',
        buttons: 0,
      })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...source,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      for (let step = 1; step <= 6 && !data; step++) {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: source.x + (destination.x - source.x) * (step / 6),
          y: source.y + (destination.y - source.y) * (step / 6),
          button: 'left',
          buttons: 1,
        })
        await sleep(80)
      }
      assert(data, 'Native image drag must expose its whole-figure payload')
      await writeFile(join(evidence, 'image-native-drag-data.json'), JSON.stringify(data, null, 2))
      for (const type of ['dragEnter', 'dragOver', 'drop'])
        await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
          type,
          ...destination,
          data,
        })
    } finally {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...destination,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      await win.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: false })
      win.webContents.debugger.removeListener('message', intercepted)
    }
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1 && window.captionFixture.state().markdown.indexOf('holi:figure')>window.captionFixture.state().markdown.indexOf('After the image.')`,
      'native direct image drop',
    )
    await capture('image-direct-drag-moved.png')
    await js(`window.captionFixture.select('documentFigure'); return true`)
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().markdown.indexOf('holi:figure')<window.captionFixture.state().markdown.indexOf('After the image.')`,
      'native direct image drag undo',
    )
  }
  async function dragFigure(sourceSelector = 'figure', followingText = 'After the code.') {
    const source = await js<{ x: number; y: number }>(
      `const e=document.querySelector(${JSON.stringify(sourceSelector)});if(!e)throw Error('Missing drag source');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...source })
    await wait(
      `document.querySelector('[aria-label="Block actions"]')?.closest('[data-visible]')`,
      'native drag grip',
    )
    const grip = await js<{ x: number; y: number }>(
      `const r=document.querySelector('[aria-label="Block actions"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`,
    )
    const destination = await js<{ x: number; y: number }>(
      `const r=document.querySelector('[data-pane="primary"] [role="textbox"] > p:last-of-type').getBoundingClientRect();return {x:r.right-4,y:r.bottom-1}`,
    )
    let data: Record<string, unknown> | null = null
    const intercepted = (
      _event: Electron.Event,
      method: string,
      params: { data: Record<string, unknown> },
    ) => {
      if (method === 'Input.dragIntercepted') data = params.data
    }
    win.webContents.debugger.on('message', intercepted)
    await win.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: true })
    try {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...grip,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      for (let step = 1; step <= 5 && !data; step++) {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: grip.x + step * 8,
          y: grip.y + step * 8,
          button: 'left',
          buttons: 1,
        })
        await sleep(100)
      }
      assert(data, 'Native gutter drag must expose its serialized figure')
      for (const type of ['dragEnter', 'dragOver', 'drop'])
        await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
          type,
          ...destination,
          data,
        })
    } finally {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...destination,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      await win.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: false })
      win.webContents.debugger.removeListener('message', intercepted)
    }
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1 && window.captionFixture.state().markdown.indexOf('holi:figure')>window.captionFixture.state().markdown.indexOf(${JSON.stringify(followingText)})`,
      'native whole-figure drop',
    )
    await js(`window.captionFixture.select('documentFigure'); return true`)
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().markdown.indexOf('holi:figure')<window.captionFixture.state().markdown.indexOf(${JSON.stringify(followingText)})`,
      'native drag undo',
    )
  }
  let ok = false
  let frameNumber = 0
  let videoCapturePending = false
  let videoPaused = false
  let videoTimer: ReturnType<typeof setInterval> | undefined
  const videoFrames: Promise<void>[] = []
  const videoErrors: string[] = []
  await mkdir(join(evidence, 'frames'), { recursive: true })
  try {
    await win.loadURL(url)
    win.focus()
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Page.enable')
    await wait(`window.captionFixture?.state()?.json`, 'production DocumentView')
    mark('production-document-view-with-real-router-filesystem')
    videoTimer = setInterval(() => {
      if (frameNumber >= 1500 || videoCapturePending || videoPaused) return
      videoCapturePending = true
      const number = frameNumber++
      videoFrames.push(
        (async () => {
          try {
            const frame = await win.webContents.capturePage()
            await writeFile(
              join(evidence, 'frames', `frame-${String(number).padStart(4, '0')}.png`),
              frame.toPNG(),
            )
          } catch (error) {
            videoErrors.push(String(error))
          } finally {
            videoCapturePending = false
          }
        })(),
      )
    }, 200)
    await js(`window.captionFixture.select('codeBlock'); return true`)
    await menu('Add caption')
    await wait(`document.querySelector('figcaption')`, 'native caption')
    await win.webContents.insertText('A ')
    press('b', ['meta'])
    await win.webContents.insertText('portable')
    press('b', ['meta'])
    await win.webContents.insertText(' caption.')
    await wait(
      `window.captionFixture.state().markdown.includes('A **portable** caption.')`,
      'native formatted typing',
    )
    await sleep(850)
    let saved = await readFile(note, 'utf8')
    assert(saved.startsWith(head))
    assert(saved.includes(originalFence))
    assert(saved.includes('A **portable** caption.'))
    assert(writes > 0)
    await writeFile(join(evidence, 'authored-initial.md.txt'), saved)
    assert.equal(readMarkdownCodeCaptions(saved).length, 1)
    assert.equal(
      await js(`return getComputedStyle(document.querySelector('figcaption')).textAlign`),
      'center',
    )
    mark('native-menu-formatted-edit-and-filesystem-autosave')
    await capture('caption-light.png')
    await win.webContents.insertText(' Pending')
    await js('await window.captionFixture.flush(); return true')
    saved = await readFile(note, 'utf8')
    assert(saved.includes(' Pending'))
    assert(saved.startsWith(head))
    assert(saved.includes(originalFence))
    mark('production-buffer-flush-persists-pending-caption')
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().revision>0 && window.captionFixture.state().markdown.includes(' Pending')`,
      'real file reopen',
    )
    mark('filesystem-reopen-keeps-caption-formatting-and-fence')
    saved = saved.replace(' Pending', ' Pending reload')
    await writeFile(note, saved)
    await js('window.captionFixture.reload(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Pending reload')`,
      'external disk reload',
    )
    mark('external-file-change-reloads-through-production-codec')
    await js(`window.captionFixture.select('documentCaption', 'primary', true); return true`)
    const anchored = await js<{
      anchor: { quote: string }
      lines: { startLine: number; endLine: number }
    }>('return await window.captionFixture.anchor()')
    assert(anchored.anchor && anchored.anchor.quote.includes('portable'))
    assert.equal(
      saved
        .split('\n')
        .slice(anchored.lines.startLine - 1, anchored.lines.endLine)
        .join('\n')
        .includes('portable'),
      true,
    )
    mark('caption-comment-quote-and-file-line-anchors')
    press('f', ['meta'])
    await wait(`document.querySelector('input[aria-label="Find"]')`, 'native find')
    await click('input[aria-label="Find"]')
    win.webContents.selectAll()
    await sleep(50)
    await win.webContents.insertText('Pending reload')
    await wait(
      `document.querySelector('[role="search"]').textContent.includes('1 of 1')`,
      'caption find mapping',
    )
    await capture('caption-find.png')
    await click('[aria-label="Show replace"]')
    await click('input[aria-label="Replace"]')
    await win.webContents.insertText('Pending verified')
    press('Enter')
    await wait(
      `window.captionFixture.state().markdown.includes('Pending verified')`,
      'native caption replacement',
    )
    press('Escape')
    await sleep(100)
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().markdown.includes('Pending reload')`,
      'replacement undo',
    )
    mark('native-find-replace-and-undo-in-caption')
    await js(`window.captionFixture.select('documentFigure'); return true`)
    win.focus()
    await capture('code-clipboard-selection.png')
    const clipboardBeforeCodeCopy = clipboard.readText()
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'c',
      code: 'KeyC',
      modifiers: 4,
    })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'c',
      code: 'KeyC',
      modifiers: 4,
    })
    for (
      let attempt = 0;
      attempt < 100 &&
      (clipboard.readText() === clipboardBeforeCodeCopy ||
        !clipboard.readText().includes('portable'));
      attempt++
    )
      await sleep(50)
    const codeClipboard = clipboard.readText()
    await writeFile(join(evidence, 'clipboard.md.txt'), codeClipboard)
    assert(
      codeClipboard.includes('holi:figure') &&
        codeClipboard.includes('A **portable** caption. Pending reload'),
      `native code clipboard did not include its portable figure: ${codeClipboard}`,
    )
    const codeHtml = await js<string>(
      `return document.querySelector('[data-pane="primary"] figure[data-holi-code-figure]')?.outerHTML ?? ''`,
    )
    assert(codeHtml.includes('<figcaption>') && codeHtml.includes('portable'))
    clipboard.writeHTML(codeHtml)
    await writeFile(join(evidence, 'code-clipboard.html.txt'), codeHtml)
    await js('window.captionFixture.split(true); return true')
    await wait(`window.captionFixture.state('secondary')`, 'second production view')
    await setRightFocus(true)
    await js(
      `const e=document.querySelector('[data-pane="secondary"] [role="textbox"]').editor; e.commands.focus('end'); return true`,
    )
    await wait(
      `document.activeElement?.closest('[data-pane="secondary"]')`,
      'clipboard receiver focus',
    )
    win.webContents.paste()
    await wait(
      `window.captionFixture.state('secondary').markdown.includes('A **portable** caption. Pending reload')`,
      'native HTML paste',
    )
    assert(
      (await js<string>(`return window.captionFixture.state('secondary').markdown`)).includes(
        'A **portable** caption. Pending reload',
      ),
    )
    mark('native-html-clipboard-between-production-split-views')
    clipboard.writeText(await js<string>('return window.captionFixture.state().markdown'))
    await js(
      `const e=document.querySelector('[data-pane="secondary"] [role="textbox"]').editor; e.commands.focus('end'); return true`,
    )
    await wait(
      `document.activeElement?.closest('[data-pane="secondary"]')`,
      'markdown receiver focus',
    )
    win.webContents.paste()
    await wait(
      `window.captionFixture.state('secondary').json.content.filter(n=>n.type==='documentFigure').length===2`,
      'native Markdown paste',
    )
    mark('native-plain-markdown-clipboard-uses-shared-caption-codec')
    await js('await window.captionFixture.flush(); return true')
    assert((await readFile(join(vault, 'notes/Clipboard.md'), 'utf8')).includes('holi:caption'))
    const before = await js<number>('return window.captionFixture.state().identity')
    await js('window.captionFixture.hide(true); return true')
    await wait(`!window.captionFixture.state().editable`, 'hidden retained read-only')
    await js('window.captionFixture.hide(false); return true')
    await wait('window.captionFixture.state().editable', 'return to retained view')
    await setRightFocus(false)
    assert.equal(await js('return window.captionFixture.state().identity'), before)
    mark('hidden-retained-view-keeps-editor-and-split-ownership')
    await js('window.captionFixture.locked(true); return true')
    await wait('!window.captionFixture.state().editable', 'production locked document')
    const locked = await readFile(note, 'utf8')
    await js(
      `document.querySelector('[data-pane="primary"] [role="textbox"]').focus(); return true`,
    )
    await win.webContents.insertText('MUST NOT WRITE')
    await sleep(700)
    assert.equal(await readFile(note, 'utf8'), locked)
    await capture('caption-locked.png')
    await js('window.captionFixture.locked(false); window.captionFixture.split(false); return true')
    await wait('window.captionFixture.state().editable', 'unlock')
    mark('locked-production-document-rejects-native-mutation')
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await menu('Duplicate')
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length`,
      ),
      2,
    )
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1`,
      'duplicate undo',
    )
    mark('whole-figure-duplicate-and-native-undo')
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await menu('Move Up')
    await wait(
      `window.captionFixture.state().markdown.indexOf('holi:figure')<window.captionFixture.state().markdown.indexOf('Before the code.')`,
      'figure move up source order',
    )
    assert.equal(
      await js(
        `const m=window.captionFixture.state().markdown; return m.indexOf('holi:figure')<m.indexOf('Before the code.')`,
      ),
      true,
    )
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await menu('Move Down')
    await wait(
      `window.captionFixture.state().markdown.indexOf('holi:figure')>window.captionFixture.state().markdown.indexOf('Before the code.')`,
      'figure move down source order',
    )
    assert.equal(
      await js(
        `const m=window.captionFixture.state().markdown; return m.indexOf('holi:figure')>m.indexOf('Before the code.')`,
      ),
      true,
    )
    mark('native-block-move-keeps-caption-and-code-together')
    await dragFigure()
    mark('native-gutter-drag-drop-and-undo-keep-one-figure')
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await menu('Remove caption')
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length`,
      ),
      0,
    )
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(originalFence),
    )
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1`,
      'remove-caption undo',
    )
    mark('native-remove-caption-restores-original-fence-and-undo')
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await menu('Delete')
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length`,
      ),
      0,
    )
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1`,
      'whole-figure delete undo',
    )
    press('z', ['meta', 'shift'])
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===0`,
      'whole-figure redo',
    )
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1`,
      'whole-figure redo undo',
    )
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await menu('Edit caption')
    assert.equal(
      await js(
        `return document.querySelector('[data-pane="primary"] [role="textbox"]').editor.state.selection.$from.parent.type.name`,
      ),
      'documentCaption',
    )
    mark('native-redo-and-edit-caption-focus')
    await js(`window.captionFixture.select('codeBlock'); return true`)
    press('Enter', ['meta'])
    await sleep(100)
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length`,
      ),
      1,
    )
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(originalFence),
    )
    mark('native-delete-undo-and-code-exit-shortcut-keep-one-figure')

    const imageOnly = `${head}# Image caption\n\n${imageSource}\n\nAfter the image.\n`
    await js('await window.captionFixture.flush(); return true')
    await writeFile(note, imageOnly)
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Smoke photo')`,
      'relative image reload',
    )
    await js(`window.captionFixture.select('image'); return true`)
    await menu('Add caption')
    await wait(`document.querySelector('figcaption')`, 'native image caption')
    await win.webContents.insertText('Image ')
    press('b', ['meta'])
    await win.webContents.insertText('portable')
    press('b', ['meta'])
    await win.webContents.insertText(' caption.')
    await wait(
      `window.captionFixture.state().markdown.includes('Image **portable** caption.')`,
      'formatted image caption',
    )
    await sleep(850)
    await js('await window.captionFixture.flush(); return true')
    let imageSaved = await readFile(note, 'utf8')
    assert(imageSaved.includes(imageSource), 'image src, alt and title must round-trip')
    assert(imageSaved.includes('Image **portable** caption.'))
    const imageAttrs = await js<{ src: string; alt: string; title: string }>(
      `const stack=[...window.captionFixture.state().json.content];let image;while(stack.length){const node=stack.pop();if(node.type==='image')image=node;stack.push(...(node.content||[]))}return image.attrs`,
    )
    assert.equal(imageAttrs.src, '../assets/smoke.png')
    assert.equal(imageAttrs.alt, 'Smoke photo')
    assert.equal(imageAttrs.title, 'Photo title')
    await exec('git', ['add', '-f', path], { cwd: vault })
    await exec(
      'git',
      [
        '-c',
        'user.name=Holi acceptance',
        '-c',
        'user.email=acceptance@holi.invalid',
        'commit',
        '-m',
        'save image caption',
      ],
      { cwd: vault },
    )
    const actualHistory = await historyRepo.log({ path, limit: 200 })
    assert(actualHistory.length >= 2, 'the real git history module must return fixture commits')
    const historyContent = await historyRepo.show(actualHistory[0]!.sha, path)
    assert(historyContent.includes(imageSource) && historyContent.includes(imageCaption))
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Image **portable** caption.')`,
      'image caption after history commit reopen',
    )
    await click('button[aria-label="History"]')
    await wait(`document.querySelector('[role="dialog"]')`, 'production file history dialog')
    await wait(`document.body.innerText.includes('save image caption')`, 'real image history entry')
    assert(historyReads > 0, 'production history dialog must read the real git history module')
    press('Escape')
    await wait(`!document.querySelector('[role="dialog"]')`, 'close history dialog')
    await writeFile(
      join(evidence, 'history-proof.json'),
      JSON.stringify(
        {
          commits: actualHistory.map(({ sha, subject }) => ({ sha, subject })),
          latestContent: historyContent,
        },
        null,
        2,
      ),
    )
    mark('actual-git-module-history-and-image-caption-commit-receipt')
    await capture('image-caption-failure.png')
    await copyFile(
      join(
        process.env.HOLI_535_DESKTOP!,
        'src/plugins/pdf/main/vault/once/.holi/document-templates/_brand/logo.png',
      ),
      join(vault, 'assets/smoke.png'),
    )
    await js(
      `Array.from(document.querySelectorAll('button')).find((button)=>button.textContent.trim()==='Retry')?.setAttribute('data-image-retry','true'); return true`,
    )
    await click('[data-image-retry="true"]')
    await wait(
      `document.querySelector('img')?.complete && document.querySelector('img').naturalWidth>0`,
      'image Retry recovery',
    )
    mark('native-image-load-failure-retry-recovers-real-vault-asset')
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Image **portable** caption.')`,
      'image caption filesystem reopen',
    )
    mark('native-relative-image-caption-edit-autosave-flush-reopen-preserves-source-attrs')
    await js(`window.captionFixture.select('documentCaption', 'primary', true); return true`)
    const imageAnchor = await js<{
      anchor: { quote: string }
      lines: { startLine: number; endLine: number }
    }>('return await window.captionFixture.anchor()')
    assert(imageAnchor.anchor.quote.includes('portable'))
    assert(imageAnchor.lines.startLine >= 1)
    mark('native-image-caption-comment-quote-and-line-anchor')
    press('f', ['meta'])
    await wait(`document.querySelector('input[aria-label="Find"]')`, 'image caption native find')
    await click('input[aria-label="Find"]')
    win.webContents.selectAll()
    await win.webContents.insertText('Image portable')
    await wait(
      `document.querySelector('[role="search"]').textContent.includes('1 of 1')`,
      'image caption find mapping',
    )
    press('Escape')
    mark('native-image-caption-find-maps-to-source')
    const imageIdentity = await js<number>('return window.captionFixture.state().identity')
    await js('window.captionFixture.split(true); return true')
    await wait(`window.captionFixture.state('secondary')`, 'image focus split view')
    await setRightFocus(true)
    await setRightFocus(false)
    await js('window.captionFixture.hide(true); return true')
    await wait(`!window.captionFixture.state().editable`, 'hide retained image view')
    await js('window.captionFixture.hide(false); return true')
    await wait(`window.captionFixture.state().editable`, 'restore retained image editor')
    await setRightFocus(true)
    await setRightFocus(false)
    assert.equal(await js('return window.captionFixture.state().identity'), imageIdentity)
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(
        'Image **portable** caption.',
      ),
    )
    await js('window.captionFixture.split(false); return true')
    mark('image-caption-survives-retained-split-hidden-and-repeated-focus-visits')
    const externallyEdited = imageSaved.replace('"Photo title"', '"External title"')
    await writeFile(note, externallyEdited)
    await js('window.captionFixture.reload(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('External title') && window.captionFixture.state().markdown.includes('Image **portable** caption.')`,
      'external image source reload',
    )
    await js(
      `const stack=[...window.captionFixture.state().json.content];let image;while(stack.length){const node=stack.pop();if(node.type==='image')image=node;stack.push(...(node.content||[]))}return image.attrs.title==='External title'`,
    )
    await writeFile(note, imageSaved)
    await js('window.captionFixture.reload(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Photo title') && window.captionFixture.state().markdown.includes('Image **portable** caption.')`,
      'restore image fixture after external reload',
    )
    mark('external-image-source-reload-keeps-caption-and-restores-fixture')
    await wait(
      `document.querySelector('[data-pane="primary"] figure[data-holi-code-figure] img')?.naturalWidth>0`,
      'image loaded before native selection',
    )
    await click('button[aria-label="Select Smoke photo"]')
    const imageSelection = await js<{ type: string; node: string }>(
      `const s=document.querySelector('[data-pane="primary"] [role="textbox"]').editor.state.selection;return {type:s.toJSON().type,node:s.node?.type.name}`,
    )
    assert.equal(imageSelection.type, 'node')
    assert.equal(imageSelection.node, 'image')
    await capture('image-native-selection.png')
    await click('button[aria-label="Select Smoke photo"]')
    const imageSelectionForCopy = await js<{ type: string; node: string }>(
      `const s=document.querySelector('[data-pane="primary"] [role="textbox"]').editor.state.selection;return {type:s.toJSON().type,node:s.node?.type.name}`,
    )
    assert.equal(imageSelectionForCopy.node, 'image')
    await js(
      `window.__copyEvents=[];document.addEventListener('copy',e=>window.__copyEvents.push({types:[...(e.clipboardData?.types??[])],prevented:e.defaultPrevented,selection:document.querySelector('[data-pane="primary"] [role="textbox"]').editor.state.selection.node?.type.name}))`,
    )
    await js(
      `document.querySelector('[data-pane="primary"] [role="textbox"]').editor.view.focus(); return true`,
    )
    press('c', ['meta'])
    win.webContents.copy()
    await wait(
      `document.querySelector('[data-pane="primary"] [role="textbox"]').editor.state.selection.node?.type.name==='documentFigure'`,
      'direct image selection expands to containing figure for copy',
    )
    await sleep(500)
    const imageHtml = clipboard.readHTML()
    const imagePlain = clipboard.readText()
    await writeFile(
      join(evidence, 'native-image-copy-debug.json'),
      JSON.stringify(
        { events: await js('return window.__copyEvents'), html: imageHtml, plain: imagePlain },
        null,
        2,
      ),
    )
    assert(
      imageHtml.includes('figcaption') ||
        imagePlain.includes('Caption') ||
        imagePlain.includes('portable'),
      'native image copy must put its caption on the OS clipboard',
    )
    assert(imageHtml.includes('<figcaption>') && imageHtml.includes('Smoke photo'))
    assert(imageHtml.includes('portable'))
    assert(imagePlain.includes(imageSource))
    assert(
      imagePlain.includes('<!-- holi:figure -->') && imagePlain.includes('<!-- holi:caption -->'),
    )
    assert(imagePlain.includes('Image **portable** caption.'))
    assert(!/holi-vault:|data-holi-/.test(imagePlain))
    await writeFile(join(evidence, 'image-clipboard.html.txt'), imageHtml)
    await writeFile(join(evidence, 'image-clipboard.txt'), imagePlain)
    mark('native-direct-image-copy-carries-figure-caption-in-os-clipboard')
    await js('window.captionFixture.split(true); return true')
    await wait(`window.captionFixture.state('secondary')`, 'image clipboard split receiver')
    await setRightFocus(true)
    await js(
      `const e=document.querySelector('[data-pane="secondary"] [role="textbox"]').editor;e.commands.setContent({type:'doc',content:[]});e.commands.focus('end');return true`,
    )
    await wait(
      `document.activeElement?.closest('[data-pane="secondary"]')`,
      'image clipboard receiver focus',
    )
    win.webContents.paste()
    await wait(
      `window.captionFixture.state('secondary').json.content.some(n=>n.type==='documentFigure')`,
      'native image HTML paste',
    )
    const imagePaste = await js<{ markdown: string; json: { content: Array<any> } }>(
      'return window.captionFixture.state("secondary")',
    )
    const pastedCaptions: string[] = []
    const pastedImages: string[] = []
    const collectPasted = (nodes: Array<any>) => {
      for (const node of nodes) {
        if (node.type === 'documentCaption')
          pastedCaptions.push((node.content ?? []).map((part: any) => part.text ?? '').join(''))
        if (node.type === 'image') pastedImages.push(String(node.attrs?.src ?? ''))
        collectPasted(node.content ?? [])
      }
    }
    collectPasted(imagePaste.json.content)
    assert.equal(pastedCaptions.length, 1, 'image paste must not emit caption as a second block')
    assert.deepEqual(pastedImages, ['../assets/smoke.png'])
    assert.equal((imagePaste.markdown.match(/<!-- holi:figure -->/g) ?? []).length, 1)
    await js('await window.captionFixture.flush(); return true')
    const nativePastedSaved = await readFile(note, 'utf8')
    assert(nativePastedSaved.includes('Image **portable** caption.'))
    assert(nativePastedSaved.includes('![Smoke photo](../assets/smoke.png "Photo title")'))
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state('secondary').json.content.some(n=>n.type==='documentFigure')`,
      'native pasted figure filesystem reopen',
    )
    await wait(`window.captionFixture.state('primary')`, 'primary editor remount after reopen')
    await setRightFocus(false)
    await js(`window.captionFixture.select('image', 'primary'); return true`)
    await wait(
      `window.captionFixture.state('primary').editable && document.activeElement?.closest('[data-pane="primary"] [role="textbox"]')`,
      'primary cut selection owns native focus',
    )
    win.webContents.cut()
    await wait(
      `!window.captionFixture.state('primary').json.content.some(n=>n.type==='documentFigure')`,
      'native direct image cut removes image and caption together',
    )
    await wait(
      `document.activeElement?.closest('[data-pane="primary"] [role="textbox"]')`,
      'native cut returns focus before undo',
    )
    await sleep(100)
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state('primary').json.content.some(n=>n.type==='documentFigure')`,
      'native direct image cut undo restores whole figure',
    )
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(
        'Image **portable** caption.',
      ),
    )
    mark('native-direct-image-cut-and-undo-operate-on-whole-figure')
    await js(`window.captionFixture.select('documentFigure', 'primary'); return true`)
    await menu('Remove caption')
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.some(n=>n.type==='documentFigure')`,
      ),
      false,
    )
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().json.content.some(n=>n.type==='documentFigure')`,
      'image caption removal undo restores figure',
    )
    mark('native-image-caption-remove-undo-restores-image-and-caption')
    await js(`window.captionFixture.select('documentFigure', 'primary'); return true`)
    await menu('Duplicate')
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===2`,
      'image figure duplication',
    )
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1`,
      'image figure duplicate undo',
    )
    mark('native-image-and-caption-duplicate-undo-remains-atomic')
    await js(`window.captionFixture.select('image', 'primary'); return true`)
    await js(
      `const e=Array.from(document.querySelectorAll('[data-pane="primary"] [data-toolbar-item]')).find(item=>item.textContent.trim()==='Open larger');if(!e)throw Error('Missing primary image action');e.setAttribute('data-image-open-larger','');return true`,
    )
    press('F10', ['alt'])
    await wait(
      `document.activeElement?.matches('[data-image-open-larger]')`,
      'production image action toolbar receives keyboard focus',
    )
    const imageActionDebug = await js(
      `const e=document.querySelector('[data-image-open-larger]'); if(!e)throw Error('Missing primary image action'); const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);window.__imageActionClicks=0;e.addEventListener('click',()=>window.__imageActionClicks++,{once:true});return {text:e.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hidden:e.closest('[hidden]')!==null,hit:hit?.outerHTML,active:e===document.activeElement,opacity:getComputedStyle(e.closest('[data-toolbar-item]').parentElement).opacity}`,
    )
    await writeFile(
      join(evidence, 'image-toolbar-debug.json'),
      JSON.stringify(imageActionDebug, null, 2),
    )
    await capture('image-toolbar-focused.png')
    await click('[data-image-open-larger]')
    await wait(`window.__imageActionClicks===1`, 'native mouse reaches image action')
    await wait(`document.querySelector('[role="dialog"]')`, 'image action opens lightbox')
    await wait(
      `document.querySelector('[role="dialog"] img')?.naturalWidth>0`,
      'production image lightbox image loads',
    )
    await capture('image-toolbar-enlarged-lightbox.png')
    mark('native-alt-f10-image-toolbar-opens-loaded-lightbox')
    press('Escape')
    await wait(`!document.querySelector('[role="dialog"]')`, 'close image action lightbox')
    await doubleClick('[data-pane="primary"] figure img')
    await wait(
      `document.querySelector('[role="dialog"]')`,
      'production image double-click lightbox opens',
    )
    await wait(
      `document.querySelector('[role="dialog"] img')?.naturalWidth>0`,
      'production image double-click lightbox image loads',
    )
    await capture('image-enlarged-lightbox.png')
    mark('native-image-double-click-opens-loaded-lightbox')
    press('Escape')
    await wait(`!document.querySelector('[role="dialog"]')`, 'close image double-click lightbox')
    // Page.captureScreenshot and a native macOS drag cannot overlap: the
    // compositor can hold both CDP commands until the drag's mouse-up.
    videoPaused = true
    await Promise.all(videoFrames)
    try {
      await dragImageDirect()
    } finally {
      videoPaused = false
    }
    await capture('image-direct-drag-result.png')
    mark('native-direct-image-drag-moves-whole-figure-and-undo-restores-it')
    const beforeImageLock = await readFile(note, 'utf8')
    await js('window.captionFixture.locked(true); return true')
    await wait('!window.captionFixture.state().editable', 'lock image caption document')
    await js(`window.captionFixture.select('documentCaption', 'primary', true); return true`)
    await win.webContents.insertText('MUST NOT WRITE')
    await sleep(700)
    assert.equal(await readFile(note, 'utf8'), beforeImageLock)
    await js('window.captionFixture.locked(false); return true')
    await wait('window.captionFixture.state().editable', 'unlock image caption document')
    mark('locked-image-caption-rejects-native-mutation')
    await capture('image-caption-light.png')
    await js(
      `window.captionFixture.select('documentFigure'); window.captionFixture.theme('dark'); return true`,
    )
    await sleep(300)
    await capture('image-caption-dark.png')
    await sleep(300)
    await capture('caption-dark.png')
    await js('await window.captionFixture.flush(); return true')
    const beforePdf = await readFile(note, 'utf8')
    await writeFile(join(evidence, 'editor-saved.md.txt'), beforePdf)
    const portableFrames = readMarkdownCaptionEnvelopes(beforePdf)
    await writeFile(join(evidence, 'portable-frames.json'), JSON.stringify(portableFrames, null, 2))
    assert.equal(portableFrames.length, 1, 'saved editor fixture must be a supported image figure')
    assert(beforePdf.includes(imageSource), 'portable image frame must retain source markdown')
    await js(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Convert to PDF').click(); return true`,
    )
    await wait(
      `document.querySelector('[data-convert-confirm]:not([disabled])')`,
      'production ConvertToPdf dialog',
    )
    await capture('caption-convert.png')
    await click('[data-convert-confirm]')
    await wait(`!document.querySelector('[role="dialog"]')`, 'actual UI PDF capability')
    const uiPdf = join(vault, 'notes/Code-caption.pdf')
    await copyFile(uiPdf, join(evidence, 'native-ui.pdf'))
    const ui = await inspectPdf(uiPdf)
    mark('production-convert-ui-through-real-typst-and-centered-output')
    const result = await exec(
      cli,
      ['pdf', 'render', path, 'plain', '--out', 'notes/cli.pdf', '--json'],
      { cwd: vault, env: { ...process.env, CLAUDE_JOB_DIR: '' } },
    )
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.warnings.length, 0)
    const cliPdf = join(vault, 'notes/cli.pdf')
    const cliProof = await inspectPdf(cliPdf)
    await copyFile(cliPdf, join(evidence, 'native-cli.pdf'))
    assert.equal(await readFile(note, 'utf8'), beforePdf)
    assert(calls.some((c) => c.door === 'ui' && c.name === 'pdf.render'))
    assert(calls.some((c) => c.door === 'cli' && c.name === 'pdf.render'))
    await writeFile(
      join(evidence, 'pdf-proof.json'),
      JSON.stringify({ ui, cli: cliProof }, null, 2),
    )
    await writeFile(join(evidence, 'editor-saved.md.txt'), beforePdf)
    mark('actual-holi-cli-through-private-bridge-and-real-pdf-capability')

    const referenceCases = [
      {
        name: 'full',
        markdown: '![Smoke photo][photo]\n\n[photo]: ../assets/smoke.png "Photo title"',
      },
      {
        name: 'collapsed',
        markdown: '![Smoke photo][]\n\n[Smoke photo]: ../assets/smoke.png "Photo title"',
      },
      {
        name: 'shortcut',
        markdown: '![Smoke photo]\n\n[Smoke photo]: ../assets/smoke.png "Photo title"',
      },
    ]
    for (const reference of referenceCases) {
      const referenceDocument = `${head}# Reference ${reference.name}\n\n${reference.markdown}\n`
      await writeFile(note, referenceDocument)
      await js('await window.captionFixture.reopen(); return true')
      await wait(
        `window.captionFixture.state().markdown.includes(${JSON.stringify(`Reference ${reference.name}`)})`,
        `${reference.name} reference image opens`,
      )
      const openedReference = await js<{
        markdown: string
        json: { content: Array<any> }
      }>('return window.captionFixture.state()')
      const referenceNodes = [...openedReference.json.content]
      let referenceImage: any
      while (referenceNodes.length) {
        const node = referenceNodes.pop()
        if (node.type === 'image') referenceImage = node
        referenceNodes.push(...(node.content ?? []))
      }
      assert(referenceImage, `${reference.name} reference must parse as an image node`)
      const [referenceBody, referenceDefinition] = reference.markdown.split('\n\n')
      assert.equal(referenceImage.attrs.src, '../assets/smoke.png')
      assert.equal(referenceImage.attrs.alt, 'Smoke photo')
      assert.equal(referenceImage.attrs.title, 'Photo title')
      assert.equal(referenceImage.attrs.sourceMarkdown, referenceBody)
      assert(
        openedReference.json.content.some(
          (node: any) => node.type === 'htmlBlock' && node.attrs.html === referenceDefinition,
        ),
        `${reference.name} reference definition must remain an untouched source block`,
      )
      await writeFile(
        join(evidence, `reference-${reference.name}-opened.json`),
        JSON.stringify(openedReference, null, 2),
      )
      await js(`window.captionFixture.select('image'); return true`)
      await menu('Add caption')
      await win.webContents.insertText(`Reference ${reference.name}`)
      await js('await window.captionFixture.flush(); return true')
      const withCaption = await readFile(note, 'utf8')
      await writeFile(join(evidence, `reference-${reference.name}-captioned.md.txt`), withCaption)
      assert(withCaption.includes(referenceBody), `${reference.name} image source spelling changed`)
      assert(
        withCaption.includes(referenceDefinition),
        `${reference.name} definition spelling changed on caption save`,
      )
      assert(withCaption.includes(`Reference ${reference.name}`))
      await js(`window.captionFixture.select('documentFigure'); return true`)
      await menu('Remove caption')
      await js('await window.captionFixture.flush(); return true')
      const removed = await readFile(note, 'utf8')
      assert(removed.includes(referenceBody), `${reference.name} image source changed on removal`)
      assert(
        removed.includes(referenceDefinition),
        `${reference.name} definition did not survive caption removal`,
      )
      assert(!removed.includes('<!-- holi:figure -->'))
      await js('await window.captionFixture.reopen(); return true')
      await wait(
        `window.captionFixture.state().json.content.some(n=>n.type==='image')`,
        `${reference.name} reference image survives reopen`,
      )
      const reopenedReference = await js<{ json: { content: Array<any> } }>(
        'return window.captionFixture.state()',
      )
      const reopenedNodes = [...reopenedReference.json.content]
      let reopenedImage: any
      let reopenedDefinition: any
      while (reopenedNodes.length) {
        const node = reopenedNodes.pop()
        if (node.type === 'image') reopenedImage = node
        if (node.type === 'htmlBlock') reopenedDefinition = node
        reopenedNodes.push(...(node.content ?? []))
      }
      assert.equal(reopenedImage?.attrs.sourceMarkdown, referenceBody)
      assert.equal(reopenedDefinition?.attrs.html, referenceDefinition)
      await writeFile(
        join(evidence, `reference-${reference.name}-reopened.json`),
        JSON.stringify(reopenedReference, null, 2),
      )
      mark(`native-${reference.name}-reference-image-caption-save-remove-reopen`)
    }

    const unsupportedLooseImage = '![Smoke photo][photo]'
    const unsupportedEnvelope = [
      '<!-- holi:figure -->',
      '',
      '![Smoke photo][photo]',
      '',
      '<!-- holi:caption -->',
      '',
      '[caption][meaning]',
      '',
      '<!-- /holi:figure -->',
    ].join('\n')
    const malformedEnvelope = '<!-- holi:figure -->\n\n![Smoke photo](../assets/smoke.png)\n'
    const unsupportedDocument = `${head}# Preserve unsupported\n\n${unsupportedLooseImage}\n\n${unsupportedEnvelope}\n\n${malformedEnvelope}\n\n[photo]: ../assets/smoke.png\n[meaning]: https://example.com\n\nUnrelated text.\n`
    await writeFile(note, unsupportedDocument)
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Preserve unsupported')`,
      'unsupported image caption source opens',
    )
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length`,
      ),
      0,
    )
    await js(`window.captionFixture.select('paragraph'); return true`)
    await win.webContents.insertText(' edited')
    await js('await window.captionFixture.flush(); return true')
    const unsupportedSaved = await readFile(note, 'utf8')
    assert(
      unsupportedSaved.includes(unsupportedLooseImage),
      'standalone reference image source changed after unrelated save',
    )
    assert(
      unsupportedSaved.includes(unsupportedEnvelope),
      'unsupported reference caption source changed after unrelated save',
    )
    assert(
      unsupportedSaved.includes(malformedEnvelope),
      'malformed image caption source changed after unrelated save',
    )
    await writeFile(join(evidence, 'unsupported-source.md.txt'), unsupportedSaved)
    mark('native-unsupported-reference-and-malformed-image-source-survive-unrelated-save')
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Preserve unsupported')`,
      'unsupported image caption source reopens',
    )
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length`,
      ),
      0,
    )

    const wikiImage = `${head}# Wiki image\n\n![[assets/smoke.png]]\n\nUnrelated text.\n`
    await writeFile(note, wikiImage)
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('![[assets/smoke.png]]')`,
      'wiki-link image chip stays native',
    )
    const wikiState = await js<{
      markdown: string
      json: { content: Array<{ type: string; content?: Array<any> }> }
    }>('return window.captionFixture.state()')
    const wikiNodes = [...wikiState.json.content]
    let hasWikiLink = false
    let documentFigureCount = 0
    while (wikiNodes.length) {
      const node = wikiNodes.pop()!
      if (node.type === 'wikiLink') hasWikiLink = true
      if (node.type === 'documentFigure') documentFigureCount++
      wikiNodes.push(...(node.content ?? []))
    }
    assert(hasWikiLink)
    assert.equal(documentFigureCount, 0)
    await js(`window.captionFixture.select('paragraph'); return true`)
    await win.webContents.insertText(' edited')
    await js('await window.captionFixture.flush(); return true')
    assert((await readFile(note, 'utf8')).includes('![[assets/smoke.png]]'))
    mark('native-wiki-image-chip-keeps-existing-node-and-source-through-unrelated-save')

    // Edge cases use the same production views and the real OS clipboard.
    // No clipboard writes occur between source Copy/Cut and destination Paste.
    const frame = (body: string, caption = imageCaption) =>
      `<!-- holi:figure -->\n\n${body}\n\n<!-- holi:caption -->\n\n${caption}\n\n<!-- /holi:figure -->`
    const collectImageAttrs = (state: { json: { content: Array<any> } }) => {
      const attrs: Array<any> = []
      const visit = (nodes: Array<any>) => {
        for (const node of nodes) {
          if (node.type === 'image') attrs.push(node.attrs)
          visit(node.content ?? [])
        }
      }
      visit(state.json.content)
      return attrs
    }
    await copyFile(join(vault, 'assets/smoke.png'), join(vault, 'assets/second.png'))
    const sameAlt = `${head}# Same alt provenance\n\n${frame(imageSource)}\n\n<pre>\n![Smoke photo](../assets/wrong.png)\n</pre>\n\n\`\`\`md\n![Smoke photo](../assets/fenced.png)\n\`\`\`\n\n![Smoke photo](../assets/second.png "Second title")\n\n![Smoke photo](../assets/second.png "Second title")\n\nAfter.`
    await writeFile(note, sameAlt)
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Same alt provenance')`,
      'same-alt fixture',
    )
    assert.deepEqual(
      collectImageAttrs(await js('return window.captionFixture.state()')).map((a) => [
        a.src,
        a.title,
      ]),
      [
        ['../assets/smoke.png', 'Photo title'],
        ['../assets/second.png', 'Second title'],
        ['../assets/second.png', 'Second title'],
      ],
    )
    await js(`window.captionFixture.select('paragraph'); return true`)
    await win.webContents.insertText(' unrelated edit')
    await js('await window.captionFixture.flush(); return true')
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('unrelated edit')`,
      'same-alt disk reopen',
    )
    assert.deepEqual(
      collectImageAttrs(await js('return window.captionFixture.state()')).map((a) => a.src),
      ['../assets/smoke.png', '../assets/second.png', '../assets/second.png'],
    )
    await writeFile(
      join(evidence, 'same-alt-reopened.json'),
      JSON.stringify(await js('return window.captionFixture.state()'), null, 2),
    )
    await capture('same-alt-protected-source.png')
    mark('native-same-alt-and-protected-examples-survive-unrelated-save-reopen')

    const plainCaption =
      'Image **portable** caption. *Italic* [link](https://example.com) and `code`.'
    const sourcePath = 'notes/Plain-source.md'
    const targetPath = 'notes/Plain-destination.md'
    for (const selection of ['image', 'documentFigure']) {
      for (const cut of [false, true]) {
        await js('await window.captionFixture.flush(); return true')
        await writeFile(
          join(vault, sourcePath),
          frame('![Smoke photo][photo]', plainCaption) +
            '\n\n[photo]: ../assets/smoke.png "Photo title"\n',
        )
        await writeFile(join(vault, targetPath), '')
        await js(
          `await window.captionFixture.openPaths(${JSON.stringify(sourcePath)}, ${JSON.stringify(targetPath)}, true); window.captionFixture.split(true); return true`,
        )
        await wait(
          `window.captionFixture.state().markdown.includes('[photo]') && window.captionFixture.plainState()`,
          'production plain markdown destination mounted',
        )
        await setRightFocus(false)
        await js(`window.captionFixture.select(${JSON.stringify(selection)}); return true`)
        if (cut) win.webContents.cut()
        else win.webContents.copy()
        await sleep(150)
        const text = clipboard.readText()
        const html = clipboard.readHTML()
        assert(text.includes(imageSource) && text.includes(plainCaption))
        assert(text.includes('<!-- holi:figure -->') && text.includes('<!-- holi:caption -->'))
        assert(!/holi-vault:|data-holi-|\[photo\]/.test(text))
        assert(html.includes('figcaption') && html.includes('Smoke photo'))
        if (cut)
          await wait(
            `!window.captionFixture.state().json.content.some(n=>n.type==='documentFigure')`,
            'native cut removes figure',
          )
        await js('window.captionFixture.rightFocused(true); return true')
        await wait(`window.captionFixture.plainState()`, 'plain editor ready')
        await js('window.captionFixture.plainState(true); return true')
        await wait(
          `document.activeElement?.closest('[data-pane="secondary"] .cm-editor')`,
          'plain editor focused',
        )
        win.webContents.paste()
        await wait(
          `window.captionFixture.plainState()?.text.includes('<!-- holi:caption -->')`,
          'actual native plain paste',
        )
        await js('await window.captionFixture.flush(); return true')
        const saved = await readFile(join(vault, targetPath), 'utf8')
        assert(saved.includes(text))
        const name = `plain-${selection}-${cut ? 'cut' : 'copy'}`
        await writeFile(
          join(evidence, `${name}-clipboard.json`),
          JSON.stringify({ text, html, formats: clipboard.availableFormats(), saved }, null, 2),
        )
        await capture(`${name}-destination.png`)
        await js(
          `await window.captionFixture.openPaths(${JSON.stringify(targetPath)}, 'notes/Clipboard.md'); window.captionFixture.split(false); window.captionFixture.rightFocused(false); return true`,
        )
        await wait(
          `window.captionFixture.state().json.content.some(n=>n.type==='documentFigure')`,
          'plain markdown reopens as complete native figure',
        )
        assert.equal(
          collectImageAttrs(await js('return window.captionFixture.state()'))[0].src,
          '../assets/smoke.png',
        )
        await writeFile(
          join(evidence, `${name}-reopened.json`),
          JSON.stringify(await js('return window.captionFixture.state()'), null, 2),
        )
        mark(`native-${selection}-${cut ? 'cut' : 'copy'}-os-clipboard-plain-markdown-save-reopen`)
      }
    }
    const transfers = [
      {
        name: 'root-to-nested',
        source: 'Root-source.md',
        target: 'notes/deep/Root-target.md',
        src: 'assets/smoke.png',
        expected: '../../assets/smoke.png',
      },
      {
        name: 'root-to-root',
        source: 'Root-source.md',
        target: 'Root-target.md',
        src: 'assets/smoke.png',
        expected: 'assets/smoke.png',
      },
      {
        name: 'nested-to-root',
        source: 'notes/deep/Nested-source.md',
        target: 'Root-target.md',
        src: '../../assets/smoke.png',
        expected: 'assets/smoke.png',
      },
    ]
    await mkdir(join(vault, 'notes/deep'), { recursive: true })
    for (const transfer of transfers) {
      await js('await window.captionFixture.flush(); return true')
      await writeFile(
        join(vault, transfer.source),
        frame(`![Smoke photo](${transfer.src} "Photo title")`),
      )
      await writeFile(join(vault, transfer.target), '')
      await js(
        `await window.captionFixture.openPaths(${JSON.stringify(transfer.source)}, ${JSON.stringify(transfer.target)}); window.captionFixture.split(true); window.captionFixture.rightFocused(false); return true`,
      )
      await wait(
        `window.captionFixture.state().json.content.some(n=>n.type==='documentFigure') && Boolean(window.captionFixture.state('secondary'))`,
        'folder transfer editors mounted',
      )
      await setRightFocus(false)
      await js(`window.captionFixture.select('image'); return true`)
      win.webContents.copy()
      await sleep(150)
      assert(clipboard.readText().includes('<!-- holi:figure -->'))
      await setRightFocus(true)
      await js(
        `document.querySelector('[data-pane="secondary"] [role="textbox"]').editor.view.focus(); return true`,
      )
      await wait(
        `document.activeElement?.closest('[data-pane="secondary"]')`,
        'folder transfer paste focus',
      )
      win.webContents.paste()
      await wait(
        `window.captionFixture.state('secondary').json.content.some(n=>n.type==='documentFigure')`,
        'folder transfer actual native paste',
      )
      await js('await window.captionFixture.flush(); return true')
      const saved = await readFile(join(vault, transfer.target), 'utf8')
      assert(saved.includes(`![Smoke photo](${transfer.expected} "Photo title")`))
      assert(!saved.includes('holi-vault:'))
      await js(
        `await window.captionFixture.openPaths(${JSON.stringify(transfer.target)}, 'notes/Clipboard.md'); window.captionFixture.split(false); window.captionFixture.rightFocused(false); return true`,
      )
      await wait(
        `window.captionFixture.state().json.content.some(n=>n.type==='documentFigure')`,
        'folder transfer reopen',
      )
      assert.equal(
        collectImageAttrs(await js('return window.captionFixture.state()'))[0].src,
        transfer.expected,
      )
      await writeFile(
        join(evidence, `${transfer.name}-reopened.json`),
        JSON.stringify(await js('return window.captionFixture.state()'), null, 2),
      )
      await capture(`${transfer.name}-reopened.png`)
      const pdfOut = `notes/${transfer.name}.pdf`
      const rendered = await exec(
        cli,
        ['pdf', 'render', transfer.target, 'plain', '--out', pdfOut, '--json'],
        { cwd: vault, env: { ...process.env, CLAUDE_JOB_DIR: '' } },
      )
      assert.deepEqual(JSON.parse(rendered.stdout).warnings, [])
      const proof = await inspectPdf(join(vault, pdfOut))
      await copyFile(join(vault, pdfOut), join(evidence, `${transfer.name}.pdf`))
      await writeFile(join(evidence, `${transfer.name}-pdf.json`), JSON.stringify(proof, null, 2))
      mark(`native-${transfer.name}-copy-paste-save-reopen-real-typst-pdf`)
    }

    assert.deepEqual(denied, [])
    assert.deepEqual(await js('return window.captionFixture.errors'), [])
    assert.deepEqual(rendererErrors, [])
    ok = true
  } finally {
    clearInterval(videoTimer)
    await Promise.all(videoFrames)
    if (!ok && !win.isDestroyed() && win.webContents.debugger.isAttached())
      await capture('failure.png').catch(() => {})
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          ok,
          checks,
          captures,
          roots,
          writes,
          calls,
          imageRequests,
          rendererErrors,
          denied,
          electron: process.versions.electron,
        },
        null,
        2,
      ),
    )
    ipcMain.removeHandler('holi-caption-fixture')
    if (!win.isDestroyed()) win.destroy()
    await bridge.stop()
    await endpoint.dispose()
  }
  app.quit()
}
void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
