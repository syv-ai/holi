/**
 * The browser's pages: **the only file in `browser/` that imports Electron**,
 * loaded when a vault that runs the plugin opens (docs/features/browser.md).
 *
 * Each tab is a `WebContentsView` main lays over its tab's area of Holi's
 * window, where the renderer says that is (`place`). A page Holi is not
 * showing is taken out of the window and keeps running, so the agent can
 * work in a tab nobody is looking at.
 *
 * A page is the web, and nothing of Holi's: sandboxed, no preload, no Node,
 * Holi's IPC out of its reach, and only `http(s)` (a link to anything else
 * is refused, a `mailto:` handed to the system). A page that opens a window
 * gets a new tab instead. It asks for nothing: every permission is refused
 * but writing to the clipboard. Its logins are kept in one session for the
 * machine (`persist:holi-browser`), shared by every vault, so a site signed
 * in to once stays signed in.
 *
 * What the agent asks of a page runs in an isolated world
 * (`page-script.js`): the page's scripts never see it. A click lands as the
 * person's would, a real mouse event at the control's middle, when the page
 * is on screen and nothing covers the control; otherwise it is the script's.
 */
import { randomUUID } from 'node:crypto'
import {
  app,
  clipboard,
  Menu,
  session,
  shell,
  WebContentsView,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from 'electron'
import { CapabilityError } from '../../../main/plugin-api'
import { isPageUrl, type PageError, type PageInfo } from '../shared/page'
import type { Pages, Rect } from './capabilities'
import PAGE_SCRIPT from './page-script.js?raw'

const PARTITION = 'persist:holi-browser'
/** The isolated world `page-script.js` runs in. Any id but 0, the page's. */
const WORLD = 1017
/** How long an open or a click waits for its page to load. */
const LOAD_MS = 15_000
/** And for a page's script to draw what an action changed. */
const SETTLE_MS = 300
/** What a read prints at most, under the CLI's 16 KiB spill. */
const READ_MAX = 12_000
/** A page that has never been on screen is laid out at this size. */
const UNSEEN = { width: 1280, height: 800 }
/** Chromium's "the load was replaced by another": not a failure. */
const ERR_ABORTED = -3

/** A shortcut pressed in a page that Holi's window should hear, as the
 *  renderer rebuilds its `KeyboardEvent`. */
interface PageKey {
  key: string
  code: string
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export interface PagesDeps {
  window(): BrowserWindow | null
  /** The tabs changed: their list, as the renderer draws them. */
  changed(list: PageInfo[]): void
  /** Show tab `id` in Holi: one the agent or a page opened. */
  reveal(id: string): void
  /** The person asked the tab for its address bar (⌘L). */
  address(id: string): void
  /** A shortcut of Holi's, pressed while a page had the keyboard. */
  key(id: string, key: PageKey): void
}

/** A `mailto:` or `tel:` link, to the system. */
const toSystem = (url: string): void => void shell.openExternal(url)

interface Tab {
  id: string
  view: WebContentsView
  error: PageError | null
  favicon: string | null
  /** The window it is drawn in, or null while it is off screen. */
  shownIn: BrowserWindow | null
}

let shared: Session | null = null

/** The machine's one browser session, set up once. */
function browserSession(): Session {
  if (shared !== null) return shared
  const ses = session.fromPartition(PARTITION)
  // Without Electron and Holi in it, the agent is a browser like any other,
  // which some sites insist on.
  const own = new RegExp(` (?:Electron|${app.getName().replace(/\W/g, '\\$&')})/\\S+`, 'gi')
  ses.setUserAgent(ses.getUserAgent().replace(own, ''))
  const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write'
  ses.setPermissionRequestHandler((_wc, permission, answer) => answer(allowed(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed(permission))
  shared = ses
  return ses
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves when `wc` stops loading, or after `ms`. */
function stopped(wc: WebContents, ms: number): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      wc.off('did-stop-loading', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    wc.on('did-stop-loading', done)
  })
}

/** Electron's name for a key, from the DOM's (`ArrowDown`) or a person's
 *  (`down`, `esc`, `return`). */
function keyCode(key: string): string {
  const named: Record<string, string> = {
    arrowdown: 'Down',
    arrowup: 'Up',
    arrowleft: 'Left',
    arrowright: 'Right',
    down: 'Down',
    up: 'Up',
    left: 'Left',
    right: 'Right',
    enter: 'Enter',
    return: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    space: 'Space',
    ' ': 'Space',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  }
  return named[key.toLowerCase()] ?? key
}

type Modifier = 'shift' | 'control' | 'alt' | 'meta'

/** `Shift+Tab`, `Control+a` or `Enter`, as a key and its modifiers. */
function parseKey(spec: string): { code: string; modifiers: Modifier[] } {
  const parts = spec.split('+').filter((p) => p !== '')
  const last = spec.endsWith('+') ? '+' : (parts.pop() ?? '')
  const modifiers = parts.map((p): Modifier => {
    const m = p.toLowerCase()
    if (m === 'shift') return 'shift'
    if (m === 'ctrl' || m === 'control') return 'control'
    if (m === 'alt' || m === 'option') return 'alt'
    if (m === 'cmd' || m === 'command' || m === 'meta') return 'meta'
    throw new CapabilityError(
      'BAD_REQUEST',
      `unknown modifier ${p}`,
      'use Shift, Control, Alt or Meta',
    )
  })
  if (last === '') throw new CapabilityError('BAD_REQUEST', 'key is required')
  return { code: keyCode(last), modifiers }
}

const gone = (ref: number): CapabilityError =>
  new CapabilityError(
    'NOT_FOUND',
    `control ${ref} is not on the page any more`,
    'run holi browser read again and use its numbers',
  )

/** The keys a page keeps for itself under ⌘ (Ctrl elsewhere): editing. */
const PAGE_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y'])

export function createPages(deps: PagesDeps): Pages & {
  place(id: string, rect: Rect | null): void
  dispose(): void
} {
  const tabs = new Map<string, Tab>()
  let current: string | null = null
  let telling = false

  const tabOf = (id: string): Tab => {
    const tab = tabs.get(id)
    if (tab === undefined) throw new CapabilityError('NOT_FOUND', `no browser tab ${id}`)
    return tab
  }

  const info = (tab: Tab): PageInfo => {
    const wc = tab.view.webContents
    const url = wc.getURL()
    const title = wc.getTitle()
    return {
      id: tab.id,
      url: url === 'about:blank' ? '' : url,
      // Chromium names a page without a title by its address.
      title: title === url || title === 'about:blank' ? '' : title,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      favicon: tab.favicon,
      error: tab.error,
    }
  }

  const list = (): PageInfo[] => [...tabs.values()].map(info)

  /** Tell the renderer once per turn of the event loop, however many of a
   *  page's events fired in it. */
  const changed = (): void => {
    if (telling) return
    telling = true
    queueMicrotask(() => {
      telling = false
      deps.changed(list())
    })
  }

  /** Run `call` (`__holiPage.read(…)`) in the page's isolated world. */
  async function inPage<T>(tab: Tab, call: string): Promise<T> {
    try {
      return (await tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [
        { code: `${PAGE_SCRIPT}\n${call}` },
      ])) as T
    } catch (err) {
      throw new CapabilityError(
        'UNAVAILABLE',
        `the page could not be read: ${(err as Error).message}`,
        'wait for it to load, or reload it, then try again',
      )
    }
  }

  /** Wait for what an action set off: a load, then the page's own drawing. */
  async function settle(tab: Tab): Promise<void> {
    await delay(150)
    await stopped(tab.view.webContents, LOAD_MS)
    await delay(SETTLE_MS)
  }

  /** Load `url` in `tab`, answering once it has loaded, failed or taken too
   *  long. A failure is the tab's `error`, not a throw. */
  async function load(tab: Tab, url: string): Promise<PageInfo> {
    current = tab.id
    await Promise.race([tab.view.webContents.loadURL(url).catch(() => {}), delay(LOAD_MS)])
    return info(tab)
  }

  function contextMenu(tab: Tab, params: Electron.ContextMenuParams): void {
    const wc = tab.view.webContents
    const items: MenuItemConstructorOptions[] = []
    const link = params.linkURL
    if (link !== '' && isPageUrl(link)) {
      items.push(
        { label: 'Open Link in New Tab', click: () => void open({ url: link, reveal: true }) },
        { label: 'Open Link in Your Browser', click: () => void shell.openExternal(link) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(link) },
        { type: 'separator' },
      )
    }
    if (params.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' })
    } else if (params.selectionText.trim() !== '') {
      items.push({ role: 'copy' }, { type: 'separator' })
    }
    items.push(
      {
        label: 'Back',
        enabled: wc.navigationHistory.canGoBack(),
        click: () => wc.navigationHistory.goBack(),
      },
      {
        label: 'Forward',
        enabled: wc.navigationHistory.canGoForward(),
        click: () => wc.navigationHistory.goForward(),
      },
      { label: 'Reload', click: () => wc.reload() },
    )
    const win = deps.window()
    Menu.buildFromTemplate(items).popup(win === null ? {} : { window: win })
  }

  function watch(tab: Tab): void {
    const wc = tab.view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (isPageUrl(url) && url !== 'about:blank') void open({ url, reveal: true })
      else if (/^(mailto|tel):/i.test(url)) toSystem(url)
      return { action: 'deny' }
    })
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (isPageUrl(url)) return
      event.preventDefault()
      if (/^(mailto|tel):/i.test(url)) toSystem(url)
    }
    wc.on('will-navigate', (event) => guard(event, event.url))
    wc.on('will-redirect', (event) => guard(event, event.url))
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) tab.error = null
      changed()
    })
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return
      tab.error = { code, description, url }
      changed()
    })
    wc.on('render-process-gone', (_event, details) => {
      tab.error = {
        code: -1,
        description: `The page stopped (${details.reason}).`,
        url: wc.getURL(),
      }
      changed()
    })
    wc.on('page-favicon-updated', (_event, icons) => {
      tab.favicon = icons.find(isPageUrl) ?? null
      changed()
    })
    for (const name of [
      'did-start-loading',
      'did-stop-loading',
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated',
    ] as const) {
      wc.on(name as 'did-start-loading', changed)
    }
    wc.on('context-menu', (_event, params) => contextMenu(tab, params))
    // While a page has the keyboard, Holi's own shortcuts would go to it.
    // ⌘L, ⌘R, ⌘[ and ⌘] are the tab's; editing keys are the page's; any
    // other ⌘ key goes back to Holi's window as if pressed there.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const command = process.platform === 'darwin' ? input.meta : input.control
      if (!command) return
      const key = input.key.toLowerCase()
      if (PAGE_KEYS.has(key) && !input.alt) return
      event.preventDefault()
      if (key === 'l') return deps.address(tab.id)
      if (key === 'r') return void wc.reload()
      if (key === '[') return void wc.navigationHistory.goBack()
      if (key === ']') return void wc.navigationHistory.goForward()
      deps.window()?.webContents.focus()
      deps.key(tab.id, {
        key: input.key,
        code: input.code,
        meta: input.meta,
        ctrl: input.control,
        shift: input.shift,
        alt: input.alt,
      })
    })
  }

  async function open({
    url,
    id,
    reveal,
  }: {
    url?: string
    id?: string
    reveal: boolean
  }): Promise<PageInfo> {
    const known = id === undefined ? undefined : tabs.get(id)
    if (known !== undefined) return url === undefined ? info(known) : load(known, url)
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        safeDialogs: true,
        // The agent works in tabs nobody is looking at.
        backgroundThrottling: false,
      },
    })
    view.setBackgroundColor('#ffffffff')
    view.setBounds({ x: 0, y: 0, ...UNSEEN })
    const tab: Tab = {
      id: id ?? randomUUID().slice(0, 8),
      view,
      error: null,
      favicon: null,
      shownIn: null,
    }
    tabs.set(tab.id, tab)
    current = tab.id
    watch(tab)
    changed()
    if (reveal) deps.reveal(tab.id)
    return url === undefined ? info(tab) : load(tab, url)
  }

  function hide(tab: Tab): void {
    const win = tab.shownIn
    tab.shownIn = null
    if (win !== null && !win.isDestroyed()) win.contentView.removeChildView(tab.view)
  }

  function onScreen(tab: Tab): boolean {
    return tab.shownIn !== null && !tab.shownIn.isDestroyed() && tab.shownIn.isVisible()
  }

  async function press(tab: Tab, spec: string): Promise<void> {
    const { code, modifiers } = parseKey(spec)
    const wc = tab.view.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers })
    // The character is what types and what submits a form.
    const char = code === 'Enter' ? '\r' : code === 'Space' ? ' ' : code.length === 1 ? code : null
    if (char !== null) wc.sendInputEvent({ type: 'char', keyCode: char, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
  }

  return {
    list,
    current: () => current,
    has: (id) => tabs.has(id),
    open,

    navigate: (id, url) => load(tabOf(id), url),

    async back(id) {
      const tab = tabOf(id)
      current = id
      if (tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack()
        await settle(tab)
      }
      return info(tab)
    },

    async forward(id) {
      const tab = tabOf(id)
      current = id
      if (tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward()
        await settle(tab)
      }
      return info(tab)
    },

    async reload(id) {
      const tab = tabOf(id)
      current = id
      tab.view.webContents.reload()
      await settle(tab)
      return info(tab)
    },

    stop(id) {
      const tab = tabOf(id)
      tab.view.webContents.stop()
      return info(tab)
    },

    close(id) {
      const tab = tabs.get(id)
      if (tab === undefined) return
      hide(tab)
      tabs.delete(id)
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      if (current === id) current = [...tabs.keys()].at(-1) ?? null
      changed()
    },

    async read(id) {
      const tab = tabOf(id)
      current = id
      await stopped(tab.view.webContents, LOAD_MS)
      const page = info(tab)
      if (page.url === '') return { id, url: '', title: '', text: '', truncated: false }
      const read = await inPage<{ title: string; url: string; text: string; truncated: boolean }>(
        tab,
        `__holiPage.read(${READ_MAX})`,
      )
      return { id, ...read }
    },

    async click(id, ref) {
      const tab = tabOf(id)
      current = id
      const point = await inPage<{ x: number; y: number; lands: boolean } | null>(
        tab,
        `__holiPage.point(${ref})`,
      )
      if (point === null) throw gone(ref)
      if (onScreen(tab) && point.lands) {
        const at = { x: Math.round(point.x), y: Math.round(point.y) }
        const wc = tab.view.webContents
        wc.sendInputEvent({ type: 'mouseMove', ...at })
        wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
      } else if (!(await inPage<boolean>(tab, `__holiPage.click(${ref})`))) {
        throw gone(ref)
      }
      await settle(tab)
      return info(tab)
    },

    async type(id, ref, text, submit) {
      const tab = tabOf(id)
      current = id
      const json = JSON.stringify(text)
      const focused = await inPage<boolean>(tab, `__holiPage.focus(${ref})`)
      let typed = false
      if (focused && text !== '') {
        // As if typed: the page hears the keys' input events, as it would
        // the person's. A field typing does not reach is filled instead.
        await tab.view.webContents.insertText(text)
        const value = await inPage<string | null>(tab, `__holiPage.valueOf(${ref})`)
        typed = value !== null && value.includes(text)
      }
      if (!typed && !(await inPage<boolean>(tab, `__holiPage.fill(${ref}, ${json})`))) {
        const exists = await inPage<string | null>(tab, `__holiPage.valueOf(${ref})`)
        if (exists === null && !focused) throw gone(ref)
        throw new CapabilityError(
          'BAD_REQUEST',
          `control ${ref} does not take text${exists === null ? '' : ' (or has no such option)'}`,
          'type into a textbox, searchbox or select from holi browser read',
        )
      }
      if (submit) await press(tab, 'Enter')
      await settle(tab)
      return info(tab)
    },

    async press(id, key) {
      const tab = tabOf(id)
      current = id
      await press(tab, key)
      await settle(tab)
      return info(tab)
    },

    async scroll(id, to) {
      const tab = tabOf(id)
      current = id
      const at = await inPage<{ atEnd: boolean }>(tab, `__holiPage.scroll(${JSON.stringify(to)})`)
      await delay(SETTLE_MS)
      return { ...info(tab), atEnd: at.atEnd }
    },

    async screenshot(id) {
      const tab = tabOf(id)
      current = id
      await stopped(tab.view.webContents, LOAD_MS)
      const image = await tab.view.webContents.capturePage(undefined, { stayHidden: true })
      if (image.isEmpty()) {
        throw new CapabilityError(
          'UNAVAILABLE',
          'the page has not drawn yet',
          'open its tab in Holi, or wait for it to load, then try again',
        )
      }
      return image.toPNG()
    },

    async still(id) {
      const tab = tabOf(id)
      const image = await tab.view.webContents.capturePage()
      if (image.isEmpty()) return null
      return `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
    },

    place(id, rect) {
      const tab = tabs.get(id)
      if (tab === undefined) return
      const win = deps.window()
      if (rect === null || win === null || rect.width < 1 || rect.height < 1) return hide(tab)
      if (tab.shownIn !== win) {
        hide(tab)
        win.contentView.addChildView(tab.view)
        tab.shownIn = win
        // The tab the person brings up is the one "the page" means.
        current = id
      }
      const zoom = win.webContents.getZoomFactor()
      tab.view.setBounds({
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
      })
    },

    dispose() {
      for (const id of [...tabs.keys()]) {
        const tab = tabs.get(id)!
        hide(tab)
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      }
      tabs.clear()
      current = null
    },
  }
}
