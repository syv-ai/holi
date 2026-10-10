/**
 * A window of Holi's renderer: the main window, or a plugin's page window
 * (`page-windows.ts`). What goes into each is core's and the same for both:
 * the preload, the isolation, the document and the navigation guard, so
 * hardening one hardens the other.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import { guardNavigation } from './window-guard'

/** The window, its renderer loading. `page` names a plugin's page
 *  (`<plugin>/<page>`, read by `PageRoot`); absent, it is the main window. */
export function rendererWindow(
  options: Omit<BrowserWindowConstructorOptions, 'webPreferences'>,
  frameSchemes: ReadonlySet<string>,
  page?: string,
): BrowserWindow {
  const win = new BrowserWindow({
    ...options,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const file = join(__dirname, '../renderer/index.html')
  if (devUrl) {
    const url = new URL(devUrl)
    if (page !== undefined) url.searchParams.set('page', page)
    void win.loadURL(page === undefined ? devUrl : url.href)
  } else {
    void win.loadFile(file, page === undefined ? {} : { query: { page } })
  }
  // After the load, so the guard knows what "the app" is. A drop the renderer
  // does not claim is a navigation, and Electron answers a navigation with a
  // window — see window-guard.ts.
  guardNavigation(
    win,
    devUrl ?? pathToFileURL(file).href,
    (url) => void shell.openExternal(url),
    frameSchemes,
  )
  return win
}
