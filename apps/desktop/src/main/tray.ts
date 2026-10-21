/**
 * The tray: what keeps Holi reachable once the window is closed, while a
 * plugin works in the background (reminders) and so closing the last window
 * does not quit. It is the way back in (**Open Holi**) and the real exit
 * (**Quit**), and its tooltip says why Holi is still running.
 *
 * The icon is a data URL rather than a build asset, so it resolves identically
 * in `electron-vite dev` and a packaged build with no `resources` wiring. It is
 * alpha-only, so `setTemplateImage` lets macOS tint it for light and dark.
 */
import { app, Menu, nativeImage, Tray } from 'electron'

// 16×16 black 'H' glyph on transparent: a template image (alpha-driven).
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAL0lEQVR4nGNgGPKAEY3/n1Q5JkpdwDTgBrDgkfs/4C5gJMZFTJS6gGnADWAY+gAAWG4EF2cqAhQAAAAASUVORK5CYII='

export function createTray(deps: { openWindow: () => void; tooltip: string }): Tray {
  const icon = nativeImage.createFromDataURL(ICON_DATA_URL)
  if (process.platform === 'darwin') icon.setTemplateImage(true)

  const tray = new Tray(icon)
  tray.setToolTip(deps.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Holi', click: () => deps.openWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  return tray
}
