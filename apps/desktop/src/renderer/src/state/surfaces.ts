/**
 * Opening a surface by name, and closing the tabs of surfaces that are gone
 * (docs/features/tabs-panes.md). The registry itself is `state/plugins.ts`.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { openHomeAtom } from './home'
import { closeSurfaceTabs, openSurface, workspaceAtom } from './panes'
import { surfacesAtom } from './plugins'

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
