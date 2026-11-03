/**
 * Opening a surface by name, and closing the tabs of surfaces that are gone
 * (docs/features/tabs-panes.md). The registry itself is `state/plugins.ts`.
 */
import { atom, type Atom } from 'jotai'
import { tabForPath } from '@/state/folder-documents'
import { openHomeAtom } from './home'
import { openTabAtom, shellWorkspaceAtom, updateWorkspaceAtom, workspaceOfAtom } from './shell-tabs'
import { allTabs, closeTab as closeShellTab, closeTabsWhere, focusedTab } from './shell-workspace'
import {
  parseTabKey,
  tabForPath as shellTabForPath,
  tabKey,
  type TabDescriptor,
} from './tab-descriptor'
import type { Tab } from '@/lib/tab'
import { folderClaimsAtom } from './plugins'
import { activeRemoteAtom, snapshotAtom } from './vaults'

/**
 * Open a surface, or focus its tab. Home is the one surface that goes through
 * its setting: the nav's Home, "Go home" and an app's `holi.open('home')` all
 * land wherever `home` says.
 */
export const openSurfaceAtom = atom(null, (_get, set, surface: string, id?: string): void => {
  if (surface === 'home') return void set(openHomeAtom)
  // A vault app opens by its bundle, any other surface by name.
  set(openTabAtom, shellSurfaceTab(surface, id))
})

/** The shell tab a surface opens as. */
function shellSurfaceTab(surface: string, id?: string): TabDescriptor {
  if (surface === 'app' && id !== undefined) return { kind: 'vault-app', path: id }
  return id === undefined ? { kind: 'surface', surface } : { kind: 'surface', surface, id }
}

/** The id a shell tab has as one of `surface`'s tabs, or null when it is not
 *  one: a vault app's tab is the `app` surface's, by its bundle. */
function surfaceIdOf(key: string, surface: string): string | null {
  const tab = parseTabKey(key)
  if (tab?.kind === 'surface') return tab.surface === surface ? (tab.id ?? null) : null
  return surface === 'app' && tab?.kind === 'vault-app' ? tab.path : null
}

/** Close the tab onto `surface` with `id`, wherever it is in the strip: an
 *  app's "close tab" once its bundle is gone. */
export const closeSurfaceTabAtom = atom(null, (_get, set, surface: string, id: string): void => {
  set(shellWorkspaceAtom, (ws) => closeShellTab(ws, tabKey(shellSurfaceTab(surface, id))))
})

/** Close every tab of `surface` whose id is not in `keep`: a plugin's tabs
 *  onto things that are gone. `remote` is the vault whose tabs they are, the
 *  open one when not given: a plugin passes its own, so an answer that lands
 *  as the vault switches closes nothing of the next vault's. */
export const closeSurfaceTabsAtom = atom(
  null,
  (get, set, surface: string, keep: readonly string[], remote?: string): void => {
    const gone = (key: string) => {
      const id = surfaceIdOf(key, surface)
      return id !== null && !keep.includes(id)
    }
    set(updateWorkspaceAtom, remote ?? get(activeRemoteAtom) ?? '', (ws) =>
      allTabs(ws).some(gone) ? closeTabsWhere(ws, gone) : ws,
    )
  },
)

const tabIdAtoms = new Map<string, Atom<readonly string[]>>()

/** The ids of every open tab of `surface`, read-only: a plugin watches it to
 *  learn that one of its tabs closed. `remote` is the vault whose strip it
 *  reads, the open one when not given; a plugin watching for closes passes
 *  its own, since the strip changes with the vault before the plugin's
 *  `vault()` is torn down. The same atom for the same surface and remote. */
export function surfaceTabIdsAtom(surface: string, remote?: string): Atom<readonly string[]> {
  const cacheKey = remote === undefined ? surface : `${surface}\u0000${remote}`
  let made = tabIdAtoms.get(cacheKey)
  if (made === undefined) {
    let last: readonly string[] = []
    made = atom((get) => {
      const ws = remote === undefined ? get(shellWorkspaceAtom) : get(workspaceOfAtom)(remote)
      const next = allTabs(ws).flatMap((key) => {
        const id = surfaceIdOf(key, surface)
        return id === null ? [] : [id]
      })
      // The same array while the ids are the same, so a watcher hears changes.
      if (next.length !== last.length || next.some((id, i) => id !== last[i])) last = next
      return last
    })
    tabIdAtoms.set(cacheKey, made)
  }
  return made
}

const activeIdAtoms = new Map<string, Atom<string | null>>()

/** The id of the focused tab (the active tab, or the active split's focused
 *  member) when it is one of `surface`'s, else null. The same atom for the
 *  same surface. */
export function activeSurfaceIdAtom(surface: string): Atom<string | null> {
  let made = activeIdAtoms.get(surface)
  if (made === undefined) {
    made = atom((get) => {
      const key = focusedTab(get(shellWorkspaceAtom))
      return key === null ? null : surfaceIdOf(key, surface)
    })
    activeIdAtoms.set(surface, made)
  }
  return made
}

/** The tab a vault path opens as: a folder document's surface tab (a vault
 *  app), or a note tab.
 *
 * @public
 */
export const tabForPathAtom = atom((get): ((path: string) => Tab) => {
  const claims = get(folderClaimsAtom)
  const snapshot = get(snapshotAtom)
  const paths = new Set([...snapshot.docs, ...snapshot.files].map((f) => f.path))
  return (path) => tabForPath(claims, path, (p) => paths.has(p))
})

/** The shell tab a vault path opens as: a plugin's folder document (a
 *  community plugin's deck) as its surface, a vault app as its app, anything
 *  else as the document. A vault app keeps its own tab kind, which draws its
 *  header around the surface. */
export const shellTabForPathAtom = atom((get): ((path: string) => TabDescriptor) => {
  const toTab = get(tabForPathAtom)
  return (path) => {
    const tab = toTab(path)
    return tab.kind === 'surface' && tab.surface !== 'app' && tab.id !== undefined
      ? { kind: 'surface', surface: tab.surface, id: tab.id }
      : shellTabForPath(path)
  }
})

/**
 * Open a vault path as the tab it is (`shellTabForPathAtom`): `pane` opens it
 * in split view beside the focused tab; `preview` and `pinned` both open it as
 * its own tab, since the shell's tabs have no preview state.
 */
export const openPathAtom = atom(
  null,
  (get, set, path: string, how: 'preview' | 'pinned' | 'pane' = 'pinned'): void => {
    set(openTabAtom, get(shellTabForPathAtom)(path), { beside: how === 'pane' })
  },
)
