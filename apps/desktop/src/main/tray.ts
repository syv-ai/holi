/**
 * The tray — what keeps Holi reachable once the window is closed. Keep-alive
 * (the app no longer quits on last-window-closed) only makes sense paired with a
 * way back in and a way out, and that is the tray's whole job: **Open Holi**
 * (create-or-focus the one window) and **Quit** (the real exit, since ⌘W no
 * longer is one).
 *
 * The icon is inlined as a data URL rather than shipped as a build asset — the
 * app has no icon asset yet, and a data URL resolves identically in `electron-vite
 * dev` and a packaged build with no `resources` wiring. It is alpha-only, so
 * `setTemplateImage` lets macOS tint it to the menu bar in light and dark.
 */
import { app, Menu, nativeImage, Tray } from 'electron'

// 16×16 black 'H' glyph on transparent — a template image (alpha-driven).
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAL0lEQVR4nGNgGPKAEY3/n1Q5JkpdwDTgBrDgkfs/4C5gJMZFTJS6gGnADWAY+gAAWG4EF2cqAhQAAAAASUVORK5CYII='

export function createTray(deps: { openWindow: () => void }): Tray {
  const icon = nativeImage.createFromDataURL(ICON_DATA_URL)
  if (process.platform === 'darwin') icon.setTemplateImage(true)

  const tray = new Tray(icon)
  tray.setToolTip('Holi')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Holi', click: () => deps.openWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  return tray
}
