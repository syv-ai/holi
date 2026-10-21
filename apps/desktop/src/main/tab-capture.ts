/**
 * `holi docs screenshot`'s Electron half: a PNG of one tab, as the person
 * sees it, cut from the window.
 *
 * The tab is already asked for (`vault:open`); this asks the renderer where it is
 * drawn (`vault:locate`, answered on `vault:located` by the request's id, once
 * the tab has settled: `lib/settled-rect.ts`) and captures that rect of the
 * page. A vault app is an iframe in the same page, so it is in the capture.
 * `capturePage` draws a page its window hides, but the caller shows the window
 * first anyway, since a hidden page runs no animation and its tab never settles.
 */
import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { CapabilityError } from './capabilities/error'

/** The renderer's own wait is shorter (`settledRect`), so a slow view is
 *  refused with its reason rather than this one. */
const LOCATE_TIMEOUT_MS = 12_000

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const isRect = (r: unknown): r is Rect =>
  typeof r === 'object' &&
  r !== null &&
  ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]))

/** Where `path`'s tab is drawn in `win`, in CSS pixels. */
function locate(win: BrowserWindow, path: string): Promise<Rect> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener('vault:located', onAnswer)
    }
    const onAnswer = (event: IpcMainEvent, answer: unknown): void => {
      if (event.sender !== win.webContents) return
      const a = answer as { id?: unknown; rect?: unknown; error?: unknown } | null
      if (a === null || typeof a !== 'object' || a.id !== id) return
      done()
      if (isRect(a.rect)) resolve(a.rect)
      else reject(new CapabilityError('UNAVAILABLE', String(a.error ?? 'no such tab')))
    }
    const timer = setTimeout(() => {
      done()
      reject(new CapabilityError('UNAVAILABLE', 'Holi did not answer in time'))
    }, LOCATE_TIMEOUT_MS)
    ipcMain.on('vault:located', onAnswer)
    win.webContents.send('vault:locate', { id, path })
  })
}

/** A PNG of `path`'s tab in `win`, which has just been asked to open it.
 *  `ready` settles once `win`'s renderer has taken that open: a window made
 *  just now has no renderer listening yet, and main holds an open until the
 *  renderer has landed its vault. Bounded: a load that fails never lands, and
 *  the ask then times out as unanswered. */
export async function captureTab(
  win: BrowserWindow,
  path: string,
  ready: Promise<void>,
): Promise<Uint8Array> {
  const contents = win.webContents
  let timer: NodeJS.Timeout | undefined
  await Promise.race([ready, new Promise<void>((r) => (timer = setTimeout(r, LOCATE_TIMEOUT_MS)))])
  clearTimeout(timer)
  const rect = await locate(win, path)
  // CSS pixels to the window's own: the same unless the page is zoomed.
  const zoom = contents.getZoomFactor()
  const image = await contents.capturePage({
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.round(rect.width * zoom),
    height: Math.round(rect.height * zoom),
  })
  if (image.isEmpty()) throw new CapabilityError('UNAVAILABLE', 'Holi drew nothing to capture')
  return image.toPNG()
}
