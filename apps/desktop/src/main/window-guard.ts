/**
 * The window navigates to the app, or it does not navigate.
 *
 * Electron's default is to let the page go anywhere, and a **file drop is a
 * navigation**: any drop the renderer does not claim with `preventDefault()`
 * makes Chromium load the dropped file, which Electron shows in a window. That
 * is how a PDF dropped on the file tree became a blank "Holi desktop" window
 * (afa30b3 fixed that drop; this is the backstop for every drop surface that
 * has not been audited — the editor, the board, the mail reader).
 *
 * Holi is a single page. It never navigates on purpose: external links go
 * through `shell.openExternal` over IPC, and nothing in the renderer calls
 * `window.open`. So the rule can be as tight as "the document we loaded".
 */
import type { BrowserWindow } from 'electron'

/**
 * May the window navigate from the document at `loaded` to `next`?
 *
 * `file:` is compared by **path**, not by origin: in a packaged build the app
 * and a dropped file are both `file://` and every `file:` URL has the same
 * (opaque) origin, so an origin test — the usual Electron recipe — would wave
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
 * Refuse every navigation away from `loaded`, and every attempt to open a
 * second window.
 *
 * Top-level only, deliberately: `will-navigate` does not fire for subframes, so
 * a vault app inside its `holi-app://` frame keeps navigating itself. Denying
 * `setWindowOpenHandler` costs nothing today — nothing calls `window.open` —
 * and means a drop can never spawn a window even if it dodges the check above.
 */
export function guardNavigation(win: BrowserWindow, loaded: string): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(loaded, url)) return
    event.preventDefault()
  })
}
