/**
 * The tray: what keeps Holi reachable once the window is closed, while a
 * plugin works in the background (reminders) and so closing the last window
 * does not quit. It is the way back in (**Open Holi**) and the real exit
 * (**Quit**), and its tooltip says why Holi is still running.
 *
 * The icon is the app icon's tile, the "h" on its grey squircle as Cmd+Tab
 * shows it, so the menu bar and the dock read as one app. It is
 * `build/icon.svg` rasterised once without its drop shadow: the tile at 16 pt,
 * centred in an 18 pt transparent canvas, at 18 and 36 px (@1x and @2x).
 * Regenerate both from `apps/desktop` with
 * `pnpm exec electron scripts/tray-icon.mjs`. They are read in with `?inline`, so it
 * resolves identically in `electron-vite dev` and a packaged build with no
 * `resources` wiring. It is in colour, so it is not a template image: macOS
 * would flatten it to a monochrome silhouette. The tile carries its own
 * background, which keeps the "h" legible on a light or a dark menu bar.
 * It is the default dark drawing, not the vault's themed dock icon.
 */
import { app, Menu, nativeImage, Tray } from 'electron'
import icon18 from './tray-icon-18.png?inline'
import icon36 from './tray-icon-36.png?inline'

export function createTray(deps: { openWindow: () => void; tooltip: string }): Tray {
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({ scaleFactor: 1, dataURL: icon18 })
  icon.addRepresentation({ scaleFactor: 2, dataURL: icon36 })

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
