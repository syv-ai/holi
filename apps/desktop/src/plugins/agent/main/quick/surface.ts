/**
 * The quick panel's window: a page of the agent's (`renderer/quick/`) in a
 * window core makes (`AppContext.openPage`), set up the way a launcher's is.
 * One for every quick agent (`panels.ts`).
 *
 * - **A panel, not a window** (`type: 'panel'`): macOS gives it the keyboard
 *   without making Holi the active app, so the main window stays where it is
 *   and the app the person was in is still theirs when the panel lets go.
 * - **Above everything, on every Space**, over a full-screen app too.
 * - **The HUD material** (`vibrancy: 'hud'`), live even while it does not have
 *   the keyboard: the blur the page draws on. macOS draws it light in light
 *   mode, so the page tints it dark itself (`quick.css`).
 * - **Clear until painted** (`revealWhenPainted`): one window shows every
 *   prompt and agent, and shown again it would first show its last frame.
 *
 * Only Electron's window, which core hands over, is touched here: nothing
 * imports `electron`, so the plugin stays importable under plain Node.
 */
import type { AppContext, PageWindow, PageWindowOptions } from '../../../../main/plugin-api'
import { parseQuickRequest, type QuickRequest } from '../../shared/quick'
import { PROMPT_SIZE, type PanelSurface } from './panels'

/** What the panel's window and the dock's share: a frameless macOS panel, clear
 *  for its page to paint on, kept out of the Dock and the window switcher. */
export const FLOATING: PageWindowOptions['window'] = {
  show: false,
  type: 'panel',
  frame: false,
  transparent: true,
  hasShadow: true,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  acceptFirstMouse: true,
  backgroundColor: '#00000000',
}

/** Above everything, on every Space and over a full-screen app, and out of
 *  Mission Control. */
export function floatAbove(win: PageWindow['window']): void {
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setHiddenInMissionControl(true)
}

/** The longest a window waits clear for its page to say it has painted. */
const REVEAL_WAIT_MS = 150

/**
 * Out of sight a page paints nothing, so a window shown again would first show
 * its last frame: the prompt or the agent it showed before, for a moment.
 * Shown, it starts clear and asks its page to say when it has painted
 * (`paint`, answered with `painted`), and turns opaque then, or after
 * `REVEAL_WAIT_MS` whatever happens. Main keeps the keyboard where it gave it:
 * typing into a clear prompt lands.
 */
export function revealWhenPainted(page: PageWindow): {
  /** Call just before the window is shown. */
  showing(): void
  painted(): void
} {
  const win = page.window
  let wait: ReturnType<typeof setTimeout> | null = null
  const opaque = (): void => {
    if (wait !== null) clearTimeout(wait)
    wait = null
    if (!win.isDestroyed()) win.setOpacity(1)
  }
  return {
    showing() {
      if (win.isVisible()) return
      win.setOpacity(0)
      if (wait !== null) clearTimeout(wait)
      wait = setTimeout(opaque, REVEAL_WAIT_MS)
      page.send('paint', null)
    },
    painted: opaque,
  }
}

export function electronSurface(ctx: AppContext): PanelSurface {
  const page = ctx.openPage({
    page: 'quick',
    window: {
      ...FLOATING,
      ...PROMPT_SIZE,
      vibrancy: 'hud',
      visualEffectState: 'active',
      roundedCorners: true,
    },
  })
  const win = page.window
  /** The page's one listener. */
  let onRequest: (request: QuickRequest) => void = () => {}
  const reveal = revealWhenPainted(page)
  page.on('quick', (raw) => {
    const request = parseQuickRequest(raw)
    if (request?.kind === 'painted') reveal.painted()
    else if (request !== null) onRequest(request)
  })
  /**
   * Whether the page has the keyboard, told by main rather than read from the
   * page's own focus events: a panel never makes Holi the active app, and
   * Chromium does not always hear it give the keyboard back. `user` is a
   * person clicking elsewhere, as against Holi handing the keyboard back;
   * only the first puts an agent's panel away (`onUserBlur`).
   */
  let quietUntil = 0
  let onUserBlur: () => void = () => {}
  const tellFocus = (focused: boolean, user: boolean): void =>
    page.send('quick-focus', { focused, user })
  /** Holi moves the keyboard itself: the blur that follows is not a person's. */
  const quietly = (): void => {
    quietUntil = Date.now() + 400
  }
  win.on('focus', () => {
    // Shown again: the next blur is a new one, whoever causes it, not the
    // one the last hide caused.
    quietUntil = 0
    tellFocus(true, false)
  })
  win.on('blur', () => {
    const user = Date.now() > quietUntil
    tellFocus(false, user)
    if (user) onUserBlur()
  })
  floatAbove(win)

  return {
    view: (view) => page.send('quick-view', view),
    sink: (name, payload) => page.send(name, payload),
    onRequest(cb) {
      onRequest = cb
    },
    onUserBlur(cb) {
      onUserBlur = cb
    },
    onClosed: (cb) => void win.on('closed', cb),
    bounds: () => win.getBounds(),
    place: (bounds) => win.setBounds(bounds),
    show(focus) {
      reveal.showing()
      if (!focus) {
        win.showInactive()
        return
      }
      win.show()
      win.focus()
      tellFocus(true, false)
    },
    hide() {
      quietly()
      win.hide()
      tellFocus(false, false)
    },
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    isFocused: () => !win.isDestroyed() && win.isFocused(),
    close() {
      if (!win.isDestroyed()) win.destroy()
    },
  }
}
