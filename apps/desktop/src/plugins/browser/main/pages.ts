import type { HintPresentation } from '@holi/shared'
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
import {
  isPageUrl,
  type PageError,
  type PageHintEvent,
  type PageHintLabel,
  type PageHintOwner,
  type PageHintScope,
  type PageHintSnapshot,
  type PageHintTarget,
  type PageInfo,
} from '../shared/page'
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
  presentationLease?(): () => boolean
  onDisplayChange?(cb: (remote: string | null) => void): () => void
  /** The tabs changed: their list, as the renderer draws them. */
  changed(list: PageInfo[]): void
  /** Show tab `id` in Holi: one the agent or a page opened. */
  reveal(id: string, attachment?: () => boolean): void
  /** The person asked the tab for its address bar (⌘L). */
  address(id: string, attachment?: () => boolean): void
  /** A shortcut of Holi's, pressed while a page had the keyboard. */
  key(id: string, key: PageKey, attachment?: () => boolean): void
  vimMode?(
    id: string,
    snapshot: { nonce: string; attachment: string; revision: number; mode: 'insert' | 'normal' },
    attachment?: () => boolean,
  ): void
  hints?(event: PageHintEvent, attachment?: () => boolean): void
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
  shownLease: (() => boolean) | null
  attachment: symbol | null
  attachmentId: string | null
  menu: Menu | null
  vimNonce: string | null
  vimGeneration: number
  vimRevision: number
  vimRequestOwner: string | null
  vimRequestRevision: number
  vimModeSequence: number
  vimPoll: ReturnType<typeof setInterval> | null
  vimLastSnapshot: string | null
  vimNavigationPending: boolean
  hintRequest: number
  hintOwner: PageHintOwner | null
  hintPendingOwner: PageHintOwner | null
  hintRequestOrigin: string | null
  hintRequestCapture: number | null
  hintCaptureOwner: { capture: number; owner: PageHintOwner } | null
  hintRetiredCapture: { capture: number | null; owner: PageHintOwner } | null
  hintPendingKeys: Map<
    number,
    {
      key?: string
      code?: string
      repeat?: boolean
      isComposing?: boolean
      metaKey?: boolean
      ctrlKey?: boolean
      altKey?: boolean
      shiftKey?: boolean
    }[]
  >
  hintRevision: number
  hintSnapshot: number
  hintGeometry: number
  hintDraining: boolean
  hintClosed: boolean
  hintZoom: number
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
  placementGuard(id: unknown, presentation: () => boolean): () => boolean
  dispose(): void
} & {
  configureVim(
    id: string,
    enabled: boolean,
    revision: number,
    nonce: string,
    attachment: string,
  ): Promise<void>
  discoverHints(scope: PageHintScope): Promise<PageHintSnapshot | null>
  presentHints(
    owner: PageHintOwner,
    revision: number,
    labels: PageHintLabel[],
    theme: 'light' | 'dark',
    presentation: HintPresentation,
  ): Promise<boolean>
  clearHints(scope: PageHintScope): Promise<void>
  activateHint(owner: PageHintOwner, id: string): Promise<boolean>
} {
  const tabs = new Map<string, Tab>()
  let current: string | null = null
  let telling = false
  let disposed = false

  const tabOf = (id: string): Tab => {
    const tab = tabs.get(id)
    if (tab === undefined) throw new CapabilityError('NOT_FOUND', `no browser tab ${id}`)
    return tab
  }

  const isLive = (tab: Tab): boolean =>
    !disposed && tabs.get(tab.id) === tab && !tab.view.webContents.isDestroyed()

  const isPresented = (tab: Tab): boolean =>
    isLive(tab) &&
    tab.shownIn !== null &&
    !tab.shownIn.isDestroyed() &&
    tab.shownLease !== null &&
    tab.shownLease()

  function placementGuard(id: unknown, presentation: () => boolean): () => boolean {
    const tab = typeof id === 'string' ? tabs.get(id) : undefined
    return () => tab !== undefined && isLive(tab) && presentation()
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
    if (disposed || telling) return
    telling = true
    queueMicrotask(() => {
      telling = false
      if (!disposed) deps.changed(list())
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

  function reportVim(tab: Tab): void {
    if (tab.vimNonce === null || !isPresented(tab)) return
    drainHintEvents(tab)
    const nonce = tab.vimNonce
    const attachment = tab.attachmentId
    if (attachment === null) return
    const generation = tab.vimGeneration
    const sequence = ++tab.vimModeSequence
    void inPage<{ revision: number; mode: 'insert' | 'normal' }>(tab, '__holiPage.vim.mode()')
      .then((mode) => {
        if (
          !isPresented(tab) ||
          tab.vimNonce !== nonce ||
          tab.vimGeneration !== generation ||
          sequence !== tab.vimModeSequence
        )
          return
        const snapshot = JSON.stringify({ nonce, attachment, ...mode })
        if (tab.vimLastSnapshot === snapshot) return
        tab.vimLastSnapshot = snapshot
        deps.vimMode?.(
          tab.id,
          { nonce, attachment, ...mode },
          () => isPresented(tab) && tab.attachmentId === attachment,
        )
      })
      .catch(() => {})
  }

  function drainHintEvents(tab: Tab): void {
    const emitHint = deps.hints
    if (!emitHint || tab.hintDraining || tab.vimNonce === null || tab.attachmentId === null) return
    tab.hintDraining = true
    const nonce = tab.vimNonce
    const attachment = tab.attachmentId
    const generation = tab.vimGeneration
    void inPage<
      {
        type: 'request' | 'key' | 'revoke'
        owner?: PageHintOwner
        key?: string
        code?: string
        repeat?: boolean
        capture?: number
        isComposing?: boolean
        metaKey?: boolean
        ctrlKey?: boolean
        altKey?: boolean
        shiftKey?: boolean
      }[]
    >(tab, '__holiPage.hints.poll()')
      .then((events) => {
        if (
          !Array.isArray(events) ||
          !isPresented(tab) ||
          tab.vimNonce !== nonce ||
          tab.attachmentId !== attachment ||
          tab.vimGeneration !== generation
        )
          return
        for (const value of events) {
          if (value.type === 'request') {
            const request = ++tab.hintRequest
            const origin = randomUUID()
            tab.hintRequestOrigin = origin
            tab.hintPendingKeys.clear()
            tab.hintRequestCapture = Number.isSafeInteger(value.capture) ? value.capture! : null
            tab.hintCaptureOwner = null
            tab.hintRetiredCapture = null
            if (tab.hintRequestCapture !== null) tab.hintPendingKeys.set(tab.hintRequestCapture, [])
            tab.hintOwner = null
            tab.hintClosed = false
            tab.hintRevision = 0
            tab.hintSnapshot++
            emitHint(
              { tab: tab.id, nonce, attachment, request, origin, type: 'request' },
              () =>
                isPresented(tab) &&
                tab.vimNonce === nonce &&
                tab.attachmentId === attachment &&
                tab.vimGeneration === generation,
            )
          } else if (
            value.type === 'revoke' &&
            value.capture !== undefined &&
            value.capture === tab.hintRequestCapture
          ) {
            tab.hintPendingKeys.delete(value.capture)
            tab.hintCaptureOwner = null
            tab.hintRetiredCapture = null
            const origin = tab.hintRequestOrigin
            if (origin !== null) {
              emitHint(
                {
                  tab: tab.id,
                  nonce,
                  attachment,
                  request: tab.hintRequest,
                  origin,
                  type: 'cancel',
                },
                () =>
                  isPresented(tab) &&
                  tab.vimNonce === nonce &&
                  tab.attachmentId === attachment &&
                  tab.vimGeneration === generation,
              )
            }
            tab.hintRequestCapture = null
            tab.hintRequestOrigin = null
            tab.hintPendingOwner = null
            tab.hintClosed = true
            tab.hintSnapshot++
          } else if (
            value.type === 'revoke' &&
            tab.hintRetiredCapture !== null &&
            ((value.capture !== undefined && value.capture === tab.hintRetiredCapture.capture) ||
              (value.owner !== undefined &&
                value.owner.tab === tab.hintRetiredCapture.owner.tab &&
                value.owner.nonce === tab.hintRetiredCapture.owner.nonce &&
                value.owner.attachment === tab.hintRetiredCapture.owner.attachment &&
                value.owner.request === tab.hintRetiredCapture.owner.request &&
                value.owner.origin === tab.hintRetiredCapture.owner.origin &&
                value.owner.snapshot === tab.hintRetiredCapture.owner.snapshot &&
                value.owner.geometry === tab.hintRetiredCapture.owner.geometry))
          ) {
            const retired = tab.hintRetiredCapture
            tab.hintRetiredCapture = null
            tab.hintCaptureOwner = null
            emitHint(
              { ...retired.owner, type: 'cancel' },
              () =>
                isPresented(tab) &&
                tab.vimNonce === nonce &&
                tab.attachmentId === attachment &&
                tab.vimGeneration === generation &&
                tab.hintRequest === retired.owner.request &&
                tab.hintRequestOrigin === retired.owner.origin,
            )
          } else if (value.type === 'revoke' && value.owner && hintOwns(tab, value.owner)) {
            revokeHints(tab)
          } else if (value.type === 'key' && value.capture !== undefined) {
            const captureOwner = tab.hintCaptureOwner
            if (captureOwner?.capture === value.capture && hintOwns(tab, captureOwner.owner)) {
              const { capture: _capture, type: _type, owner: _owner, ...rawKey } = value
              emitHint({ ...captureOwner.owner, type: 'key', ...rawKey }, () =>
                hintOwns(tab, captureOwner.owner),
              )
            } else if (!value.owner && value.capture === tab.hintRequestCapture) {
              const pending = tab.hintPendingKeys.get(value.capture)
              if (pending && pending.length < 32) pending.push(value)
            }
          } else if (value.type === 'key' && value.owner && hintOwns(tab, value.owner)) {
            const owner = value.owner
            const { type: _type, owner: _eventOwner, ...key } = value
            emitHint({ ...owner, type: 'key', ...key }, () => hintOwns(tab, owner))
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        tab.hintDraining = false
      })
  }

  function revokeHints(tab: Tab): void {
    const owner = tab.hintOwner ?? tab.hintPendingOwner
    tab.hintOwner = null
    tab.hintPendingOwner = null
    tab.hintRequestOrigin = null
    tab.hintRequestCapture = null
    tab.hintCaptureOwner = null
    tab.hintRetiredCapture = null
    tab.hintPendingKeys.clear()
    tab.hintClosed = true
    tab.hintGeometry++
    tab.hintSnapshot++
    if (owner)
      deps.hints?.(
        { ...owner, type: 'revoke' },
        () => isPresented(tab) && tab.attachmentId === owner.attachment,
      )
    if (tab.vimNonce && !tab.view.webContents.isDestroyed())
      if (owner)
        void inPage(tab, `__holiPage.hints.clear(${JSON.stringify(owner)})`).catch(() => {})
  }

  function resetVimOwnership(tab: Tab): void {
    tab.vimGeneration++
    revokeHints(tab)
    tab.vimNonce = null
    tab.vimModeSequence++
    tab.vimLastSnapshot = null
  }

  async function initializeVim(tab: Tab): Promise<void> {
    const generation = ++tab.vimGeneration
    tab.vimNonce = null
    try {
      const nonce = await inPage<string>(tab, '__holiPage.vim.rearm()')
      if (!isLive(tab) || generation !== tab.vimGeneration) return
      tab.vimNonce = nonce
      tab.hintRequest = 0
      tab.hintSnapshot = 0
      tab.hintRevision = 0
      tab.hintClosed = false
      tab.hintRequestOrigin = null
      tab.hintRetiredCapture = null
      tab.vimRevision++
      reportVim(tab)
    } catch {
      // A document can be replaced while the isolated world is starting.
    }
  }

  async function configureVim(
    id: string,
    enabled: boolean,
    requestRevision: number,
    nonce: string,
    attachment: string,
  ): Promise<void> {
    const tab = tabs.get(id)
    if (
      tab === undefined ||
      !isPresented(tab) ||
      nonce !== tab.vimNonce ||
      attachment !== tab.attachmentId ||
      !Number.isSafeInteger(requestRevision) ||
      requestRevision < 1
    )
      return
    if (!enabled) revokeHints(tab)
    const owner = `${nonce}:${attachment}`
    if (tab.vimRequestOwner !== owner) {
      tab.vimRequestOwner = owner
      tab.vimRequestRevision = 0
    }
    if (requestRevision <= tab.vimRequestRevision) return
    tab.vimRequestRevision = requestRevision
    const generation = tab.vimGeneration
    const attachmentId = tab.attachmentId
    const ownerRevision = tab.vimRequestRevision
    const revision = ++tab.vimRevision
    try {
      const applied = await inPage<boolean>(
        tab,
        `__holiPage.vim.configure(${enabled}, ${revision}, ${JSON.stringify(nonce)})`,
      )
      if (
        !applied ||
        !isPresented(tab) ||
        generation !== tab.vimGeneration ||
        nonce !== tab.vimNonce ||
        attachmentId !== tab.attachmentId ||
        owner !== tab.vimRequestOwner ||
        ownerRevision !== tab.vimRequestRevision
      )
        return
      reportVim(tab)
    } catch {
      // Navigation owns the next initialization and mode snapshot.
    }
  }

  const hintOwns = (tab: Tab, owner: PageHintOwner): boolean => {
    const current = tab.hintOwner
    return (
      isPresented(tab) &&
      tab.vimNonce === owner.nonce &&
      tab.attachmentId === owner.attachment &&
      current !== null &&
      !tab.hintClosed &&
      owner.request === tab.hintRequest &&
      owner.geometry === tab.hintGeometry &&
      current.origin === owner.origin &&
      current.request === owner.request &&
      current.snapshot === owner.snapshot &&
      current.geometry === owner.geometry
    )
  }

  async function discoverHints(scope: PageHintScope): Promise<PageHintSnapshot | null> {
    const tab = tabs.get(scope.tab)
    if (
      !tab ||
      !isPresented(tab) ||
      !scopeMatches(tab, scope) ||
      scope.request < tab.hintRequest ||
      (scope.request === tab.hintRequest && (tab.hintClosed || tab.hintOwner !== null))
    )
      return null
    const generation = tab.vimGeneration
    const attachment = tab.attachmentId!
    const lease = tab.shownLease
    tab.hintOwner = null
    tab.hintClosed = false
    const origin = tab.hintRequest === scope.request ? tab.hintRequestOrigin : null
    const ownerBase = { ...scope, origin: origin ?? randomUUID() }
    tab.hintRequest = scope.request
    tab.hintRequestOrigin = ownerBase.origin
    const snapshot = ++tab.hintSnapshot
    const geometry = tab.hintGeometry
    const pendingOwner: PageHintOwner = { ...ownerBase, snapshot, geometry }
    tab.hintPendingOwner = pendingOwner
    const bounds = tab.view.getBounds()
    const zoom = deps.window()?.webContents.getZoomFactor() ?? 1
    const targets = await inPage<PageHintTarget[] | null>(
      tab,
      `__holiPage.hints.discover(${JSON.stringify({ ...ownerBase, snapshot, geometry, capture: tab.hintRequestCapture })})`,
    ).catch(() => null)
    if (
      !targets ||
      !isPresented(tab) ||
      generation !== tab.vimGeneration ||
      tab.attachmentId !== attachment ||
      tab.vimNonce !== scope.nonce ||
      tab.hintRequest !== scope.request ||
      tab.hintSnapshot !== snapshot ||
      tab.hintGeometry !== geometry ||
      tab.shownLease !== lease ||
      zoom !== (deps.window()?.webContents.getZoomFactor() ?? 1) ||
      JSON.stringify(bounds) !== JSON.stringify(tab.view.getBounds()) ||
      !scopeMatches(tab, scope)
    )
      return null
    const owner = pendingOwner
    tab.hintPendingOwner = null
    tab.hintRequest = scope.request
    tab.hintRequestOrigin = owner.origin
    tab.hintClosed = false
    tab.hintRevision = 0
    tab.hintZoom = zoom
    tab.hintOwner = owner
    const capture = tab.hintRequestCapture
    const pendingKeys = capture === null ? [] : (tab.hintPendingKeys.get(capture) ?? [])
    if (capture !== null) tab.hintPendingKeys.delete(capture)
    if (capture !== null) tab.hintCaptureOwner = { capture, owner }
    for (const key of pendingKeys) {
      const { capture: _capture, ...rawKey } = key as typeof key & { capture?: number }
      deps.hints?.({ ...owner, type: 'key', ...rawKey }, () => hintOwns(tab, owner))
    }
    return {
      owner,
      targets: targets.map((target) => ({
        ...target,
        x: bounds.x / zoom + target.x,
        y: bounds.y / zoom + target.y,
      })),
    }
  }

  function scopeMatches(tab: Tab, scope: PageHintScope): boolean {
    return (
      scope.tab === tab.id &&
      scope.nonce === tab.vimNonce &&
      scope.attachment === tab.attachmentId &&
      Number.isSafeInteger(scope.request) &&
      scope.request > 0
    )
  }

  async function presentHints(
    owner: PageHintOwner,
    revision: number,
    labels: PageHintLabel[],
    theme: 'light' | 'dark',
    presentation: HintPresentation,
  ): Promise<boolean> {
    const tab = tabs.get(owner.tab)
    if (
      !tab ||
      !hintOwns(tab, owner) ||
      tab.hintZoom !== (deps.window()?.webContents.getZoomFactor() ?? 1) ||
      !Number.isSafeInteger(revision) ||
      revision <= tab.hintRevision
    )
      return false
    tab.hintRevision = revision
    const generation = tab.vimGeneration
    const lease = tab.shownLease
    const result = await inPage<boolean>(
      tab,
      `__holiPage.hints.present(${JSON.stringify(owner)}, ${revision}, ${JSON.stringify(labels)}, ${JSON.stringify(theme)}, ${JSON.stringify(presentation)})`,
    ).catch(() => false)
    return (
      result &&
      tabs.get(tab.id) === tab &&
      hintOwns(tab, owner) &&
      generation === tab.vimGeneration &&
      lease === tab.shownLease
    )
  }

  async function clearHints(scope: PageHintScope): Promise<void> {
    const tab = tabs.get(scope.tab)
    if (!tab || !scopeMatches(tab, scope) || scope.request < tab.hintRequest) return
    tab.hintRequest = scope.request
    tab.hintClosed = true
    const owner = tab.hintOwner ?? tab.hintPendingOwner
    tab.hintOwner = null
    tab.hintPendingOwner = null
    const retiredOwner = tab.hintCaptureOwner?.owner ?? owner
    if (retiredOwner) {
      tab.hintRetiredCapture = {
        capture: tab.hintRequestCapture,
        owner: retiredOwner,
      }
    }
    tab.hintCaptureOwner = null
    tab.hintRequestCapture = null
    tab.hintPendingKeys.clear()
    tab.hintSnapshot++
    tab.hintRevision++
    if (owner)
      await inPage<boolean>(tab, `__holiPage.hints.clear(${JSON.stringify(owner)})`).catch(
        () => false,
      )
  }

  async function activateHint(owner: PageHintOwner, id: string): Promise<boolean> {
    const tab = tabs.get(owner.tab)
    if (!tab || !hintOwns(tab, owner) || !isPresented(tab)) return false
    const generation = tab.vimGeneration
    const attachment = tab.attachmentId
    const lease = tab.shownLease
    const bounds = tab.view.getBounds()
    const zoom = deps.window()?.webContents.getZoomFactor() ?? 1
    if (zoom !== tab.hintZoom) {
      revokeHints(tab)
      return false
    }
    const point = await inPage<{ x: number; y: number; field: boolean } | null>(
      tab,
      `__holiPage.hints.activate(${JSON.stringify(owner)}, ${JSON.stringify(id)})`,
    ).catch(() => null)
    if (
      !point ||
      !hintOwns(tab, owner) ||
      generation !== tab.vimGeneration ||
      attachment !== tab.attachmentId ||
      lease !== tab.shownLease ||
      zoom !== (deps.window()?.webContents.getZoomFactor() ?? 1) ||
      JSON.stringify(bounds) !== JSON.stringify(tab.view.getBounds())
    )
      return false
    const win = tab.shownIn
    if (!win || !isPresented(tab)) return false
    const check = await inPage<{ x: number; y: number; field: boolean } | null>(
      tab,
      `__holiPage.hints.activate(${JSON.stringify(owner)}, ${JSON.stringify(id)})`,
    ).catch(() => null)
    if (
      !check ||
      check.x !== point.x ||
      check.y !== point.y ||
      !hintOwns(tab, owner) ||
      generation !== tab.vimGeneration ||
      attachment !== tab.attachmentId ||
      lease !== tab.shownLease ||
      zoom !== (deps.window()?.webContents.getZoomFactor() ?? 1) ||
      JSON.stringify(bounds) !== JSON.stringify(tab.view.getBounds())
    )
      return false
    const at = { x: Math.round(check.x), y: Math.round(check.y) }
    const wc = tab.view.webContents
    if (point.field) {
      const entered = await inPage<boolean>(
        tab,
        `__holiPage.hints.enterInsert(${JSON.stringify(owner)}, ${JSON.stringify(id)})`,
      ).catch(() => false)
      if (!entered || !hintOwns(tab, owner)) return false
    }
    const stillCaptured = (): boolean =>
      hintOwns(tab, owner) &&
      generation === tab.vimGeneration &&
      attachment === tab.attachmentId &&
      lease === tab.shownLease &&
      zoom === (deps.window()?.webContents.getZoomFactor() ?? 1) &&
      JSON.stringify(bounds) === JSON.stringify(tab.view.getBounds())
    // The awaited insert-mode transition can race placement, zoom, navigation,
    // or revocation. Recheck the complete capture immediately before input.
    if (!stillCaptured()) return false
    wc.sendInputEvent({ type: 'mouseMove', ...at })
    if (!stillCaptured()) return false
    wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    if (!stillCaptured()) return false
    wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    await clearHints(owner)
    return true
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
    revokeHints(tab)
    const win = deps.window()
    if (!isPresented(tab) || win === null || tab.shownIn !== win) return
    const lease = tab.shownLease
    const attachment = tab.attachment
    const attached = (): boolean => attachment !== null && tab.attachment === attachment
    const live = (): boolean =>
      isPresented(tab) && tab.shownLease === lease && attached() && deps.window() === win
    const wc = tab.view.webContents
    const items: MenuItemConstructorOptions[] = []
    const link = params.linkURL
    if (link !== '' && isPageUrl(link)) {
      items.push(
        {
          label: 'Open Link in New Tab',
          click: () => {
            if (live()) void open({ url: link, reveal: true, attachment: live })
          },
        },
        {
          label: 'Open Link in Your Browser',
          click: () => {
            if (live()) void shell.openExternal(link)
          },
        },
        {
          label: 'Copy Link Address',
          click: () => {
            if (live()) clipboard.writeText(link)
          },
        },
        { type: 'separator' },
      )
    }
    if (params.isEditable) {
      items.push(
        {
          label: 'Cut',
          click: () => {
            if (live()) wc.cut()
          },
        },
        {
          label: 'Copy',
          click: () => {
            if (live()) wc.copy()
          },
        },
        {
          label: 'Paste',
          click: () => {
            if (live()) wc.paste()
          },
        },
        { type: 'separator' },
      )
    } else if (params.selectionText.trim() !== '') {
      items.push(
        {
          label: 'Copy',
          click: () => {
            if (live()) wc.copy()
          },
        },
        { type: 'separator' },
      )
    }
    items.push(
      {
        label: 'Back',
        enabled: wc.navigationHistory.canGoBack(),
        click: () => {
          if (live()) wc.navigationHistory.goBack()
        },
      },
      {
        label: 'Forward',
        enabled: wc.navigationHistory.canGoForward(),
        click: () => {
          if (live()) wc.navigationHistory.goForward()
        },
      },
      {
        label: 'Reload',
        click: () => {
          if (live()) wc.reload()
        },
      },
    )
    const menu = Menu.buildFromTemplate(items)
    tab.menu?.closePopup()
    tab.menu = menu
    menu.once('menu-will-close', () => {
      if (tab.menu === menu) tab.menu = null
    })
    menu.popup({ window: win })
  }

  function watch(tab: Tab): void {
    const wc = tab.view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (!isLive(tab)) return { action: 'deny' }
      if (isPageUrl(url) && url !== 'about:blank') {
        const attachment = tab.attachment
        void open({
          url,
          reveal: true,
          attachment: () => isPresented(tab) && tab.attachment === attachment,
        })
      } else if (/^(mailto|tel):/i.test(url) && isPresented(tab)) toSystem(url)
      return { action: 'deny' }
    })
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (isPageUrl(url)) return
      event.preventDefault()
      if (/^(mailto|tel):/i.test(url) && isPresented(tab)) toSystem(url)
    }
    wc.on('will-navigate', (event) => guard(event, event.url))
    wc.on('will-redirect', (event) => guard(event, event.url))
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame) {
        if (!event.isSameDocument) {
          tab.error = null
          tab.vimNavigationPending = true
        }
        resetVimOwnership(tab)
      }
      changed()
    })
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return
      tab.vimNavigationPending = false
      if (code !== ERR_ABORTED) {
        tab.error = { code, description, url }
        revokeHints(tab)
        changed()
      }
      // A stopped or failed navigation can leave the outgoing document alive.
      // It needs a fresh nonce, even though no did-finish-load will follow.
      void initializeVim(tab)
    })
    wc.on('render-process-gone', (_event, details) => {
      revokeHints(tab)
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
    for (const name of ['did-start-loading', 'did-navigate', 'page-title-updated'] as const) {
      wc.on(name as 'did-start-loading', changed)
    }
    wc.on('did-stop-loading', () => {
      if (tab.vimNavigationPending) {
        tab.vimNavigationPending = false
        void initializeVim(tab)
      }
      changed()
    })
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return
      // History API and fragment changes retain the document, but relinquish
      // its prior Vim owner and arm it again as insert mode.
      resetVimOwnership(tab)
      void initializeVim(tab)
      changed()
    })
    wc.on('did-finish-load', () => {
      tab.vimNavigationPending = false
      void initializeVim(tab)
    })
    wc.on('context-menu', (_event, params) => contextMenu(tab, params))
    // While a page has the keyboard, Holi's own shortcuts would go to it.
    // ⌘L, ⌘R, ⌘[ and ⌘] are the tab's; editing keys are the page's; any
    // other ⌘ key goes back to Holi's window as if pressed there.
    wc.on('before-input-event', (event, input) => {
      if (!isPresented(tab) || input.type !== 'keyDown') return
      setTimeout(() => reportVim(tab), 0)
      const command = process.platform === 'darwin' ? input.meta : input.control
      if (!command) return
      const win = deps.window()
      if (win === null) return
      const lease = tab.shownLease
      const attachment = tab.attachment
      const live = (): boolean =>
        isPresented(tab) &&
        tab.shownLease === lease &&
        tab.attachment === attachment &&
        deps.window() === win
      const key = input.key.toLowerCase()
      if (PAGE_KEYS.has(key) && !input.alt) return
      event.preventDefault()
      if (key === 'l') {
        if (live()) deps.address(tab.id, live)
        return
      }
      if (key === 'r') return void wc.reload()
      if (key === '[') return void wc.navigationHistory.goBack()
      if (key === ']') return void wc.navigationHistory.goForward()
      if (!live()) return
      win.webContents.focus()
      deps.key(
        tab.id,
        {
          key: input.key,
          code: input.code,
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
        },
        live,
      )
    })
  }

  async function open({
    url,
    id,
    reveal,
    attachment,
  }: {
    url?: string
    id?: string
    reveal: boolean
    attachment?: () => boolean
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
      shownLease: null,
      attachment: null,
      attachmentId: null,
      menu: null,
      vimNonce: null,
      vimGeneration: 0,
      vimRevision: 0,
      vimRequestOwner: null,
      vimRequestRevision: 0,
      vimModeSequence: 0,
      vimPoll: null,
      vimLastSnapshot: null,
      vimNavigationPending: false,
      hintRequest: 0,
      hintOwner: null,
      hintPendingOwner: null,
      hintRequestOrigin: null,
      hintRequestCapture: null,
      hintCaptureOwner: null,
      hintRetiredCapture: null,
      hintPendingKeys: new Map(),
      hintRevision: 0,
      hintSnapshot: 0,
      hintGeometry: 0,
      hintDraining: false,
      hintClosed: false,
      hintZoom: 1,
    }
    tabs.set(tab.id, tab)
    current = tab.id
    watch(tab)
    changed()
    if (reveal && deps.window() !== null)
      deps.reveal(tab.id, () => isLive(tab) && (attachment === undefined || attachment()))
    return url === undefined ? info(tab) : load(tab, url)
  }

  function hide(tab: Tab): void {
    const win = tab.shownIn
    revokeHints(tab)
    tab.shownIn = null
    tab.shownLease = null
    tab.attachment = null
    tab.attachmentId = null
    tab.vimLastSnapshot = null
    if (tab.vimPoll !== null) clearInterval(tab.vimPoll)
    tab.vimPoll = null
    tab.vimRevision++
    if (tab.vimNonce !== null && !tab.view.webContents.isDestroyed()) {
      void inPage<boolean>(
        tab,
        `__holiPage.vim.configure(false, ${tab.vimRevision}, ${JSON.stringify(tab.vimNonce)})`,
      ).catch(() => {})
    }
    tab.menu?.closePopup()
    tab.menu = null
    if (win !== null && !win.isDestroyed()) win.contentView.removeChildView(tab.view)
  }

  function onScreen(tab: Tab): boolean {
    return isPresented(tab) && tab.shownIn !== null && tab.shownIn.isVisible()
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

  const offDisplay = deps.onDisplayChange?.(() => {
    // A returning vault must receive fresh renderer placement messages.
    for (const tab of tabs.values()) hide(tab)
  })

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

    placementGuard,

    configureVim,
    discoverHints,
    presentHints,
    clearHints,
    activateHint,

    place(id, rect) {
      const tab = tabs.get(id)
      if (tab === undefined) return
      if (disposed) return
      const win = deps.window()
      if (rect === null || win === null || rect.width < 1 || rect.height < 1) return hide(tab)
      const presentation = deps.presentationLease?.() ?? (() => true)
      if (!presentation()) return hide(tab)
      if (tab.shownIn !== win || tab.shownLease?.() !== true) {
        hide(tab)
        win.contentView.addChildView(tab.view)
        tab.shownIn = win
        tab.shownLease = presentation
        tab.attachment = Symbol(id)
        tab.attachmentId = randomUUID()
        tab.hintRequest = 0
        tab.hintSnapshot = 0
        tab.hintRevision = 0
        tab.hintClosed = false
        tab.hintRequestOrigin = null
        tab.hintRetiredCapture = null
        tab.hintPendingOwner = null
        tab.vimLastSnapshot = null
        tab.vimPoll = setInterval(() => reportVim(tab), 250)
        // The tab the person brings up is the one "the page" means.
        current = id
      }
      const zoom = win.webContents.getZoomFactor()
      const nextBounds = {
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
      }
      const previousBounds = tab.view.getBounds()
      if (
        tab.hintZoom !== zoom ||
        previousBounds.x !== nextBounds.x ||
        previousBounds.y !== nextBounds.y ||
        previousBounds.width !== nextBounds.width ||
        previousBounds.height !== nextBounds.height
      )
        revokeHints(tab)
      tab.view.setBounds({
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
      })
      reportVim(tab)
    },

    dispose() {
      if (disposed) return
      disposed = true
      offDisplay?.()
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
