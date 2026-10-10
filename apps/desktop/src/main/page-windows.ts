/**
 * A plugin's own windows (docs/architecture.md, Plugins): a page of its
 * renderer side in a window beside the main one, such as the agent's quick
 * panel.
 *
 * Core makes the window, because what goes into one is core's: the preload,
 * the isolation, the document and the navigation guard. The plugin owns the
 * rest (size, place, showing, closing) through Electron's own window.
 *
 * **One channel per window, not the plugin's.** A page is told things on
 * `page:event` and answers on `page:message`, and main hears a message only
 * from the window it opened, by sender. The plugin's events stay the main
 * window's, so a busy terminal's bytes never reach a panel that did not ask.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  ipcMain,
  shell,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
} from 'electron'
import { guardNavigation } from './window-guard'

/** What a plugin asks for (`AppContext.openPage`). */
export interface PageWindowOptions {
  /** The page its renderer side draws in it (`RendererPlugin.pages`). */
  page: string
  /** Electron's options for the window. The page's web preferences are core's. */
  window: Omit<BrowserWindowConstructorOptions, 'webPreferences'>
}

/** One of a plugin's windows. */
export interface PageWindow {
  readonly window: BrowserWindow
  /** Tell its page `name`. Nothing is sent once it is closed. */
  send(name: string, payload: unknown): void
  /** Hear `name` from its page. Returns the undo; closing ends them all. */
  on(name: string, handler: (payload: unknown) => void): () => void
}

/** A page's name: lowercase letters, digits and dashes. */
const PAGE = /^[a-z][a-z0-9-]*$/

export interface PageWindows {
  open(plugin: string, options: PageWindowOptions): PageWindow
  /** Close every page window: at quit. */
  closeAll(): void
}

export function createPageWindows(deps: { frameSchemes: ReadonlySet<string> }): PageWindows {
  /** webContents id → its window's message handlers. */
  const listeners = new Map<number, Map<string, Set<(payload: unknown) => void>>>()
  const open = new Set<BrowserWindow>()

  ipcMain.on('page:message', (event: IpcMainEvent, message: unknown) => {
    const handlers = listeners.get(event.sender.id)
    if (handlers === undefined || typeof message !== 'object' || message === null) return
    const { name, payload } = message as { name?: unknown; payload?: unknown }
    if (typeof name !== 'string') return
    for (const handler of [...(handlers.get(name) ?? [])]) {
      try {
        handler(payload)
      } catch (err) {
        console.error(`[pages] ${name} failed:`, err)
      }
    }
  })

  return {
    open(plugin, options) {
      if (!PAGE.test(options.page)) throw new Error(`page name ${options.page} is not kebab-case`)
      const win = new BrowserWindow({
        ...options.window,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      const contentsId = win.webContents.id
      const handlers = new Map<string, Set<(payload: unknown) => void>>()
      listeners.set(contentsId, handlers)
      open.add(win)
      win.on('closed', () => {
        listeners.delete(contentsId)
        open.delete(win)
      })

      const query = { page: `${plugin}/${options.page}` }
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const file = join(__dirname, '../renderer/index.html')
      if (devUrl) {
        const url = new URL(devUrl)
        url.searchParams.set('page', query.page)
        void win.loadURL(url.href)
      } else {
        void win.loadFile(file, { query })
      }
      guardNavigation(
        win,
        devUrl ?? pathToFileURL(file).href,
        (url) => void shell.openExternal(url),
        deps.frameSchemes,
      )

      return {
        window: win,
        send(name, payload) {
          if (win.isDestroyed()) return
          win.webContents.send('page:event', { name, payload })
        },
        on(name, handler) {
          let set = handlers.get(name)
          if (set === undefined) handlers.set(name, (set = new Set()))
          set.add(handler)
          return () => void set.delete(handler)
        },
      }
    },

    closeAll() {
      for (const win of [...open]) if (!win.isDestroyed()) win.destroy()
      open.clear()
    },
  }
}
