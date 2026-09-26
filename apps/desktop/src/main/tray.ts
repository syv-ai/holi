/**
 * The tray: what keeps Holi reachable once the window is closed. The app does
 * not quit on last-window-closed, so the tray is the way back in (**Open Holi**)
 * and the real exit (**Quit**).
 *
 * The icon is a data URL rather than a build asset, so it resolves identically
 * in `electron-vite dev` and a packaged build with no `resources` wiring. It is
 * alpha-only, so `setTemplateImage` lets macOS tint it for light and dark.
 */
import { app, Menu, nativeImage, Tray } from 'electron'

// 16×16 black 'H' glyph on transparent: a template image (alpha-driven).
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
