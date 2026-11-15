import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, copyFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { readMarkdownCodeCaptions } from '@holi/shared'
import { init } from '@embedpdf/pdfium'
import { PdfiumNative } from '@embedpdf/engines/pdfium'
import { createRouter, type RouterDeps } from '../src/main/router'
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
const root = process.env.HOLI_502_ROOT!
const evidence = process.env.HOLI_502_EVIDENCE!
const typst = process.env.HOLI_502_TYPST!
assert(root && evidence && typst, 'runner must provide isolated roots and Typst')
const remote = 'fixture/captions'
const vault = join(root, 'vault')
const path = 'notes/Code-caption.md'
const note = join(vault, path)
const head = '---\ntitle:  Byte-sensitive caption\n# Keep this comment\ntags: [kept]\n---\n\n'
const originalFence = '~~~typescript extra-info\nconst value = 1\n~~~'
const initial = `${head}# Code caption\n\nBefore the code.\n\n${originalFence}\n\nAfter the code.\n`
const checks: string[] = []
const captures: string[] = []
const rendererErrors: string[] = []
const denied: string[] = []
const calls: { door: string; name: string }[] = []
const roots = { app: root, profile: join(root, 'profile'), session: join(root, 'session'), vault }
let writes = 0
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const mark = (name: string) => {
  checks.push(name)
  console.log(`PASS ${name}`)
}

async function inspectPdf(file: string) {
  const require = createRequire(join(process.env.HOLI_502_DESKTOP!, 'package.json'))
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
    assert.match(text.replace(/\s+/g, ' '), /A portable caption\. Pending reload/)
    assert.match(text.replace(/\s+/g, ' '), /const value = 1/)
    assert(!text.includes('holi:figure') && !text.includes('holi:caption'))
    const at = text.indexOf('A portable caption.')
    assert(at >= 0)
    const caption = textGlyphs
      .slice(at, at + 'A portable caption. Pending reload'.length)
      .filter((g) => g.size.width > 0 && !g.isEmpty)
    assert(caption.length > 10)
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
  for (const dir of [roots.profile, roots.session, join(root, 'app-data'), join(vault, 'notes')])
    await mkdir(dir, { recursive: true })
  app.setName('Holi code captions QA 502')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', roots.profile)
  app.setPath('sessionData', roots.session)
  assert.equal(app.getPath('userData'), roots.profile)
  await writeFile(note, initial)
  await writeFile(join(vault, 'notes/Clipboard.md'), '# Clipboard target\n\nReceiver text.\n')
  await writeFile(join(vault, '.holi/vault'), '1\n')
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
      partition: `caption-502-${process.pid}`,
      preload: join(root, 'preload.cjs'),
    },
  })
  const url = pathToFileURL(join(root, 'renderer.html')).href
  const nativeClipboard = clipboard
    .availableFormats()
    .map((format) => ({ format, data: clipboard.readBuffer(format) }))
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
      details.url.startsWith(pathToFileURL(root).href + '/') || details.url.startsWith('data:')
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
        assert.equal(op.input.remote, remote)
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
        return { ok: false, message: String(error) }
      }
    },
  )
  const js = <T = unknown>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async()=>{${code}})()`)
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
  async function click(selector: string) {
    const rect = await js<{ x: number; y: number }>(
      `const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...rect })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 })
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
  async function dragFigure() {
    const source = await js<{ x: number; y: number }>(
      `const r=document.querySelector('figure').getBoundingClientRect();return {x:r.x+12,y:r.y+12}`,
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
      `window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length===1 && window.captionFixture.state().markdown.indexOf('holi:figure')>window.captionFixture.state().markdown.indexOf('After the code.')`,
      'native whole-figure drop',
    )
    await js(`window.captionFixture.select('documentFigure'); return true`)
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().markdown.indexOf('holi:figure')<window.captionFixture.state().markdown.indexOf('After the code.')`,
      'native drag undo',
    )
  }
  let ok = false
  let frameNumber = 0
  let videoTimer: ReturnType<typeof setInterval> | undefined
  const videoFrames: Promise<void>[] = []
  await mkdir(join(evidence, 'frames'), { recursive: true })
  try {
    await win.loadURL(url)
    win.focus()
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Page.enable')
    await wait(`window.captionFixture?.state()?.json`, 'production DocumentView')
    mark('production-document-view-with-real-router-filesystem')
    videoTimer = setInterval(() => {
      if (frameNumber >= 30) return
      const number = frameNumber++
      videoFrames.push(
        (async () => {
          const frame = (await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
            fromSurface: true,
          })) as { data: string }
          await writeFile(
            join(evidence, 'frames', `frame-${String(number).padStart(4, '0')}.png`),
            Buffer.from(frame.data, 'base64'),
          )
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
    win.webContents.copy()
    for (let attempt = 0; attempt < 100 && !clipboard.readHTML().includes('figcaption'); attempt++)
      await sleep(50)
    assert(clipboard.readHTML().includes('figcaption') && clipboard.readHTML().includes('portable'))
    await writeFile(join(evidence, 'clipboard.html.txt'), clipboard.readHTML())
    await js(
      'window.captionFixture.split(true); window.captionFixture.rightFocused(true); return true',
    )
    await wait(`window.captionFixture.state('secondary').editable`, 'second production view')
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
    await js(
      'window.captionFixture.hide(false); window.captionFixture.rightFocused(false); return true',
    )
    await wait('window.captionFixture.state().editable', 'return to retained view')
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
    assert.equal(
      await js(
        `const m=window.captionFixture.state().markdown; return m.indexOf('holi:figure')<m.indexOf('Before the code.')`,
      ),
      true,
    )
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await menu('Move Down')
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
    await js(
      `window.captionFixture.select('documentFigure'); window.captionFixture.theme('dark'); return true`,
    )
    await sleep(300)
    await capture('caption-dark.png')
    await js('await window.captionFixture.flush(); return true')
    const beforePdf = await readFile(note, 'utf8')
    await writeFile(join(evidence, 'editor-saved.md.txt'), beforePdf)
    const portableFrames = readMarkdownCodeCaptions(beforePdf)
    await writeFile(join(evidence, 'portable-frames.json'), JSON.stringify(portableFrames, null, 2))
    assert.equal(
      portableFrames.length,
      1,
      'saved editor fixture must be a supported portable code figure',
    )
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
          rendererErrors,
          denied,
          electron: process.versions.electron,
        },
        null,
        2,
      ),
    )
    clipboard.clear()
    for (const entry of nativeClipboard) clipboard.writeBuffer(entry.format, entry.data)
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
