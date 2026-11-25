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
import {
  readMarkdownCaptionEnvelopes,
  readMarkdownCodeCaptions,
  readMarkdownTableCaptions,
  writeMarkdownTableCaption,
} from '@holi/shared'
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
import { createMermaidWindow } from '../src/plugins/pdf/main/mermaid-window'
import {
  pdfCapabilities,
  PDF_NAMESPACES,
  type PdfCapabilityDeps,
} from '../src/plugins/pdf/main/capabilities'

const exec = promisify(execFile)
const root = process.env.HOLI_535_ROOT!
const evidence = process.env.HOLI_535_EVIDENCE!
const typst = process.env.HOLI_535_TYPST!
const scope = process.env.HOLI_535_SCOPE ?? 'full'
assert(['full', 'tables-only'].includes(scope), 'unknown caption acceptance scope')
const tablesOnly = scope === 'tables-only'
assert(root && evidence, 'runner must provide isolated roots')
if (!tablesOnly) assert(typst, 'full caption acceptance requires Typst')
const remote = 'fixture/captions'
const vault = join(root, 'vault')
const path = 'notes/Code-caption.md'
const note = join(vault, path)
const fixtureImagePaths = new Set([
  'assets/smoke.png',
  'assets/second.png',
  'assets/smoke photo.png',
  ...['+', '&', '#', '?', '%20'].map((character) => `assets/smoke${character}one.png`),
])
const fixtureImageUrls = new Set(
  [...fixtureImagePaths].map(
    (imagePath) => `holi-vault://vault/${imagePath.split('/').map(encodeURIComponent).join('/')}`,
  ),
)
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

async function inspectPdf(
  file: string,
  expected: { caption: string; source?: string } = { caption: renderedImageCaption },
) {
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
    assert(
      text.replace(/\s+/g, ' ').includes(expected.caption),
      `missing PDF caption: ${expected.caption}`,
    )
    assert(
      !expected.source || text.includes(expected.source),
      `missing PDF source or fallback: ${expected.source}`,
    )
    assert(!text.includes('holi:figure') && !text.includes('holi:caption'))
    const at = text.indexOf(expected.caption)
    assert(at >= 0)
    const caption = textGlyphs
      .slice(at, at + expected.caption.length)
      .filter((g) => g.size.width > 0 && !g.isEmpty)
    assert(caption.length > 10)
    if (!expected.source)
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

function createEditorDriver(win: BrowserWindow, cli: string) {
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
  async function wait(code: string, label: string, timeout = 15000) {
    const until = Date.now() + timeout
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
  async function convertAndInspectPdf(options: {
    uiPdf: string
    cliOutput: string
    uiEvidence: string
    cliEvidence: string
    expected: { caption: string; source?: string }
    warnings: number
  }) {
    await wait(
      `document.querySelector('[data-convert-confirm]:not([disabled])')`,
      'production PDF confirmation',
      45000,
    )
    await js(
      `const button=document.querySelector('[data-convert-confirm]'); if(button.disabled)throw Error('PDF convert button stayed disabled'); button.click(); return true`,
    )
    if (options.warnings) {
      await wait(
        `document.querySelector('[role="dialog"]')?.innerText.includes('shows as code')`,
        'PDF fallback warning',
        45000,
      )
      await js(`document.querySelector('[data-convert-done]')?.click(); return true`)
      await wait(`!document.querySelector('[role="dialog"]')`, 'fallback PDF conversion')
    } else {
      await wait(
        `!document.querySelector('[role="dialog"]') || document.querySelector('[role="dialog"]')?.innerText.includes('The PDF is made')`,
        'PDF conversion',
        45000,
      )
      if (await js(`Boolean(document.querySelector('[role="dialog"]'))`))
        await js(
          `Array.from(document.querySelectorAll('[role="dialog"] button')).find(e=>e.textContent.trim()==='Done')?.click(); return true`,
        )
    }
    const ui = await inspectPdf(options.uiPdf, options.expected)
    await copyFile(options.uiPdf, join(evidence, options.uiEvidence))
    const result = await exec(
      cli,
      ['pdf', 'render', path, 'plain', '--out', options.cliOutput, '--json'],
      { cwd: vault, env: { ...process.env, CLAUDE_JOB_DIR: '' } },
    )
    assert.equal(JSON.parse(result.stdout).warnings.length, options.warnings)
    const cliPdf = join(vault, options.cliOutput)
    const cliProof = await inspectPdf(cliPdf, options.expected)
    await copyFile(cliPdf, join(evidence, options.cliEvidence))
    return { ui, cli: cliProof }
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
    const point = `(()=>{const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}); if(!e)throw Error('Missing visible '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2); if(!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured '+${JSON.stringify(selector)}); return {x,y}})()`
    await wait(point, `visible unobscured ${selector}`)
    const rect = await js<{ x: number; y: number }>(`return ${point}`)
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
  async function resizeTableColumn() {
    const start = await js<{ x: number; y: number; width: number }>(
      `const cell=document.querySelector('[data-pane="primary"] th'); cell.scrollIntoView({block:'nearest',inline:'nearest'}); const r=cell.getBoundingClientRect(); return {x:Math.round(r.right-2),y:Math.round(r.y+r.height/2),width:r.width}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', x: start.x, y: start.y })
    await wait(
      `getComputedStyle(document.querySelector('[data-pane="primary"] .tiptap')).cursor === 'col-resize'`,
      'real table resize handle',
    )
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: start.x,
      y: start.y,
      button: 'left',
      clickCount: 1,
    })
    try {
      for (let step = 1; step <= 5; step++) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: start.x + step * 16, y: start.y })
        await sleep(40)
      }
    } finally {
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: start.x + 80,
        y: start.y,
        button: 'left',
        clickCount: 1,
      })
    }
    await wait(
      `document.querySelector('[data-pane="primary"] th').getBoundingClientRect().width > ${start.width + 30}`,
      'native column resize changes rendered width',
    )
  }
  async function scrollTable() {
    const point = await js<{ x: number; y: number }>(
      `const wrapper=document.querySelector('[data-pane="primary"] .tableWrapper'); if(wrapper.scrollWidth<=wrapper.clientWidth)throw Error('Wide fixture table does not overflow'); const r=wrapper.getBoundingClientRect(); return {x:Math.round(r.x+Math.min(80,r.width/2)),y:Math.round(r.y+r.height/2)}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      ...point,
      deltaX: -180,
      deltaY: 0,
      canScroll: true,
    })
    await wait(
      `document.querySelector('[data-pane="primary"] .tableWrapper').scrollLeft > 0`,
      'native horizontal wheel scroll moves overflowing table',
    )
  }
  async function menu(label: string, waitForTextFocus = true) {
    press('/', ['meta'])
    await wait(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).some(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}))`,
      label,
    )
    const enabled = await js(
      `const e=Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})); return Boolean(e && e.getAttribute('aria-disabled') !== 'true' && !e.hasAttribute('disabled'))`,
    )
    assert(enabled, `${label} must be enabled for the selected block`)
    await js(
      `document.querySelectorAll('[data-caption-action]').forEach(e=>e.removeAttribute('data-caption-action')); const e=Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})); e.setAttribute('data-caption-action','selected')`,
    )
    await js(`document.querySelector('[data-caption-action="selected"]')?.click(); return true`)
    if (waitForTextFocus)
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
    // Observe the real DOM payload after ProseMirror's dragstart handler.
    // Replaying Input.dragIntercepted through dispatchDragEvent crashes Electron
    // 43's renderer intermittently on macOS. Native mouse events complete the
    // actual production drag/drop/dragend lifecycle without that CDP replay.
    await js(`
      window.captionNativeDrag = { items: [], events: [] };
      window.captionDragObserver = (event) => {
        window.captionNativeDrag.events.push(event.type);
        if (event.type === 'dragstart') {
          window.captionNativeDrag.items = Array.from(event.dataTransfer.types).map(mimeType => ({ mimeType, data: event.dataTransfer.getData(mimeType) }));
          // Moving the figure detaches its original DOM, so dragend no longer
          // bubbles to document. Observe it on the actual native source.
          window.captionDragSource = event.target;
          event.target.addEventListener('dragend', window.captionDragObserver, { once: true });
        }
      };
      for (const type of ['dragstart', 'drop']) document.addEventListener(type, window.captionDragObserver);
      return true;
    `)
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
      for (let step = 1; step <= 6; step++) {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: source.x + (destination.x - source.x) * (step / 6),
          y: source.y + (destination.y - source.y) * (step / 6),
          button: 'left',
          buttons: 1,
        })
        await sleep(80)
      }
    } finally {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...destination,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      try {
        await wait(
          `window.captionNativeDrag.events.includes('dragend')`,
          'native image drag ends',
          10000,
        )
      } finally {
        await js(`
          for (const type of ['dragstart', 'drop']) document.removeEventListener(type, window.captionDragObserver);
          window.captionDragSource?.removeEventListener('dragend', window.captionDragObserver);
          delete window.captionDragSource;
          delete window.captionDragObserver;
          return true;
        `)
      }
    }
    const data = await js<{
      items: { mimeType: string; data: string }[]
      events: string[]
    }>('return window.captionNativeDrag')
    assert.deepEqual(data.events, ['dragstart', 'drop', 'dragend'])
    assert(
      data.items.some(
        (item) =>
          item.mimeType === 'text/html' &&
          item.data.includes('<figure') &&
          item.data.includes('<figcaption>'),
      ),
      'Native image drag must expose its whole-figure payload',
    )
    assert(
      data.items.some((item) => item.mimeType === 'text/plain' && item.data.includes(imageCaption)),
    )
    await writeFile(join(evidence, 'image-native-drag-data.json'), JSON.stringify(data, null, 2))
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
  return {
    js,
    wait,
    capture,
    resizeTableColumn,
    scrollTable,
    convertAndInspectPdf,
    press,
    setRightFocus,
    click,
    doubleClick,
    menu,
    dragImageDirect,
    dragFigure,
    insertText: (text: string) => win.webContents.insertText(text),
  }
}

/** Stream compositor frames instead of issuing capturePage calls during native
 * gestures. An in-flight capture can otherwise hold CDP's drag mouse-up. */
async function recordInteraction(win: BrowserWindow) {
  await mkdir(join(evidence, 'frames'), { recursive: true })
  let latest: Buffer | undefined
  let number = 0
  let pending = false
  const writes: Promise<void>[] = []
  const errors: string[] = []
  const frame = (
    _event: Electron.Event,
    method: string,
    params: { data: string; sessionId: number },
  ) => {
    if (method !== 'Page.screencastFrame') return
    latest = Buffer.from(params.data, 'base64')
    void win.webContents.debugger
      .sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch((error: unknown) => errors.push(String(error)))
  }
  win.webContents.debugger.on('message', frame)
  const resume = () =>
    win.webContents.debugger.sendCommand('Page.startScreencast', {
      format: 'png',
      everyNthFrame: 1,
    })
  await resume()
  const timer = setInterval(() => {
    if (!latest || pending || number >= 1500) return
    pending = true
    writes.push(
      writeFile(join(evidence, 'frames', `frame-${String(number++).padStart(4, '0')}.png`), latest)
        .catch((error: unknown) => {
          errors.push(String(error))
        })
        .finally(() => {
          pending = false
        }),
    )
  }, 200)
  return {
    async pause() {
      await win.webContents.debugger.sendCommand('Page.stopScreencast')
      await Promise.all(writes)
    },
    resume,
    async stop() {
      clearInterval(timer)
      if (!win.webContents.isDestroyed() && !win.webContents.isCrashed())
        await win.webContents.debugger.sendCommand('Page.stopScreencast')
      win.webContents.debugger.removeListener('message', frame)
      await Promise.all(writes)
      assert.deepEqual(errors, [], 'native recording failed')
    },
  }
}

async function verifyReferenceImages({
  js,
  wait,
  menu,
  insertText,
}: ReturnType<typeof createEditorDriver>) {
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
    assert(referenceBody && referenceDefinition)
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
    await insertText(`Reference ${reference.name}`)
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
}

async function verifyTableCaption(driver: ReturnType<typeof createEditorDriver>) {
  const { js, wait, capture, click, insertText } = driver
  const table = '| Name | Value |\n| --- | --- |\n| Alpha | 1 |'
  const document = `${head}# Table caption acceptance\n\n${table}\n`
  await js(`await window.captionFixture.replace(${JSON.stringify(document)}); return true`)
  await wait(
    `window.captionFixture.state().markdown.includes('Table caption acceptance')`,
    'table fixture mounted',
  )
  await js(`window.captionFixture.select('paragraph'); return true`)
  await wait(`document.querySelector('[aria-label="Add caption"]')`, 'table caption toolbar')
  await click('[aria-label="Add caption"]')
  await insertText('Native table caption')
  await js('await window.captionFixture.flush(); return true')
  const saved = await readFile(note, 'utf8')
  assert(saved.startsWith(head), 'table caption save preserves frontmatter')
  assert(saved.includes('Native table caption'))
  assertTableCaption(saved, 'Native table caption', table)
  assert(
    saved.includes('Alpha') && saved.includes('Name') && saved.includes('Value'),
    'table cells remain intact',
  )
  await js('await window.captionFixture.reopen(); return true')
  await wait(
    `window.captionFixture.state().markdown.includes('Native table caption')`,
    'saved table caption reopened',
  )
  const reopened = await js<{ markdown: string }>('return window.captionFixture.state()')
  assertTableCaption(reopened.markdown, 'Native table caption', table)
  await js(`window.captionFixture.theme('light'); return true`)
  await capture('table-caption-light.png')
  await js(`window.captionFixture.theme('dark'); return true`)
  await capture('table-caption-dark.png')
  await writeFile(
    join(evidence, 'table-caption-saved.json'),
    JSON.stringify({ saved, reopened: await js('return window.captionFixture.state()') }, null, 2),
  )
  mark('native-table-toolbar-add-caption-save-reopen-frontmatter-light-dark')
  await js(`window.captionFixture.select('paragraph'); return true`)
  await wait(`document.querySelector('[aria-label="Add row below"]')`, 'table row toolbar')
  await click('[aria-label="Add row below"]')
  await click('[aria-label="Add column right"]')
  await js('await window.captionFixture.flush(); return true')
  const expanded = await js<any>('return window.captionFixture.state()')
  const expandedTable = expanded.json.content.find((node: any) => node.type === 'documentFigure')
    .content[0]
  assert.equal(expandedTable.content.length, 3)
  assert.equal(expandedTable.content[0].content.length, 3)
  await click('[aria-label="Edit caption"]')
  await insertText('Revised ')
  await js('await window.captionFixture.flush(); return true')
  const revised = await readFile(note, 'utf8')
  assert(revised.includes('Revised Native table caption'))
  await js(
    `await window.captionFixture.replace(${JSON.stringify(revised.replace('Revised', 'External'))}); return true`,
  )
  await wait(
    `document.querySelector('figcaption')?.textContent.includes('External Native table caption')`,
    'external table caption reload',
  )
  await js(`window.captionFixture.select('paragraph'); return true`)
  await wait(
    `document.querySelector('[aria-label="Remove caption"]')`,
    'table caption removal toolbar',
  )
  await click('[aria-label="Remove caption"]')
  await js('await window.captionFixture.flush(); return true')
  const removed = await readFile(note, 'utf8')
  assert(!removed.includes('holi:figure') && removed.includes('Alpha'))
  mark('native-table-row-column-caption-edit-external-reload-and-remove')
  const framed = (caption: string) =>
    `<!-- holi:figure -->\n\n${table}\n\n<!-- holi:caption -->\n\n${caption}\n\n<!-- /holi:figure -->`
  await js(
    `await window.captionFixture.replace(${JSON.stringify(`${head}${framed('First caption')}\n\n${framed('Second caption')}\n\n${table}\n`)}); return true`,
  )
  await click('[data-pane="primary"] figure:nth-of-type(1) td p')
  await wait(
    `document.querySelector('[aria-label="Remove caption"]')`,
    'first table caption controls',
  )
  await click('[data-pane="primary"] figure:nth-of-type(2) td p')
  await wait(
    `document.querySelector('[aria-label="Remove caption"]')`,
    'second table caption controls',
  )
  await click('[aria-label="Remove caption"]')
  await js('await window.captionFixture.flush(); return true')
  const switched = await readFile(note, 'utf8')
  assert(
    switched.includes('First caption') && !switched.includes('Second caption'),
    'caption removal targets the currently selected matching table',
  )
  await click('[data-pane="primary"] .tiptap > .tableWrapper:last-of-type td p')
  await wait(
    `document.querySelector('[aria-label="Add caption"]') && !document.querySelector('[aria-label="Remove caption"]')`,
    'bare table gets fresh caption controls',
  )
  mark('native-matching-tables-caption-controls-follow-current-selection')
  await verifyTableBlocks(driver)
  await verifyTableViews(driver)
  await verifyTableLayouts(driver)
}

function assertTableCaption(markdown: string, caption: string, body: string, count = 1) {
  const frames = readMarkdownTableCaptions(markdown)
  assert.equal(frames.length, count, 'each table retains its own portable caption envelope')
  const rows = (value: string) =>
    value
      .trim()
      .split('\n')
      .map((row, index) =>
        row.split('|').map((cell) => (index === 1 ? cell.trim().replace(/-+/g, '-') : cell.trim())),
      )
  for (const frame of frames) {
    assert.equal(markdown.slice(frame.caption.from, frame.caption.to), caption)
    assert.deepEqual(rows(markdown.slice(frame.body.from, frame.body.to)), rows(body))
  }
}

async function verifyTableBlocks({
  js,
  wait,
  click,
  insertText,
  press,
  menu,
  capture,
}: ReturnType<typeof createEditorDriver>) {
  const table = '| Name | Value |\n| --- | --- |\n| Alpha | 1 |'
  const caption = 'Table **portable** caption.'
  await js(
    `await window.captionFixture.replace(${JSON.stringify(`${head}# Table actions\n\nBefore the table.\n\n${table}\n\nAfter the table.\n`)}); return true`,
  )
  await click('[data-pane="primary"] td p')
  await wait(`document.querySelector('[aria-label="Add caption"]')`, 'table authoring control')
  await click('[aria-label="Add caption"]')
  await insertText('Table ')
  press('b', ['meta'])
  await insertText('portable')
  press('b', ['meta'])
  await insertText(' caption.')
  await wait(
    `window.captionFixture.state().markdown.includes(${JSON.stringify(caption)})`,
    'formatted table caption',
  )
  await js('await window.captionFixture.flush(); return true')
  const authored = await readFile(note, 'utf8')
  assert(authored.startsWith(head))
  assertTableCaption(authored, caption, table)
  await js('await window.captionFixture.reopen(); return true')
  await wait(
    `document.querySelector('[data-pane="primary"] figcaption strong')?.textContent === 'portable'`,
    'formatted caption after reopen',
  )
  assert.equal(
    await js(
      `return getComputedStyle(document.querySelector('[data-pane="primary"] figcaption')).textAlign`,
    ),
    'center',
  )
  assertTableCaption(
    (await js<{ markdown: string }>('return window.captionFixture.state()')).markdown,
    caption,
    table,
  )
  await js(`window.captionFixture.theme('light'); return true`)
  await capture('table-caption-formatted-light.png')
  await js(`window.captionFixture.theme('dark'); return true`)
  await capture('table-caption-formatted-dark.png')
  mark('native-table-formatted-caption-complete-save-and-reopen')

  await js(`window.captionFixture.select('documentFigure'); return true`)
  await menu('Duplicate')
  await wait(
    `document.querySelectorAll('[data-pane="primary"] figure').length === 2`,
    'whole table duplicated',
  )
  assertTableCaption(
    (await js<{ markdown: string }>('return window.captionFixture.state()')).markdown,
    caption,
    table,
    2,
  )
  press('z', ['meta'])
  await wait(
    `document.querySelectorAll('[data-pane="primary"] figure').length === 1`,
    'table duplicate undone',
  )
  await js(`window.captionFixture.select('documentFigure'); return true`)
  await menu('Move Up')
  await wait(
    `window.captionFixture.state().markdown.indexOf('holi:figure') < window.captionFixture.state().markdown.indexOf('Before the table.')`,
    'table and caption move up together',
  )
  await js(`window.captionFixture.select('documentFigure'); return true`)
  await menu('Move Down')
  await wait(
    `window.captionFixture.state().markdown.indexOf('holi:figure') > window.captionFixture.state().markdown.indexOf('Before the table.')`,
    'table and caption move down together',
  )
  await js('await window.captionFixture.flush(); return true')
  assertTableCaption(await readFile(note, 'utf8'), caption, table)
  mark('native-table-duplicate-move-and-undo-preserve-association')

  await click('[data-pane="primary"] td p')
  await wait(
    `document.querySelector('[aria-label="Delete"][data-toolbar-item]')`,
    'table deletion menu',
  )
  await click('[aria-label="Delete"][data-toolbar-item]')
  await wait(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).some(e => e.textContent.trim() === 'Delete Table')`,
    'whole-table deletion option',
  )
  await js(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).find(e => e.textContent.trim() === 'Delete Table').setAttribute('data-table-delete', 'true'); return true`,
  )
  await click('[data-table-delete="true"]')
  await wait(`document.querySelector('[role="alertdialog"]')`, 'real table deletion confirmation')
  await js(
    `Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(e => e.textContent.trim() === 'Delete Table').setAttribute('data-table-confirm', 'true'); return true`,
  )
  await click('[data-table-confirm="true"]')
  await wait(
    `!document.querySelector('[data-pane="primary"] table') && !document.querySelector('[data-pane="primary"] figcaption')`,
    'whole table and caption deleted',
  )
  await js('await window.captionFixture.flush(); return true')
  const deleted = await readFile(note, 'utf8')
  assert(!deleted.includes('Alpha') && !deleted.includes('holi:figure'))
  await click('[data-pane="primary"] [role="textbox"] > p')
  press('z', ['meta'])
  await wait(
    `document.querySelector('[data-pane="primary"] figcaption strong')?.textContent === 'portable'`,
    'whole table deletion undone',
  )
  await js('await window.captionFixture.flush(); return true')
  assertTableCaption(await readFile(note, 'utf8'), caption, table)
  await js('await window.captionFixture.reopen(); return true')
  await wait(
    `document.querySelector('[data-pane="primary"] figcaption strong')?.textContent === 'portable'`,
    'undone table deletion persisted',
  )
  await capture('table-caption-actions.png')
  await writeFile(join(evidence, 'table-actions-saved.md.txt'), await readFile(note, 'utf8'))
  mark('native-table-confirmed-delete-and-undo-save-reopen')
}

async function verifyTableViews({
  js,
  wait,
  click,
  insertText,
  press,
  capture,
}: ReturnType<typeof createEditorDriver>) {
  const table = '| Name | Value |\n| --- | --- |\n| Alpha | 1 |'
  const caption = 'Table **portable** caption.'
  const primary = await readFile(note, 'utf8')
  const otherBefore = await readFile(join(vault, 'notes/Clipboard.md'), 'utf8')
  assertTableCaption(primary, caption, table)
  await js(`window.captionFixture.select('documentCaption', 'primary', true); return true`)
  const anchor = await js<{
    anchor: { quote: string }
    lines: { startLine: number; endLine: number }
  }>('return await window.captionFixture.anchor()')
  assert(anchor.anchor.quote.includes('portable'))
  assert(
    primary
      .split('\n')
      .slice(anchor.lines.startLine - 1, anchor.lines.endLine)
      .join('\n')
      .includes(caption),
  )
  press('f', ['meta'])
  await wait(`document.querySelector('input[aria-label="Find"]')`, 'table caption find field')
  await click('input[aria-label="Find"]')
  press('a', ['meta'])
  await insertText('portable')
  await wait(
    `document.querySelector('[role="search"]')?.textContent.includes('1 of 1')`,
    'table caption find match',
  )
  await capture('table-caption-find.png')
  press('Escape')
  await wait(`!document.querySelector('input[aria-label="Find"]')`, 'table find closes')
  mark('native-table-caption-find-and-file-comment-anchors')

  await js('await window.captionFixture.flush(); return true')
  await writeFile(
    join(vault, 'notes/Clipboard.md'),
    primary.replace(caption, 'Other **portable** caption.'),
  )
  await js('window.captionFixture.split(true); return true')
  await wait(
    `document.querySelector('[data-pane="secondary"] figcaption strong')?.textContent === 'portable'`,
    'second captioned table mounted',
  )
  await click('[data-pane="secondary"] td p')
  const secondaryCaption = `Array.from(document.querySelectorAll('[aria-label="Edit caption"]')).find(e=>{const r=e.getBoundingClientRect(),pane=document.querySelector('[data-pane="secondary"]').getBoundingClientRect();return r.width>0&&r.x>=pane.left&&getComputedStyle(e).visibility!=='hidden'})`
  await wait(secondaryCaption, 'secondary table caption control')
  await js(`${secondaryCaption}.setAttribute('data-secondary-caption', 'true'); return true`)
  await click('[data-secondary-caption="true"]')
  await wait(
    `document.activeElement?.closest('[data-pane="secondary"]')`,
    'secondary caption owns native input',
  )
  await insertText('Secondary ')
  await js('await window.captionFixture.flush(); return true')
  assert.equal(await readFile(note, 'utf8'), primary)
  assertTableCaption(
    await readFile(join(vault, 'notes/Clipboard.md'), 'utf8'),
    'Secondary Other **portable** caption.',
    table,
  )
  await js('window.captionFixture.hide(true); return true')
  await wait(`!window.captionFixture.state().editable`, 'hidden table is read-only')
  await js(
    'window.captionFixture.hide(false); window.captionFixture.rightFocused(false); return true',
  )
  await wait(
    `window.captionFixture.state().editable && document.querySelector('[data-pane="primary"] figcaption strong')?.textContent === 'portable'`,
    'retained table returns unchanged',
  )
  await capture('table-caption-split.png')
  assert.equal(await readFile(note, 'utf8'), primary)
  mark('native-table-split-and-retained-view-ownership')

  await js('window.captionFixture.split(false); window.captionFixture.locked(true); return true')
  await wait(`!window.captionFixture.state().editable`, 'table document locked')
  await js(`document.querySelector('[data-pane="primary"] [role="textbox"]').focus(); return true`)
  await insertText('MUST NOT WRITE')
  await js('await window.captionFixture.flush(); return true')
  assert.equal(await readFile(note, 'utf8'), primary)
  await capture('table-caption-locked.png')
  await js('window.captionFixture.locked(false); return true')
  await wait('window.captionFixture.state().editable', 'table document unlocked')
  mark('native-table-locked-view-rejects-native-mutation')

  const plain = primary.replace(caption, 'Table **Markdown-edited** caption.')
  await js('await window.captionFixture.flush(); return true')
  await writeFile(join(vault, 'notes/Clipboard.md'), '')
  await js(
    `await window.captionFixture.openPaths(${JSON.stringify(path)}, 'notes/Clipboard.md', true); window.captionFixture.split(true); window.captionFixture.rightFocused(true); return true`,
  )
  await wait(`window.captionFixture.plainState()`, 'production plain Markdown editor mounted')
  await js('window.captionFixture.plainState(true); return true')
  await wait(
    `document.activeElement?.closest('[data-pane="secondary"] .cm-editor')`,
    'plain Markdown editor owns native input',
  )
  await insertText(plain)
  await wait(
    `window.captionFixture.plainState()?.text.includes('Markdown-edited')`,
    'native Markdown edit received',
  )
  await js('await window.captionFixture.flush(); return true')
  const plainSaved = await readFile(join(vault, 'notes/Clipboard.md'), 'utf8')
  assert(plainSaved.startsWith(head))
  assertTableCaption(plainSaved, 'Table **Markdown-edited** caption.', table)
  assert.equal(await readFile(note, 'utf8'), primary)
  await capture('table-caption-markdown.png')
  await js(
    `await window.captionFixture.openPaths('notes/Clipboard.md', ${JSON.stringify(path)}); window.captionFixture.split(false); window.captionFixture.rightFocused(false); return true`,
  )
  await wait(
    `document.querySelector('[data-pane="primary"] figcaption strong')?.textContent === 'Markdown-edited'`,
    'plain Markdown reopens as formatted native table caption',
  )
  assertTableCaption(
    (await js<{ markdown: string }>('return window.captionFixture.state()')).markdown,
    'Table **Markdown-edited** caption.',
    table,
  )
  await writeFile(join(evidence, 'table-markdown-saved.md.txt'), plainSaved)
  await js(
    `await window.captionFixture.openPaths(${JSON.stringify(path)}, 'notes/Clipboard.md'); return true`,
  )
  await wait(
    `document.querySelector('[data-pane="primary"] figcaption strong')?.textContent === 'portable'`,
    'original table view restored',
  )
  await writeFile(join(vault, 'notes/Clipboard.md'), otherBefore)
  mark('native-table-plain-markdown-edit-save-and-rich-reopen')
}

async function verifyTableLayouts(driver: ReturnType<typeof createEditorDriver>) {
  const { js, wait, insertText, capture, resizeTableColumn, scrollTable } = driver
  const columns = Array.from({ length: 16 }, (_, index) => `Column ${index}`)
  const table = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    `| ${columns.map((_, index) => `Value ${index}`).join(' | ')} |`,
  ].join('\n')
  const caption = 'Layout **portable** caption.'
  let originalStyle: 'banded' | 'lines' | undefined
  try {
    for (const style of ['banded', 'lines'] as const) {
      const previous = await js<'banded' | 'lines'>(
        `return window.captionFixture.tableStyle(${JSON.stringify(style)})`,
      )
      originalStyle ??= previous
      await js(
        `await window.captionFixture.replace(${JSON.stringify(`${head}# Table layout\n\n${writeMarkdownTableCaption(table, caption)}\n`)}); return true`,
      )
      await wait(
        `document.querySelector('[data-pane="primary"] [data-table-style]')?.dataset.tableStyle === ${JSON.stringify(style)} && document.querySelector('[data-pane="primary"] figcaption strong')?.textContent === 'portable'`,
        `${style} captioned table mounted`,
      )
      await js(`window.captionFixture.select('paragraph', 'primary', true); return true`)
      await insertText('Changed header')
      await resizeTableColumn()
      await scrollTable()
      await js('await window.captionFixture.flush(); return true')
      const saved = await readFile(note, 'utf8')
      assert(saved.startsWith(head))
      assertTableCaption(saved, caption, table.replace('Column 0', 'Changed header'))
      const geometry = await js<{ tableBottom: number; captionTop: number; align: string }>(
        `const table=document.querySelector('[data-pane="primary"] table'),caption=document.querySelector('[data-pane="primary"] figcaption'); return {tableBottom:table.getBoundingClientRect().bottom,captionTop:caption.getBoundingClientRect().top,align:getComputedStyle(caption).textAlign}`,
      )
      assert(
        geometry.captionTop >= geometry.tableBottom,
        'caption remains beneath the resized scrolling table',
      )
      assert.equal(geometry.align, 'center')
      await capture(`table-caption-${style}.png`)
      await js('await window.captionFixture.reopen(); return true')
      await wait(
        `document.querySelector('[data-pane="primary"] th')?.textContent === 'Changed header'`,
        `${style} table selection/edit persisted`,
      )
      assertTableCaption(
        (await js<{ markdown: string }>('return window.captionFixture.state()')).markdown,
        caption,
        table.replace('Column 0', 'Changed header'),
      )
      mark(`native-table-${style}-selection-resize-scroll-and-reopen`)
    }
  } finally {
    if (originalStyle !== undefined)
      await js(`window.captionFixture.tableStyle(${JSON.stringify(originalStyle)}); return true`)
  }
}

async function verifyParserSource({
  js,
  wait,
  capture,
  insertText,
}: ReturnType<typeof createEditorDriver>) {
  const definition = '[photo]: ../assets/smoke.png "Photo title"'
  const frame = `<!-- holi:figure -->\n\n![Smoke photo][photo]\n\n<!-- holi:caption -->\n\nParser source portable caption.\n\n<!-- /holi:figure -->`
  const opaque =
    '<!-- holi:figure -->\n\nUnsupported body.\n\n[ref]: https://example.com/right\n\n<!-- holi:caption -->\n\nCaption\n\n<!-- /holi:figure -->'
  const nestedOpaque =
    '<!-- holi:figure -->\n\nOuter.\n\n<!-- holi:figure -->\n\nUnsupported inner.\n\n<!-- holi:caption -->\n\nInner caption\n\n<!-- /holi:figure -->\n\nOuter tail.\n\n[photo]: ../assets/smoke.png "Photo title"\n\n<!-- /holi:figure -->'
  const cases = [
    {
      name: 'nested-opaque-tail',
      body: `${nestedOpaque}\n\nAfter important prose.\n\n![Trailing][photo]\n\n${frame}\n\n[photo]: ../assets/second.png\n\nEnd.`,
      opaque: nestedOpaque,
      imageCount: 2,
    },
    {
      name: 'adjacent',
      body: `${definition}\n[second]: ../assets/second.png\nFollowing paragraph.\n\n${frame}`,
    },
    { name: 'duplicate', body: `${definition}\n[photo]: ../assets/second.png\n\n${frame}` },
    ...['```md\n', '<pre>\n', '<!--\n'].map((opening, index) => ({
      name: `protected-${index}`,
      body: `${opening}${definition}\n${['```', '</pre>', '-->'][index]}\n\n${frame}\n\n${definition}`,
    })),
    {
      name: 'list',
      body: `${frame}\n\n- Important **editable** item\n\n  ${definition}`,
      native: 'bulletList',
    },
    {
      name: 'quote',
      body: `${frame}\n\n> Important **editable** quote\n>\n> ${definition}`,
      native: 'blockquote',
    },
    {
      name: 'opaque',
      body: `[Label][ref]\n\n${frame}\n\n${definition}\n\n${opaque}\n\n[ref]: https://example.com/wrong`,
      href: 'https://example.com/right',
    },
    {
      name: 'nested-html',
      body: `![Smoke photo](../assets/smoke.png)\n\n- Before\n\n  <pre>\n${frame
        .split('\n')
        .map((line) => '  ' + line)
        .join('\n')}\n  </pre>\n\n${definition}`,
      native: 'bulletList',
    },
  ]
  for (const scenario of cases) {
    await js(
      `await window.captionFixture.replace(${JSON.stringify(`${head}# Parser ${scenario.name}

${scenario.body}
`)}); return true`,
    )
    await wait(
      `window.captionFixture.state().markdown.includes(${JSON.stringify(`Parser ${scenario.name}`)})`,
      'parser scenario mounted',
    )
    for (let cycle = 0; cycle < 2; cycle++) {
      await js(`window.captionFixture.select('heading'); return true`)
      await insertText(' edited')
      await js('await window.captionFixture.flush(); return true')
      const saved = await readFile(note, 'utf8')
      assert(saved.startsWith(head))
      assert(!saved.includes('holi-private'))
      assert(saved.includes(definition))
      if (scenario.name === 'adjacent')
        assert(
          saved.includes('[second]: ../assets/second.png') &&
            saved.includes('Following paragraph.'),
        )
      if (scenario.name === 'nested-html') assert(saved.includes('</pre>'))
      if (scenario.opaque) {
        assert(saved.includes(scenario.opaque))
        assert(saved.includes('After important prose.') && saved.includes('End.'))
        assert(saved.includes('![Trailing][photo]') && saved.includes(frame))
        assert.equal(saved.match(/\[photo\]:/g)?.length, 2)
      }
      if (scenario.name === 'opaque')
        assert(saved.includes(opaque) && saved.match(/\[ref\]:/g)?.length === 2)
      await js('await window.captionFixture.reopen(); return true')
      await wait(
        `window.captionFixture.state().markdown.includes(' edited')`,
        'parser saved document reopened',
      )
      const state = await js<{ json: { content: any[] } }>('return window.captionFixture.state()')
      const nodes: any[] = []
      const visit = (children: any[]) => {
        for (const child of children) {
          nodes.push(child)
          visit(child.content ?? [])
        }
      }
      visit(state.json.content)
      assert.deepEqual(
        nodes.filter((node) => node.type === 'image').map((node) => node.attrs.src),
        Array(scenario.imageCount ?? 1).fill('../assets/smoke.png'),
      )
      if (scenario.native) assert(nodes.some((node) => node.type === scenario.native))
      if (scenario.href)
        assert(
          nodes.some((node) =>
            node.marks?.some(
              (mark: any) => mark.type === 'link' && mark.attrs.href === scenario.href,
            ),
          ),
        )
      await writeFile(
        join(evidence, `parser-${scenario.name}-${cycle}.json`),
        JSON.stringify({ saved, state }, null, 2),
      )
    }
    await js(`window.captionFixture.theme('light'); return true`)
    await capture(`parser-${scenario.name}-light.png`)
    await js(`window.captionFixture.theme('dark'); return true`)
    await capture(`parser-${scenario.name}-dark.png`)
    await js(`window.captionFixture.theme('light'); return true`)
    mark(`native-parser-${scenario.name}-edit-flush-reopen`)
  }
}

async function verifyImageTransfers(
  { js, wait, capture, setRightFocus }: ReturnType<typeof createEditorDriver>,
  win: BrowserWindow,
  cli: string,
) {
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
    {
      name: 'spaced-image-path',
      source: 'Root-spaced-source.md',
      target: 'notes/deep/Spaced-target.md',
      src: 'assets/smoke photo.png',
      expected: '../../assets/smoke photo.png',
    },
    ...['+', '&', '#', '?', '%20'].map((character, index) => ({
      name: `reserved-image-path-${index}`,
      source: `Root-reserved-${index}.md`,
      target: `notes/deep/Reserved-${index}.md`,
      src: `assets/smoke${character === '%20' ? '%2520' : character}one.png`,
      expected: `../../assets/smoke${character}one.png`,
    })),
  ]
  await copyFile(join(vault, 'assets/smoke.png'), join(vault, 'assets/smoke photo.png'))
  for (const character of ['+', '&', '#', '?', '%20'])
    await copyFile(join(vault, 'assets/smoke.png'), join(vault, `assets/smoke${character}one.png`))
  await mkdir(join(vault, 'notes/deep'), { recursive: true })
  for (const transfer of transfers) {
    await js('await window.captionFixture.flush(); return true')
    const imageMarkdown = /\s/.test(transfer.src)
      ? `![Smoke photo](<${transfer.src}> "Photo title")`
      : `![Smoke photo](${transfer.src} "Photo title")`
    await writeFile(join(vault, transfer.source), frame(imageMarkdown))
    await writeFile(join(vault, transfer.target), '')
    await js(
      `await window.captionFixture.openPaths(${JSON.stringify(transfer.source)}, ${JSON.stringify(transfer.target)}); window.captionFixture.split(true); window.captionFixture.rightFocused(false); return true`,
    )
    await wait(
      `window.captionFixture.state().json.content.some(n=>n.type==='documentFigure') && Boolean(window.captionFixture.state('secondary'))`,
      'folder transfer editors mounted',
    )
    await setRightFocus(false)
    const displayedAsset = await js<string>(
      `const image=document.querySelector('[data-pane="primary"] figure img'); if(!image?.complete || !image.naturalWidth)throw Error('Source image did not load'); return image.src`,
    )
    await js(`window.captionFixture.select('image'); return true`)
    win.webContents.copy()
    await sleep(150)
    const portableClipboard = clipboard.readText()
    assert(portableClipboard.includes('<!-- holi:figure -->'))
    assert(portableClipboard.includes(transfer.src))
    assert(!portableClipboard.includes('holi-vault:'))
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
    const encodedExpected = transfer.expected.split('/').map(encodeURIComponent).join('/')
    const expectedImageMarkdown = [transfer.expected, encodedExpected].flatMap((destination) => [
      `![Smoke photo](${destination} "Photo title")`,
      `![Smoke photo](<${destination}> "Photo title")`,
    ])
    assert(expectedImageMarkdown.some((markdown) => saved.includes(markdown)))
    assert(!saved.includes('holi-vault:'))
    await js(
      `await window.captionFixture.openPaths(${JSON.stringify(transfer.target)}, 'notes/Clipboard.md'); window.captionFixture.split(false); window.captionFixture.rightFocused(false); return true`,
    )
    await wait(
      `window.captionFixture.state().json.content.some(n=>n.type==='documentFigure')`,
      'folder transfer reopen',
    )
    const reopenedSrc = collectImageAttrs(await js('return window.captionFixture.state()'))[0].src
    assert.equal(decodeURIComponent(reopenedSrc), transfer.expected)
    await writeFile(
      join(evidence, `${transfer.name}-reopened.json`),
      JSON.stringify(await js('return window.captionFixture.state()'), null, 2),
    )
    await wait(
      `Array.from(document.querySelectorAll('[data-pane="primary"] figure img')).some(image=>image.src===${JSON.stringify(displayedAsset)} && image.complete && image.naturalWidth>0)`,
      'identical actual asset URL loads after paste and reopen',
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

  // Untrusted provenance must not abort the real native HTML paste. Keep the
  // visible local asset valid so the check proves fallback, not just no throw.
  for (const source of ['bad%', 'bad%2', 'bad%GG', 'bad%C3%28']) {
    await js('await window.captionFixture.flush(); return true')
    await writeFile(join(vault, 'notes/Malformed-paste.md'), '')
    await js(
      `await window.captionFixture.openPaths('notes/Malformed-paste.md', 'notes/Clipboard.md'); window.captionFixture.split(false); window.captionFixture.rightFocused(false); return true`,
    )
    await wait(
      `window.captionFixture.state().editable && !window.captionFixture.state().markdown`,
      'empty malformed provenance destination',
    )
    const html = `<figure data-holi-code-figure><img src="holi-vault://vault/assets/smoke.png" data-holi-source-src="${source}" data-holi-source-folder="notes" alt="Visible photo"><figcaption>Kept paste caption</figcaption></figure><p>Kept trailing prose.</p>`
    clipboard.write({ html, text: 'Kept paste caption' })
    await js(
      `document.querySelector('[data-pane="primary"] [role="textbox"]').editor.view.focus(); return true`,
    )
    win.webContents.paste()
    await wait(
      `window.captionFixture.state().markdown.includes('Kept trailing prose.')`,
      'malformed provenance native paste retained',
    )
    await js('await window.captionFixture.flush(); return true')
    await js('await window.captionFixture.reopen(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('Kept paste caption')`,
      'malformed provenance disk reopen',
    )
    const state = await js<{ json: { content: any[] } }>('return window.captionFixture.state()')
    assert.equal(collectImageAttrs(state)[0].src, 'holi-vault://vault/assets/smoke.png')
    await wait(
      `document.querySelector('[data-pane="primary"] figure img')?.naturalWidth>0`,
      'visible fallback image loaded',
    )
    await writeFile(
      join(evidence, `malformed-paste-${encodeURIComponent(source)}.json`),
      JSON.stringify(state, null, 2),
    )
    mark(`native-malformed-provenance-${encodeURIComponent(source)}-paste-flush-reopen`)
  }
  await capture('malformed-provenance-visible-fallback.png')
}

async function seedVault() {
  for (const dir of [
    roots.profile,
    roots.session,
    join(root, 'app-data'),
    join(vault, '.holi'),
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
}

async function run() {
  await seedVault()
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
  const mermaid = tablesOnly ? undefined : createMermaidWindow()
  const capabilities = createCapabilityRegistry()
  if (mermaid)
    capabilities.register(
      PDF_NAMESPACES,
      pdfCapabilities({
        typst: async () => typst,
        diagrams: (sources) => mermaid.draw(sources),
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
    const imageUrl = new URL(request.url)
    let imagePath: string | null = null
    try {
      const decoded = decodeURIComponent(imageUrl.pathname).replace(/^\//, '')
      if (imageUrl.hostname === 'vault' && fixtureImagePaths.has(decoded)) imagePath = decoded
    } catch {
      // Malformed URL escapes are not fixture assets.
    }
    assert(
      imagePath && fixtureImageUrls.has(request.url),
      `unexpected fixture image: ${request.url}`,
    )
    try {
      const bytes = await readFile(join(vault, imagePath))
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
      fixtureImageUrls.has(details.url) ||
      details.url.startsWith('data:')
    if (!allowed) denied.push(details.url)
    done({ cancel: !allowed })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`Renderer exited: ${details.reason} (${details.exitCode})`)
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
  const driver = createEditorDriver(win, cli)
  const {
    js,
    wait,
    capture,
    convertAndInspectPdf,
    press,
    setRightFocus,
    click,
    doubleClick,
    menu,
    dragImageDirect,
    dragFigure,
  } = driver
  let ok = false
  let recording: Awaited<ReturnType<typeof recordInteraction>> | undefined
  try {
    await win.loadURL(url)
    win.focus()
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Page.enable')
    await wait(`window.captionFixture?.state()?.json`, 'production DocumentView')
    mark('production-document-view-with-real-router-filesystem')
    recording = await recordInteraction(win)
    if (tablesOnly) {
      await verifyTableCaption(driver)
      assert.deepEqual(denied, [])
      assert.deepEqual(await js('return window.captionFixture.errors'), [])
      assert.deepEqual(rendererErrors, [])
      ok = true
      // Return through the same recording, receipt, window and bridge teardown.
      return
    }
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
    win.webContents.copy()
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
    await wait(
      `window.captionFixture.state().selection.type==='node'`,
      'whole figure selected before move down',
    )
    await js(
      `document.querySelector('[data-pane="primary"] [role="textbox"]').editor.commands.focus(); return true`,
    )
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
    await recording.pause()
    try {
      await dragImageDirect()
    } finally {
      if (!win.webContents.isCrashed()) await recording.resume()
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
    const ordinaryProof = await convertAndInspectPdf({
      uiPdf: join(vault, 'notes/Code-caption.pdf'),
      cliOutput: 'notes/cli.pdf',
      uiEvidence: 'native-ui.pdf',
      cliEvidence: 'native-cli.pdf',
      expected: { caption: renderedImageCaption },
      warnings: 0,
    })
    mark('production-convert-ui-through-real-typst-and-centered-output')
    assert.equal(await readFile(note, 'utf8'), beforePdf)
    assert(calls.some((c) => c.door === 'ui' && c.name === 'pdf.render'))
    assert(calls.some((c) => c.door === 'cli' && c.name === 'pdf.render'))
    await writeFile(join(evidence, 'pdf-proof.json'), JSON.stringify(ordinaryProof, null, 2))
    await writeFile(join(evidence, 'editor-saved.md.txt'), beforePdf)
    mark('actual-holi-cli-through-private-bridge-and-real-pdf-capability')

    await verifyReferenceImages(driver)
    await verifyParserSource(driver)
    await verifyTableCaption(driver)

    await verifyImageTransfers(driver, win, cli)
    await js(
      `await window.captionFixture.openPaths(${JSON.stringify(path)}, 'notes/Clipboard.md'); window.captionFixture.split(false); return true`,
    )
    await wait(
      `window.captionFixture.state().markdown.includes('Same alt provenance')`,
      'return to primary fixture document after transfer scenarios',
    )

    const mermaidCaption = 'A native Mermaid caption'
    const mermaidSource = `flowchart TD\nA[Alpha] --> B[Target]`
    const mermaidFence = `~~~mermaid\n${mermaidSource}\n~~~`
    const editedMermaidFence = [
      `${String.fromCharCode(96).repeat(3)} mermaid`,
      'flowchart TD',
      'A[Gamma] --> B[Target]',
      String.fromCharCode(96).repeat(3),
    ].join('\n')
    await js(
      `await window.captionFixture.replace(${JSON.stringify(`${head}# Mermaid caption\n\n${mermaidFence}\n`)}); return true`,
    )
    await js(`window.captionFixture.select('codeBlock'); return true`)
    await menu('Add caption')
    await wait(`document.querySelector('figcaption')`, 'Mermaid caption authoring')
    await win.webContents.insertText(mermaidCaption)
    await sleep(350)
    await wait(
      `window.captionFixture.state().markdown.includes('A native Mermaid caption') && document.querySelector('figure [data-mermaid-diagram] svg')`,
      'edited Mermaid caption keeps its rendered diagram',
    )
    await js('await window.captionFixture.flush(); return true')
    assert((await readFile(note, 'utf8')).includes(mermaidCaption))
    await js(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Edit labels')?.click(); return true`,
    )
    const label = await js<{ x: number; y: number }>(
      `const e=Array.from(document.querySelectorAll('[role="button"]')).find(e=>e.getAttribute('aria-label')==='Alpha' || e.textContent.trim()==='Alpha'); if(!e)throw Error('Rendered Mermaid Alpha label missing'); e.setAttribute('data-caption-action','label'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...label })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...label, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...label, button: 'left', clickCount: 1 })
    await wait(`document.querySelector('input[aria-invalid]')`, 'Mermaid label editor')
    await sleep(350)
    await click('input[aria-invalid]')
    await wait(
      `document.activeElement === document.querySelector('input[aria-invalid]')`,
      'Mermaid label field owns native focus',
    )
    win.webContents.selectAll()
    await wait(
      `(() => { const input = document.querySelector('input[aria-invalid]'); return input.selectionStart === 0 && input.selectionEnd === input.value.length })()`,
      'Mermaid label text selected before replacement',
    )
    await win.webContents.insertText('Gamma')
    await wait(
      `document.querySelector('input[aria-invalid]')?.value === 'Gamma'`,
      'Mermaid label replacement committed',
    )
    await js(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Apply')?.click(); return true`,
    )
    await wait(
      `window.captionFixture.state().markdown.includes('A[Gamma] --> B[Target]')`,
      'Mermaid label edit redraw',
    )
    await sleep(350)
    await wait(
      `document.querySelector('figure [data-mermaid-diagram] svg')`,
      'Mermaid SVG redraw after label edit',
    )
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(mermaidCaption),
      'caption survives a rendered Mermaid label redraw',
    )
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().markdown.includes('A[Alpha] --> B[Target]')`,
      'Mermaid label undo',
    )
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(mermaidCaption),
      'label undo retains the edited caption',
    )
    press('z', ['meta', 'shift'])
    await wait(
      `window.captionFixture.state().markdown.includes('A[Gamma] --> B[Target]')`,
      'Mermaid label redo',
    )
    await wait(
      `document.querySelector('figure [data-mermaid-diagram] svg')`,
      'Mermaid SVG redraw after label redo',
    )
    await sleep(350)
    mark('native-mermaid-label-edit-undo-keeps-caption')
    await js(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Edit source')?.click(); return true`,
    )
    await wait(
      `document.querySelector('[data-pane="primary"] [role="textbox"]').editor.state.selection.$from.parent.type.name==='codeBlock'`,
      'nested Mermaid Edit source action',
    )
    assert.equal(
      await js(
        `return document.querySelector('[data-pane="primary"] [role="textbox"]').editor.state.selection.$from.parent.type.name`,
      ),
      'codeBlock',
    )
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(
        'A native Mermaid caption',
      ),
    )
    press('Escape')
    await js(`window.captionFixture.select('documentCaption'); return true`)
    await wait(
      `document.querySelector('figure [data-mermaid-diagram] svg')`,
      'rendered Mermaid preview after nested source edit',
    )
    mark('native-mermaid-caption-authoring-and-source-target')

    await js(`window.captionFixture.select('documentCaption', 'primary', true); return true`)
    await js('await window.captionFixture.flush(); return true')
    let mermaidSaved = await readFile(note, 'utf8')
    await writeFile(join(evidence, 'mermaid-authored.md.txt'), mermaidSaved)
    assert(mermaidSaved.startsWith(head), 'Mermaid must preserve exact frontmatter and its comment')
    assert(mermaidSaved.includes(editedMermaidFence), 'Mermaid must preserve its exact code fence')
    assert.equal(readMarkdownCodeCaptions(mermaidSaved).length, 1)
    const mermaidAnchor = await js<{
      anchor: { quote: string }
      lines: { startLine: number; endLine: number }
    }>('return await window.captionFixture.anchor()')
    assert(mermaidAnchor.anchor.quote.includes(mermaidCaption))
    assert(
      mermaidSaved
        .split('\n')
        .slice(mermaidAnchor.lines.startLine - 1, mermaidAnchor.lines.endLine)
        .join('\n')
        .includes(mermaidCaption),
      'Mermaid caption comment and file-line anchors must map to its saved Markdown',
    )
    mark('mermaid-comment-and-file-line-anchors')

    press('f', ['meta'])
    await wait(`document.querySelector('input[aria-label="Find"]')`, 'Mermaid native find')
    await click('input[aria-label="Find"]')
    win.webContents.selectAll()
    await win.webContents.insertText(mermaidCaption)
    await wait(
      `document.querySelector('[role="search"]').textContent.includes('1 of 1')`,
      'Mermaid caption find mapping',
    )
    await click('[aria-label="Show replace"]')
    await click('input[aria-label="Replace"]')
    await win.webContents.insertText('Mermaid verified caption')
    press('Enter')
    await wait(
      `window.captionFixture.state().markdown.includes('Mermaid verified caption')`,
      'Mermaid native caption replacement',
    )
    press('Escape')
    await sleep(100)
    press('z', ['meta'])
    await wait(
      `window.captionFixture.state().markdown.includes(${JSON.stringify(mermaidCaption)})`,
      'Mermaid caption replacement undo',
    )
    mark('mermaid-native-find-replace-and-undo')

    await js(`window.captionFixture.select('documentFigure'); return true`)
    win.focus()
    win.webContents.copy()
    for (
      let attempt = 0;
      attempt < 100 && !clipboard.readHTML().includes(mermaidCaption);
      attempt++
    )
      await sleep(50)
    assert(clipboard.readHTML().includes('figcaption'))
    assert(clipboard.readHTML().includes(mermaidCaption))
    await js(
      'window.captionFixture.split(true); window.captionFixture.rightFocused(true); return true',
    )
    await wait(`window.captionFixture.state('secondary').editable`, 'Mermaid secondary view')
    await js(
      `const e=document.querySelector('[data-pane="secondary"] [role="textbox"]').editor; e.commands.focus('end'); return true`,
    )
    await wait(`document.activeElement?.closest('[data-pane="secondary"]')`, 'Mermaid paste focus')
    win.webContents.paste()
    await wait(
      `window.captionFixture.state('secondary').markdown.includes(${JSON.stringify(mermaidCaption)}) && window.captionFixture.state('secondary').markdown.includes('A[Gamma] --> B[Target]')`,
      'Mermaid native HTML paste',
    )
    assert(
      (await js<number>(
        `return window.captionFixture.state('secondary').json.content.filter(n=>n.type==='documentFigure').length`,
      )) >= 1,
      'Mermaid HTML paste must produce a captioned figure in the receiver',
    )
    mark('mermaid-html-clipboard-between-production-split-views')

    const mermaidIdentity = await js<number>('return window.captionFixture.state().identity')
    await js('window.captionFixture.hide(true); return true')
    await wait(`!window.captionFixture.state().editable`, 'hidden retained Mermaid view')
    assert.equal(await js('return window.captionFixture.state().identity'), mermaidIdentity)
    assert.equal(
      await js(`return document.querySelectorAll('[data-mermaid-diagram] svg').length`),
      1,
      'hidden retained Mermaid split must keep exactly its retained preview without duplicates',
    )
    await js(
      'window.captionFixture.hide(false); window.captionFixture.rightFocused(false); return true',
    )
    await wait('window.captionFixture.state().editable', 'unfocused retained Mermaid view')
    await wait(
      `document.querySelector('[data-pane="primary"] figure [data-mermaid-diagram] svg')`,
      'Mermaid preview after retained split returns',
    )
    assert.equal(
      await js(`return document.querySelectorAll('[data-mermaid-diagram] svg').length`),
      2,
      'unfocused retained split must render exactly one Mermaid SVG per production view',
    )
    assert.equal(
      await js(
        `return document.querySelectorAll('[data-pane="primary"] figure [data-mermaid-diagram] svg').length`,
      ),
      1,
    )
    assert.equal(
      await js(
        `return document.querySelectorAll('[data-pane="secondary"] figure [data-mermaid-diagram] svg').length`,
      ),
      1,
    )
    await js('window.captionFixture.rightFocused(true); return true')
    await wait(`window.captionFixture.state('secondary').editable`, 'focused Mermaid split')
    await js(
      'window.captionFixture.rightFocused(false); window.captionFixture.split(false); return true',
    )
    await wait(
      `document.querySelector('[data-pane="primary"] figure [data-mermaid-diagram] svg')`,
      'Mermaid preview after split closes',
    )
    assert.equal(
      await js(`return document.querySelectorAll('[data-mermaid-diagram] svg').length`),
      1,
      'closed split must not leave stale Mermaid SVGs',
    )
    assert.equal(await js(`return document.querySelectorAll('[data-radix-portal]').length`), 0)
    mark('mermaid-hidden-focused-unfocused-splits-cleanup')

    await js(
      'await window.captionFixture.flush(); await window.captionFixture.reopen(); return true',
    )
    await wait(
      `window.captionFixture.state().markdown.includes(${JSON.stringify(mermaidCaption)}) && window.captionFixture.state().markdown.includes('A[Gamma] --> B[Target]')`,
      'Mermaid production file reopen',
    )
    mermaidSaved = await readFile(note, 'utf8')
    assert(mermaidSaved.startsWith(head))
    assert(mermaidSaved.includes(editedMermaidFence))
    mark('mermaid-filesystem-reopen-preserves-frontmatter-and-fence')

    mermaidSaved = mermaidSaved.replace(mermaidCaption, 'A changed Mermaid caption')
    await writeFile(note, mermaidSaved)
    await js('window.captionFixture.reload(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes('A changed Mermaid caption')`,
      'Mermaid external caption change reload',
    )
    assert(
      (await readFile(note, 'utf8')).startsWith(head) &&
        (await readFile(note, 'utf8')).includes(editedMermaidFence),
    )
    await js(`window.captionFixture.select('documentFigure'); return true`)
    await wait(
      `window.captionFixture.state().selection.type==='node'`,
      'reloaded Mermaid figure selection',
    )
    const mermaidFigurePoint = await js<{ x: number; y: number }>(
      `const r=document.querySelector('[data-pane="primary"] figure').getBoundingClientRect(); return {x:r.x+12,y:r.y+12}`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...mermaidFigurePoint })
    await wait(
      `document.querySelector('[aria-label="Block actions"]')?.closest('[data-visible]')`,
      'reloaded Mermaid block actions',
    )
    await menu('Remove caption')
    assert.equal(
      await js(
        `return window.captionFixture.state().json.content.filter(n=>n.type==='documentFigure').length`,
      ),
      0,
    )
    assert(
      (await js<string>('return window.captionFixture.state().markdown')).includes(
        editedMermaidFence,
      ),
      'removing a Mermaid caption must retain the exact source fence',
    )
    await js(`window.captionFixture.select('codeBlock'); return true`)
    await menu('Add caption')
    await wait(`document.querySelector('figcaption')`, 'Mermaid caption re-add')
    await win.webContents.insertText(mermaidCaption)
    await js('await window.captionFixture.flush(); return true')
    await wait(
      `window.captionFixture.state().markdown.includes(${JSON.stringify(mermaidCaption)})`,
      'Mermaid re-added caption flush',
    )
    mermaidSaved = await readFile(note, 'utf8')
    assert(mermaidSaved.startsWith(head))
    assert(mermaidSaved.includes(editedMermaidFence))
    assert.equal(readMarkdownCodeCaptions(mermaidSaved).length, 1)
    mark('mermaid-reload-change-remove-and-readd-caption')

    await js('await window.captionFixture.flush(); return true')
    assert.equal(readMarkdownCodeCaptions(await readFile(note, 'utf8')).length, 1)
    assert((await readFile(note, 'utf8')).includes(mermaidCaption))
    await js(`window.captionFixture.theme('light'); return true`)
    await sleep(300)
    await capture('mermaid-light.png')
    await js(`window.captionFixture.theme('dark'); return true`)
    await sleep(300)
    await capture('mermaid-dark.png')
    await js(`window.captionFixture.theme('light'); return true`)
    const validDialog = await js(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Convert to PDF').click(); return true`,
    )
    assert(validDialog)
    const validProof = await convertAndInspectPdf({
      uiPdf: join(vault, 'notes/Code-caption 2.pdf'),
      cliOutput: 'notes/mermaid-cli.pdf',
      uiEvidence: 'mermaid-ui-valid.pdf',
      cliEvidence: 'mermaid-cli-valid.pdf',
      expected: { caption: mermaidCaption, source: 'Gamma' },
      warnings: 0,
    })
    const validUi = validProof.ui
    const validCli = validProof.cli
    mark('production-mermaid-renderer-caption-in-ui-and-cli-pdfs')

    const invalidSource = 'not a Mermaid diagram'
    const fallbackCaption = 'An edited fallback caption'
    await js(
      `await window.captionFixture.replace(${JSON.stringify(`${head}# Mermaid fallback\n\n~~~mermaid\n${invalidSource}\n~~~\n`)}); return true`,
    )
    await js(`window.captionFixture.select('codeBlock'); return true`)
    await menu('Add caption')
    await wait(`document.querySelector('figcaption')`, 'fallback caption authoring')
    await win.webContents.insertText(fallbackCaption)
    await js('await window.captionFixture.flush(); return true')
    assert((await readFile(note, 'utf8')).includes(fallbackCaption))
    await js(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Convert to PDF').click(); return true`,
    )
    const fallbackProof = await convertAndInspectPdf({
      uiPdf: join(vault, 'notes/Code-caption 3.pdf'),
      cliOutput: 'notes/mermaid-fallback-cli.pdf',
      uiEvidence: 'mermaid-ui-fallback.pdf',
      cliEvidence: 'mermaid-cli-fallback.pdf',
      expected: { caption: fallbackCaption, source: invalidSource },
      warnings: 1,
    })
    const fallbackUi = fallbackProof.ui
    const fallbackCli = fallbackProof.cli
    await writeFile(
      join(evidence, 'mermaid-pdf-proof.json'),
      JSON.stringify(
        { valid: { ui: validUi, cli: validCli }, fallback: { ui: fallbackUi, cli: fallbackCli } },
        null,
        2,
      ),
    )
    mark('mermaid-caption-source-fallback-in-ui-and-cli-pdfs')

    assert.deepEqual(denied, [])
    assert.deepEqual(await js('return window.captionFixture.errors'), [])
    assert.deepEqual(rendererErrors, [])
    ok = true
  } finally {
    await recording?.stop()
    if (
      !ok &&
      !win.isDestroyed() &&
      !win.webContents.isCrashed() &&
      win.webContents.debugger.isAttached()
    )
      await capture('failure.png').catch(() => {})
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          ok,
          scope,
          controllerValidated: false,
          source: {
            head: process.env.HOLI_535_SOURCE_HEAD,
            dirty: process.env.HOLI_535_SOURCE_DIRTY === 'true',
          },
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
    mermaid?.close()
    await bridge.stop()
    await endpoint.dispose()
    if (tablesOnly && ok) app.quit()
  }
  app.quit()
}
void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
