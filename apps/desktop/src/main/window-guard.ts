/**
 * The window navigates to the app, or it does not navigate.
 *
 * Electron's default is to let the page go anywhere, and a **file drop is a
 * navigation**: any drop the renderer does not claim with `preventDefault()`
 * makes Chromium load the dropped file, which Electron shows in a window. This
 * is the backstop for every drop surface that does not claim its drops.
 *
 * Holi is a single page. It never navigates on purpose: external links go
 * through `shell.openExternal` over IPC, and nothing in the renderer calls
 * `window.open`. So the rule can be as tight as "the document we loaded".
 * A vault app's links are the one kind of link Holi did not write, and they
 * go to the browser too (`guardNavigation`).
 */
import type { BrowserWindow } from 'electron'

/**
 * May the window navigate from the document at `loaded` to `next`?
 *
 * `file:` is compared by **path**, not by origin: in a packaged build the app
 * and a dropped file are both `file://` and every `file:` URL has the same
 * (opaque) origin, so an origin test (the usual Electron recipe) would wave
 * the dropped file straight through. `http(s):` is compared by origin, because
 * the dev server reloads itself to `/`, `/index.html` and `/?t=…` and all three
 * are the app.
 *
 * Anything unparseable is refused. A guard that throws inside an Electron event
 * handler fails **open**, which is the one outcome worth engineering against.
 */
export function isAllowedNavigation(loaded: string, next: string): boolean {
  let from: URL
  let to: URL
  try {
    from = new URL(loaded)
    to = new URL(next)
  } catch {
    return false
  }
  if (from.protocol === 'file:') return to.protocol === 'file:' && to.pathname === from.pathname
  return to.origin === from.origin
}

/**
 * A URL Holi hands to the system (the default browser, the mail client), or
 * null. Only these schemes: anything else a page asks to open stays unopened.
 */
export function externalUrl(url: string): string | null {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? url : null
  } catch {
    return null
  }
}

const schemeOf = (url: string): string => url.slice(0, Math.max(0, url.indexOf(':')))

/**
 * Where a frame on one of `frameSchemes` (a vault app's `holi-app:`) is
 * trying to go, when that is out of it: a link in an app is a link the person
 * meant to follow, so it opens in their browser rather than replacing the app
 * inside its tab. Null for a navigation within the frame's own scheme, or of a
 * frame on no such scheme.
 */
export function appFrameExit(
  frameUrl: string,
  next: string,
  frameSchemes: ReadonlySet<string>,
): { open: string | null } | null {
  const scheme = schemeOf(frameUrl)
  if (!frameSchemes.has(scheme) || schemeOf(next) === scheme) return null
  return { open: externalUrl(next) }
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The same for a frame showing one of `frameOrigins`, a community plugin's
 * local server (`http://127.0.0.1:3040`): it may move within that origin, and
 * a link out of it opens in the browser. Null for a frame on no such origin,
 * including one still loading its first page.
 */
export function originFrameExit(
  frameUrl: string,
  next: string,
  frameOrigins: ReadonlySet<string>,
): { open: string | null } | null {
  const origin = originOf(frameUrl)
  if (origin === null || !frameOrigins.has(origin) || originOf(next) === origin) return null
  return { open: externalUrl(next) }
}

/**
 * Refuse every navigation away from `loaded`, and every second window.
 *
 * `will-navigate` does not fire for subframes, so a vault app's frame is
 * watched on its own (`will-frame-navigate`): it may move within its own
 * bundle, and a link out of it opens in the browser instead; so is a frame on
 * one of `frameOrigins`, which is live: plugins add and remove origins as their
 * servers start and stop. A new window is
 * never made; an http(s) or mailto one (an app's `target=_blank` link, which
 * its sandbox's `allow-popups` lets reach here) opens in the browser. The
 * renderer itself never calls `window.open`.
 */
export function guardNavigation(
  win: BrowserWindow,
  loaded: string,
  openExternal: (url: string) => void,
  frameSchemes: ReadonlySet<string>,
  frameOrigins: ReadonlySet<string> = new Set(),
): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external !== null) openExternal(external)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(loaded, url)) return
    event.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    const from = event.frame?.url ?? ''
    const exit =
      appFrameExit(from, event.url, frameSchemes) ?? originFrameExit(from, event.url, frameOrigins)
    if (exit === null) return
    event.preventDefault()
    if (exit.open !== null) openExternal(exit.open)
  })
}
