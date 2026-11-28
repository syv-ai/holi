import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, nativeTheme, screen, session } from 'electron'
import { applyLiquidGlass, wantsLiquidGlass } from '../src/main/liquid-glass'

const root = process.env.HOLI_WINDOW_EFFECTS_ROOT!
assert(root && process.platform === 'darwin')
const mode = process.argv.includes('--opaque') ? 'opaque' : 'native'
app.setName('Holi window-effects fixture')
for (const [name, dir] of [
  ['userData', 'userData'],
  ['sessionData', 'sessionData'],
  ['appData', 'app-data'],
] as const)
  app.setPath(name, join(root, dir))
const entry = pathToFileURL(join(root, 'renderer/index.html')).href
const note =
  '# Window effects measurement\n\n' +
  Array.from(
    { length: 80 },
    (_, i) =>
      `## Passage ${i + 1}\n\nSynthetic **markdown** content with a [local link](#heading), readable paragraphs and enough material to scroll.\n`,
  ).join('\n')
const notes = new Map([
  ['notes/acceptance.md', note],
  ['notes/secondary.md', note],
])
const emit = (value: unknown) => console.log(JSON.stringify(value))

async function main() {
  await app.whenReady()
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      allowed =
        new URL(details.url).protocol === 'file:' &&
        resolve(fileURLToPath(details.url)).startsWith(join(root, 'renderer') + sep)
    } catch {
      /* Non-file destinations remain denied. */
    }
    callback({ cancel: !allowed })
  })
  ipcMain.handle('rich-text-vim:read', (event, path: string) => {
    assert.equal(event.senderFrame?.url, entry)
    assert(notes.has(path))
    return notes.get(path)
  })
  ipcMain.handle('rich-text-vim:write', (event, path: string, text: string) => {
    assert.equal(event.senderFrame?.url, entry)
    assert(notes.has(path) && typeof text === 'string' && text.length < 1024 * 1024)
    notes.set(path, text)
  })
  ipcMain.handle('rich-text-vim:comments', (event, operation: string) => {
    assert.equal(event.senderFrame?.url, entry)
    if (operation === 'list') return []
    if (operation === 'read') return '{"version":1,"threads":{}}'
    throw new Error('Fixture comments operation denied')
  })
  let viewId: number | null = null
  let fallback = false
  const liquid = mode === 'native' && wantsLiquidGlass()
  if (liquid) {
    const glass = require('electron-liquid-glass')
    const original = glass.addView.bind(glass)
    glass.addView = (...args: unknown[]) => {
      viewId = original(...args)
      return viewId
    }
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: mode === 'native' ? '#00000000' : '#f8f8f8',
    ...(mode === 'opaque'
      ? { transparent: false }
      : liquid
        ? { transparent: true }
        : ({ vibrancy: 'under-window', visualEffectState: 'active' } as const)),
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  const vibrancy = win.setVibrancy.bind(win)
  win.setVibrancy = (...args: Parameters<typeof win.setVibrancy>) => {
    fallback = true
    return vibrancy(...args)
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  if (liquid) applyLiquidGlass(win)
  await win.loadFile(join(root, 'renderer/index.html'))
  const evaluate = <T>(source: string) => win.webContents.executeJavaScript(source) as Promise<T>
  const deadline = Date.now() + 30000
  while (
    !(await evaluate<boolean>(
      "!!document.querySelector('[contenteditable=true]') && !!window.richTextVimFixture",
    ))
  ) {
    if (Date.now() > deadline) throw new Error('Production editor did not mount')
    await new Promise((r) => setTimeout(r, 100))
  }
  await evaluate(
    `document.documentElement.dataset.theme='light';document.documentElement.classList.remove('dark');document.documentElement.dataset.glass=${JSON.stringify(mode === 'opaque' ? 'solid' : 'frosted')};${mode === 'opaque' ? "document.documentElement.style.background='var(--background)';document.body.style.background='var(--background)';" : ''}window.richTextVimFixture.mode(false);window.richTextVimFixture.focus('primary')`,
  )
  win.center()
  win.show()
  app.focus({ steal: true })
  win.focus()
  const effect =
    mode === 'opaque'
      ? 'opaque'
      : liquid && viewId !== null && viewId >= 0 && !fallback
        ? 'liquid-glass'
        : 'vibrancy-fallback'
  assert(!liquid || (viewId !== null && viewId >= 0) || fallback, 'Native glass did not attach')
  const state = async () => ({
    mode,
    effect,
    viewId,
    fallback,
    pid: process.pid,
    processes: app.getAppMetrics().map(({ pid, type }) => ({ pid, type })),
    focused: win.isFocused(),
    visible: win.isVisible(),
    bounds: win.getBounds(),
    zoom: win.webContents.getZoomFactor(),
    display: {
      id: screen.getDisplayMatching(win.getBounds()).id,
      scaleFactor: screen.getDisplayMatching(win.getBounds()).scaleFactor,
    },
    editor: await evaluate(
      "({readable:document.body.innerText.includes('Window effects measurement'),editable:!!document.querySelector('[contenteditable=true]'),selection:window.richTextVimFixture.state().selection,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,reducedTransparency:matchMedia('(prefers-reduced-transparency: reduce)').matches})",
    ),
    highContrast: nativeTheme.shouldUseHighContrastColors,
  })
  emit({ event: 'ready', electron: process.versions.electron, state: await state() })
  const input = createInterface({ input: process.stdin })
  let pending = Promise.resolve()
  input.on('line', (line) => {
    pending = pending
      .then(async () => {
        const { id, command, value } = JSON.parse(line)
        try {
          let result: unknown
          if (command === 'state') result = await state()
          else if (command === 'activity') {
            await evaluate(
              `for(const el of document.querySelectorAll('*'))if(el.scrollHeight>el.clientHeight+100)el.scrollTop=${Number(value) % 2 ? 400 : 0}`,
            )
            win.setSize(Number(value) % 2 ? 1180 : 1200, Number(value) % 2 ? 780 : 800)
            result = true
          } else if (command === 'restore') {
            win.setSize(1200, 800)
            result = true
          } else if (command === 'capture') {
            assert(value === 'light' || value === 'dark')
            await evaluate(
              `document.documentElement.classList.toggle('dark',${value === 'dark'});document.documentElement.dataset.theme=${JSON.stringify(value)}`,
            )
            await new Promise((r) => setTimeout(r, 300))
            await writeFile(
              join(root, `${value}.png`),
              (await win.webContents.capturePage()).toPNG(),
            )
            result = await state()
          } else if (command === 'quit') {
            emit({ id, result: true })
            input.close()
            win.destroy()
            app.quit()
            return
          } else throw new Error('Fixture control denied')
          emit({ id, result })
        } catch (error) {
          emit({ id, error: String(error) })
        }
      })
      .catch((error) => {
        emit({ event: 'error', error: String(error) })
        app.exit(1)
      })
  })
  input.on('close', () => app.quit())
}
void main().catch((error) => {
  emit({ event: 'error', error: String(error) })
  app.exit(1)
})
