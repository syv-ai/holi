/**
 * Opening a surface by name, and closing the tabs of surfaces that are gone
 * (docs/features/tabs-panes.md). The registry itself is `state/plugins.ts`.
 */
import { atom, useAtomValue, useSetAtom, type Atom } from 'jotai'
import { useEffect } from 'react'
import { tabForPath } from '@/lib/folder-documents'
import { openHomeAtom } from './home'
import {
  activeTab,
  closeSurfaceTabs,
  closeSurfaceTabsExcept,
  closeTab,
  openInNewPane,
  openPinned,
  openPreview,
  openSurface,
  openTab,
  surfaceTabIds,
  workspaceAtom,
  type Tab,
} from './panes'
import { folderClaimsAtom, surfacesAtom } from './plugins'
import { snapshotAtom } from './vaults'

/**
 * Open a surface, or focus its tab. Home is the one surface that goes through
 * its setting: the nav's Home, "Go home" and an app's `holi.open('home')` all
 * land wherever `home` says.
 */
export const openSurfaceAtom = atom(null, (_get, set, surface: string, id?: string): void => {
  if (surface === 'home') void set(openHomeAtom)
  else set(workspaceAtom, (w) => openSurface(w, surface, id))
})

/** Close the active pane's tab onto `surface` with `id`, if it has one: an
 *  app's "close tab" once its bundle is gone. */
export const closeSurfaceTabAtom = atom(null, (_get, set, surface: string, id: string): void => {
  set(workspaceAtom, (w) => {
    const pane = w.panes[w.active]
    if (pane === undefined) return w
    const index = pane.tabs.findIndex(
      (t) => t.kind === 'surface' && t.surface === surface && t.id === id,
    )
    return index === -1 ? w : closeTab(w, index)
  })
})

/** Close every tab of `surface` whose id is not in `keep`, in every pane: a
 *  plugin's tabs onto things that are gone. */
export const closeSurfaceTabsAtom = atom(
  null,
  (_get, set, surface: string, keep: readonly string[]): void => {
    set(workspaceAtom, (w) => closeSurfaceTabsExcept(w, surface, keep))
  },
)

const tabIdAtoms = new Map<string, Atom<readonly string[]>>()

/** The ids of every open tab of `surface`, read-only: a plugin watches it to
 *  learn that one of its tabs closed. The same atom for the same surface. */
export function surfaceTabIdsAtom(surface: string): Atom<readonly string[]> {
  let made = tabIdAtoms.get(surface)
  if (made === undefined) {
    let last: readonly string[] = []
    made = atom((get) => {
      const next = surfaceTabIds(get(workspaceAtom), surface)
      // The same array while the ids are the same, so a watcher hears changes.
      if (next.length !== last.length || next.some((id, i) => id !== last[i])) last = next
      return last
    })
    tabIdAtoms.set(surface, made)
  }
  return made
}

const activeIdAtoms = new Map<string, Atom<string | null>>()

/** The id of the active tab when it is one of `surface`'s, else null. The
 *  same atom for the same surface. */
export function activeSurfaceIdAtom(surface: string): Atom<string | null> {
  let made = activeIdAtoms.get(surface)
  if (made === undefined) {
    made = atom((get) => {
      const tab = activeTab(get(workspaceAtom))
      return tab?.kind === 'surface' && tab.surface === surface ? (tab.id ?? null) : null
    })
    activeIdAtoms.set(surface, made)
  }
  return made
}

/** A surface's tabs close when it leaves the registry, as when its plugin is
 *  turned off. Mounted once, in the shell. */
export function useSurfaceTabs(): void {
  const surfaces = useAtomValue(surfacesAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  useEffect(() => {
    const live = new Set(surfaces.keys())
    setWorkspace((w) => closeSurfaceTabs(w, live))
  }, [surfaces, setWorkspace])
}

/** The tab a vault path opens as: a folder document's surface tab (a vault
 *  app), or a note tab. */
export const tabForPathAtom = atom((get): ((path: string) => Tab) => {
  const claims = get(folderClaimsAtom)
  const snapshot = get(snapshotAtom)
  const paths = new Set([...snapshot.docs, ...snapshot.files].map((f) => f.path))
  return (path) => tabForPath(claims, path, (p) => paths.has(p))
})

/**
 * Open a vault path by any gesture: a single click's `preview`, a double
 * click's `pinned`, or `pane`, beside the active one. A folder document opens
 * as its surface, which has no preview state.
 */
export const openPathAtom = atom(
  null,
  (get, set, path: string, how: 'preview' | 'pinned' | 'pane' = 'pinned'): void => {
    const tab = get(tabForPathAtom)(path)
    set(workspaceAtom, (w) =>
      how === 'pane'
        ? openInNewPane(w, tab)
        : tab.kind !== 'note'
          ? openTab(w, tab)
          : how === 'preview'
            ? openPreview(w, path)
            : openPinned(w, path),
    )
  },
)
