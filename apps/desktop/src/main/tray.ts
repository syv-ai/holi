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

// The HOLI wordmark (logo.svg), black on transparent at 36×36 px: 18 pt at
// @2x, a menu bar icon's height. Alpha-only, so it is a template image.
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAACXBIWXMAACxLAAAsSwGlPZapAAACdUlEQVR4nO2XS4jOURjGf6Fm2FlQNqJB5JKMO9HknixkSCTZiLGRxdi4TWTcb7k0C0pDw4RJojRpKKymJDbEUllQLrkVRqfeqbczz3e+802T1ffUu/j+z/O8/+d/Oe//fFBGGWX8PywCNrva5LjjQJOr7Y4bC6yOqqLIuZYDV4HbQD1QqURtQFdUlcb9jI53Ot9F4ZuaCLNA6E8q4a1EoO/R8afOd0n4ZiYCnRH610p4UwhnANXiDj1yvsvCNyUR6KzQv1HCG0LYVaDane+K4CckAq3LfWSlBLrrfC2CH5MI1A/YA7wE3gEXgIFK2FpCoDvOd13wI+kDlBLonvNdE3xV4jxV0QgJtUoJ4yv9AowABgM/Eu9Qc4mPbJnQn8i5Q58cFy/7jiLLflwi0GKhb1DClkSgbxH32HFN4gTzE4EWCv1uJZwN7HS11nF1wCFXtY47l/HO/QFWmr5G8HspggqbtrXAenvuQwtoT2cuhO4LnCe4fYWCDLIP6Vdh+mvzJ15BxzIDrTH93Nx3qNK+UcUafwBGOV9jZqCwCwiYJbj9KlB9LwfjgUxP96yZLrjQoweeCWGr3YHP0fHfNp8CNgBvM2qO6avFeQ6qQPGseeG4BtEkrMreYLLo1ZgT6L7jdogmYZ5gt7vT6olN8bja3GKYJHodVoFeRaKw0mpsK/FcNJlovoeZ71CY0AHjBXckdyfXVaDeA/3N15HpWer24DEXRkcPDAc+Zjbf5nwPMj1LTD9acGH2SUyzFVGo6S9gV+RpL/GRVQnuFAkMAFYAR+2vSlj654EtwDCh32qaYhW2MgFD7HezfZjDnnxjKlAZZZRBH+Ifr5TdObsk0tgAAAAASUVORK5CYII='

export function createTray(deps: { openWindow: () => void }): Tray {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(ICON_DATA_URL.slice(ICON_DATA_URL.indexOf(',') + 1), 'base64'),
    { scaleFactor: 2 },
  )
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
