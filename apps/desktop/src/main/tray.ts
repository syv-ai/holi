/**
 * The tray: what keeps Holi reachable once the window is closed, while a
 * plugin works in the background (reminders) and so closing the last window
 * does not quit. It is the way back in (**Open Holi**) and the real exit
 * (**Quit**), and its tooltip says why Holi is still running.
 *
 * The icon is an opaque, Retina-sized asset: its frosted tile stays visible
 * instead of being tinted as a macOS template image. The same asset is included
 * explicitly in electron-builder's packaged files.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

const ICON_PATH = 'assets/menu-bar-icon.png'

export function createTray(deps: { openWindow: () => void; tooltip: string }): Tray {
  const icon = nativeImage.createFromBuffer(readFileSync(join(app.getAppPath(), ICON_PATH)), {
    scaleFactor: 2,
  })
  if (process.platform === 'darwin') icon.setTemplateImage(false)

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
