/**
 * The quick agents' dock (docs/features/quick-agent.md): one slim window at
 * the right edge of a display, a dot for each quick agent in its light's
 * colour, drawn by the agent's page `dock` (`renderer/quick/`).
 *
 * Set up like a quick panel's window (`surface.ts`): a macOS panel above
 * everything on every Space. Unlike a panel it never takes the keyboard
 * (`focusable: false`), so pointing at or clicking a dot leaves the keyboard
 * where it was: in the app the person is in, or in the agent's panel the dock
 * key opened. And it is not on the HUD material: macOS clips a window's glass
 * to its own corner radius, which never makes a window this narrow a pill, so
 * the window is clear and the page draws the pill, dark like the panels'
 * glass, its shadow following the pill's shape.
 *
 * Only Electron's window, which core hands over, is touched here: nothing
 * imports `electron`, so the plugin stays importable under plain Node.
 */
import type { AppContext } from '../../../../main/plugin-api'
import { parseDockRequest, type DockRequest, type DockView } from '../../shared/quick'
import type { Rect } from './placement'

/** The dock's window, as the panels drive it (`panels.ts`). */
export interface DockSurface {
  /** Tell its page what to show. */
  view(view: DockView): void
  /** Hear its page. A second call replaces the first. */
  onRequest(cb: (request: DockRequest) => void): void
  onClosed(cb: () => void): void
  bounds(): Rect
  place(bounds: Rect): void
  /** Show it, never taking the keyboard. */
  show(): void
  hide(): void
  isVisible(): boolean
  close(): void
}

export function electronDock(ctx: AppContext): DockSurface {
  const page = ctx.openPage({
    page: 'dock',
    window: {
      width: 28,
      height: 28,
      show: false,
      type: 'panel',
      focusable: false,
      frame: false,
      transparent: true,
      roundedCorners: false,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
    },
  })
  const win = page.window
  let onRequest: (request: DockRequest) => void = () => {}
  page.on('dock', (raw) => {
    const request = parseDockRequest(raw)
    if (request !== null) onRequest(request)
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setHiddenInMissionControl(true)

  return {
    view: (view) => page.send('dock-view', view),
    onRequest(cb) {
      onRequest = cb
    },
    onClosed: (cb) => void win.on('closed', cb),
    bounds: () => win.getBounds(),
    place: (bounds) => win.setBounds(bounds),
    show: () => win.showInactive(),
    hide: () => win.hide(),
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    close() {
      if (!win.isDestroyed()) win.destroy()
    },
  }
}
