/**
 * Mermaid in a hidden window: how a PDF gets its diagrams. **The only file in
 * `pdf/` that imports Electron**, loaded on the first note that has one.
 *
 * Mermaid lays text out with the DOM, so main draws in a `BrowserWindow` that
 * is never shown. It loads mermaid's own bundle from the app's dependencies,
 * never a CDN; it is sandboxed, has no preload and no Node, cannot navigate or
 * open windows, and every request it makes is cancelled, so a diagram from a
 * collaborator or the agent can only draw. Mermaid keeps its strict security
 * level, as in the editor.
 *
 * One window, reused while PDFs are being made and closed after a minute
 * idle; the plugin closes it when it stops. Diagrams draw one at a time, and
 * one that hangs closes the window and comes back as an error, so the next
 * starts clean.
 *
 * PDFs are always light: mermaid's `default` theme. Labels are SVG text, not
 * HTML in a `foreignObject`, which Typst's SVG reader does not draw.
 */
import { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Diagram, DrawDiagrams } from './mermaid'

/** How long the window stays open after its last diagram. */
const IDLE_MS = 60_000
/** How long one diagram may take. */
const DIAGRAM_MS = 15_000

const CONFIG = {
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
}

export interface MermaidWindow {
  draw: DrawDiagrams
  close(): void
}

export function createMermaidWindow(): MermaidWindow {
  let win: BrowserWindow | null = null
  let opening: Promise<BrowserWindow> | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let seq = 0

  const close = (): void => {
    if (idle !== null) clearTimeout(idle)
    idle = null
    opening = null
    const w = win
    win = null
    if (w !== null && !w.isDestroyed()) w.destroy()
  }

  const open = (): Promise<BrowserWindow> => {
    if (win !== null && !win.isDestroyed()) return Promise.resolve(win)
    opening ??= (async () => {
      const w = new BrowserWindow({
        show: false,
        width: 1200,
        height: 900,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // An in-memory session of its own: nothing it does reaches the app's.
          partition: 'holi-mermaid',
          // A hidden window's timers are throttled by default; mermaid's
          // layout waits on some.
          backgroundThrottling: false,
          spellcheck: false,
        },
      })
      w.webContents.session.webRequest.onBeforeRequest((details, answer) => {
        answer({ cancel: !details.url.startsWith('about:') })
      })
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      w.webContents.on('will-navigate', (event) => event.preventDefault())
      w.webContents.on('render-process-gone', () => {
        if (win === w) close()
      })
      try {
        await w.loadURL('about:blank')
        const bundle = createRequire(__filename).resolve('mermaid/dist/mermaid.min.js')
        await w.webContents.executeJavaScript(`${await readFile(bundle, 'utf8')}\n;0`)
        await w.webContents.executeJavaScript(`mermaid.initialize(${JSON.stringify(CONFIG)}); 0`)
      } catch (err) {
        w.destroy()
        opening = null
        throw err
      }
      win = w
      return w
    })()
    return opening
  }

  const drawOne = async (w: BrowserWindow, source: string): Promise<Diagram> => {
    const id = `holi-mermaid-${++seq}`
    const script =
      `mermaid.render(${JSON.stringify(id)}, ${JSON.stringify(source)})` +
      `.then((r) => ({ svg: r.svg }), (e) => ({ error: String((e && e.message) || e) }))`
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Diagram>((resolve) => {
      timer = setTimeout(() => {
        close()
        resolve({ error: 'mermaid took too long to draw it' })
      }, DIAGRAM_MS)
    })
    try {
      return await Promise.race([
        w.webContents.executeJavaScript(script) as Promise<Diagram>,
        timeout,
      ])
    } catch (err) {
      return { error: (err as Error).message }
    } finally {
      clearTimeout(timer)
    }
  }

  const drawAll = async (sources: string[]): Promise<Diagram[]> => {
    if (idle !== null) clearTimeout(idle)
    const out: Diagram[] = []
    try {
      for (const source of sources) {
        let w: BrowserWindow
        try {
          w = await open()
        } catch (err) {
          out.push({ error: `mermaid could not start: ${(err as Error).message}` })
          continue
        }
        out.push(await drawOne(w, source))
      }
    } finally {
      idle = setTimeout(close, IDLE_MS)
    }
    return out
  }

  return {
    // One PDF's diagrams at a time, in the order they were asked for.
    draw: (sources) => {
      const run = queue.then(() => drawAll(sources))
      queue = run.catch(() => undefined)
      return run
    },
    close,
  }
}
