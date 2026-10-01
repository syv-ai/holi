/**
 * Opening a surface by name, and closing the tabs of surfaces that are gone
 * (docs/features/tabs-panes.md). The registry itself is `state/plugins.ts`.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { tabForPath } from '@/lib/folder-documents'
import { openHomeAtom } from './home'
import {
  closeSurfaceTabs,
  openInNewPane,
  openPinned,
  openPreview,
  openSurface,
  openTab,
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
