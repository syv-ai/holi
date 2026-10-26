/**
 * The browser's tabs as the window knows them (docs/features/browser.md):
 * main's list, kept in step by its `tabs` event, and how each tab looks in
 * the tab strip.
 *
 * A page lives in main for as long as its vault is open. A tab is the
 * shell's, and outlives a restart: the address each page last showed is
 * remembered on this machine, so a tab Holi had before is opened again at
 * it rather than left empty.
 */
import { atom } from 'jotai'
import { GlobeIcon } from 'lucide-react'
import {
  activeRemoteAtom,
  capClient,
  closeSurfaceTabsAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
  type Command,
  type CommandMenuEntry,
  type PluginEventHandler,
  type PluginStore,
  type SurfaceTabLook,
} from '@/plugin-api'
import type { browserCapabilities } from '../main/capabilities'
import { pageLabel, type PageInfo } from '../shared/page'

export const BROWSER = 'browser'
export const BROWSER_SURFACE = 'browser'

export const browserCap = capClient<ReturnType<typeof browserCapabilities>>(BROWSER)

/** Every page main has open in this vault. */
export const pagesAtom = atom<readonly PageInfo[]>([])

/** A tab asked for its address bar (⌘L in its page), counted so asking
 *  twice asks twice. */
export const addressAskAtom = atom<{ id: string; n: number } | null>(null)

export const tabLooksAtom = atom((get): readonly SurfaceTabLook[] =>
  get(pagesAtom).map((p) => ({
    id: p.id,
    label: pageLabel(p),
    ...(p.url === '' ? {} : { tooltip: p.url }),
  })),
)

const SAVED = 'holi.browser.addresses'

/** Each tab's last address, by id. Empty when storage cannot be read. */
function savedAddresses(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function saveAddresses(addresses: Record<string, string>): void {
  try {
    localStorage.setItem(SAVED, JSON.stringify(addresses))
  } catch {
    // A convenience: the next restart opens a blank tab instead.
  }
}

/** A new tab, opened in the active pane. */
const newPageAtom = atom(null, async (get, set, url?: string): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const page = await browserCap.open(remote, { shown: true, ...(url === undefined ? {} : { url }) })
  set(openSurfaceAtom, BROWSER_SURFACE, page.id)
})

export const BROWSER_COMMANDS: readonly Command[] = [
  { id: 'browser.new', label: 'New browser tab', run: (_get, set) => void set(newPageAtom) },
]

export const browserMenuEntriesAtom = atom((): readonly CommandMenuEntry[] => [
  {
    id: 'new',
    label: 'New Browser Tab',
    group: 'action',
    icon: GlobeIcon,
    keywords: ['web', 'browse', 'url', 'website'],
  },
])

export const runBrowserMenuEntryAtom = atom(null, (_get, set, id: string): void => {
  if (id === 'new') void set(newPageAtom)
})

/** A shortcut of Holi's pressed while a page had the keyboard, pressed
 *  again in Holi's window. */
function replayKey(payload: unknown): void {
  const k = payload as Partial<
    Record<'key' | 'code', string> & Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>
  >
  if (typeof k.key !== 'string') return
  const event = new KeyboardEvent('keydown', {
    key: k.key,
    code: k.code ?? '',
    metaKey: k.meta === true,
    ctrlKey: k.ctrl === true,
    shiftKey: k.shift === true,
    altKey: k.alt === true,
    bubbles: true,
    cancelable: true,
  })
  ;(document.activeElement ?? document.body).dispatchEvent(event)
}

let asks = 0

export const browserEvents: Readonly<Record<string, PluginEventHandler>> = {
  tabs: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) store.set(pagesAtom, payload as PageInfo[])
  },
  // A page the agent opened, or one a page opened: shown where the person is.
  reveal: ({ remote, payload }, store) => {
    const id = (payload as { id?: unknown }).id
    if (remote === store.get(activeRemoteAtom) && typeof id === 'string') {
      store.set(openSurfaceAtom, BROWSER_SURFACE, id)
    }
  },
  address: ({ remote, payload }, store) => {
    const id = (payload as { id?: unknown }).id
    if (remote === store.get(activeRemoteAtom) && typeof id === 'string') {
      store.set(addressAskAtom, { id, n: ++asks })
    }
  },
  key: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) replayKey(payload)
  },
}

/**
 * The browser while `remote` is open: fill the list, open again at its last
 * address each tab the shell kept from before (closing one with none), close
 * a page whose tab closed and a tab whose page closed, and remember where
 * each page is.
 */
export function browserVault(remote: string, store: PluginStore): () => void {
  const tabs = surfaceTabIdsAtom(BROWSER_SURFACE)
  const asked = store.get(pagesAtom)
  let stopped = false

  void browserCap.tabs(remote).then(async (list) => {
    if (stopped) return
    if (store.get(pagesAtom) === asked) store.set(pagesAtom, list)
    const live = new Set(list.map((p) => p.id))
    const saved = savedAddresses()
    const kept = store.get(tabs).filter((id) => !live.has(id))
    const reopened = await Promise.all(
      kept.map(async (id) => {
        const url = saved[id]
        if (url === undefined) return null
        try {
          return (await browserCap.open(remote, { reopen: id, url, shown: true })).id
        } catch {
          return null
        }
      }),
    )
    if (stopped) return
    const lost = kept.filter((id, i) => reopened[i] === null)
    if (lost.length > 0) {
      store.set(
        closeSurfaceTabsAtom,
        BROWSER_SURFACE,
        store.get(tabs).filter((id) => !lost.includes(id)),
      )
    }
  })

  // A page that left main's list (`holi browser close`) takes its tabs.
  // Diffed, so a tab still being opened again is not closed.
  let pages = new Set(store.get(pagesAtom).map((p) => p.id))
  const offPages = store.sub(pagesAtom, () => {
    const list = store.get(pagesAtom)
    const now = new Set(list.map((p) => p.id))
    const gone = [...pages].filter((id) => !now.has(id))
    pages = now
    if (gone.length > 0) {
      store.set(
        closeSurfaceTabsAtom,
        BROWSER_SURFACE,
        store.get(tabs).filter((id) => !gone.includes(id)),
      )
    }
    const saved = savedAddresses()
    for (const p of list) if (p.url !== '') saved[p.id] = p.url
    for (const id of gone) delete saved[id]
    saveAddresses(saved)
  })

  // Closing the last tab onto a page closes the page. Diffed across each
  // change, so a tab moved between panes is not a close.
  let open = new Set(store.get(tabs))
  const offTabs = store.sub(tabs, () => {
    const now = new Set(store.get(tabs))
    for (const id of open)
      if (!now.has(id)) void browserCap.close(remote, { tab: id }).catch(() => {})
    open = now
  })

  return () => {
    stopped = true
    offPages()
    offTabs()
    store.set(pagesAtom, [])
  }
}
