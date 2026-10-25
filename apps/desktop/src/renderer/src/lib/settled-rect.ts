/**
 * Where a tab is drawn, once it has finished drawing: `holi docs screenshot`'s
 * question to the renderer (main captures the rect it gets back).
 *
 * A pane's body carries the `data-tab` of the tab it shows (`panes-view.tsx`),
 * which for a file is its path. The
 * tab counts as drawn when that body is on screen, nothing inside it says
 * `aria-busy` (a vault app's frame does until its document has loaded), the
 * fonts are in and its arrival motion has run, and then a short settle more,
 * for whatever a view or an app draws after its first paint. Timers, never
 * `requestAnimationFrame`, which a hidden window never runs.
 *
 * A dialog, menu or popover open over the window (portaled to the body, out of
 * the app's root) would be in the capture, so it is waited out briefly and
 * then refused. One inside the tab, such as an app's approval question, is
 * what the person sees there and is captured.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** How long a view may take to draw before the screenshot is refused. */
const TIMEOUT_MS = 8_000
/** What a view draws after its first paint: an app's first bridge answers, a
 *  PDF's pages. */
const SETTLE_MS = 400
const POLL_MS = 50
/** How long an overlay over the window may stay open before the screenshot is
 *  refused: one closing has its exit motion to run. */
const OVERLAY_WAIT_MS = 1_500

/** What an overlay is: one of the roles Radix gives its dialogs, popovers,
 *  menus and lists, portaled out of the app's root. A tooltip is left out: one
 *  under a resting pointer never closes. */
const OVERLAY = ['dialog', 'alertdialog', 'menu', 'listbox']
  .map((role) => `body > :not(#root) [role="${role}"], body > [role="${role}"]`)
  .join(', ')

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The visible pane body showing `key`, or null. A kept-mounted surface's
 *  hidden tabs carry the key too, at no size. */
function bodyOf(key: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-tab="${CSS.escape(key)}"]`)
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

/** An overlay drawn over the window. */
const overlaid = (): boolean =>
  [...document.querySelectorAll<HTMLElement>(OVERLAY)].some((o) => {
    const r = o.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })

const busy = (el: HTMLElement): boolean =>
  el.getAttribute('aria-busy') === 'true' || el.querySelector('[aria-busy="true"]') !== null

/** The finite animations on `el` and inside it, finished. A spinner's
 *  infinite one would never end, so it is not waited for. */
async function motionDone(el: HTMLElement): Promise<void> {
  const finite = el
    .getAnimations({ subtree: true })
    .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
  await Promise.all(finite.map((a) => a.finished.catch(() => {})))
}

export async function settledRect(key: string): Promise<Rect> {
  const deadline = Date.now() + TIMEOUT_MS
  let overlaySince: number | null = null
  while (Date.now() < deadline) {
    const el = bodyOf(key)
    if (el !== null && overlaid()) {
      overlaySince ??= Date.now()
      if (Date.now() - overlaySince > OVERLAY_WAIT_MS) {
        throw new Error('a dialog or menu is open over Holi; close it and try again')
      }
    } else if (el !== null && !busy(el)) {
      overlaySince = null
      // Bounded: a page the compositor is not drawing advances no animation.
      await Promise.race([Promise.all([document.fonts.ready, motionDone(el)]), wait(1_000)])
      await wait(SETTLE_MS)
      // Still the one on screen, and still drawn: a reload or a tab switch
      // during the settle starts the wait over.
      if (bodyOf(key) === el && !busy(el) && !overlaid()) {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
    }
    await wait(POLL_MS)
  }
  throw new Error('the tab did not finish drawing in time')
}
