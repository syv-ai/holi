/**
 * Going Home: the vault's `home` setting, opened.
 *
 * One atom for every way there: the vault opening, the nav's Home, "Go home",
 * and an app's `holi.open('home')`. The recents or a folder document (a vault
 * app) are shown in the Home tab; another view or a file opens as itself, the tab it would be
 * anyway; a target that is not there opens the Home tab to say so. The decision is `lib/home-target.ts`.
 */
import { atom, type Getter } from 'jotai'
import type { Surface } from '@/state/plugin-types'
import { folderDocumentAt } from '@/state/folder-documents'
import { resolveHome } from '../lib/home-target'
import { ensureTodaysDailyAtom } from './daily'
import { openPinned, openSurface, workspaceAtom } from './panes'
import { folderClaimsAtom, surfacesAtom } from './plugins'
import { loadVaultSettingsAtom } from './settings'
import { activeDocAtom, snapshotAtom } from './vaults'

/** The surface the directory at `path` opens in, when it is a finished
 *  folder document (a vault app) in the vault as scanned. */
function documentSurfaceOf(get: Getter): (path: string) => string | null {
  const snapshot = get(snapshotAtom)
  const paths = new Set([...snapshot.docs, ...snapshot.files].map((f) => f.path))
  const claims = get(folderClaimsAtom)
  return (path) => {
    const doc = folderDocumentAt(claims, path, (p) => paths.has(p))
    return doc !== null && doc.ready ? doc.folder.surface : null
  }
}

/** The surfaces that may be Home, by kind. */
function homeableKinds(surfaces: ReadonlyMap<string, Surface>): ReadonlySet<string> {
  return new Set([...surfaces.values()].filter((s) => s.homeable === true).map((s) => s.kind))
}

export const openHomeAtom = atom(null, async (get, set): Promise<void> => {
  const settings = await set(loadVaultSettingsAtom)
  if (settings === null) return
  const snapshot = get(snapshotAtom)
  const home = resolveHome(settings, {
    filePaths: new Set([...snapshot.docs, ...snapshot.files].map((f) => f.path)),
    homeable: homeableKinds(get(surfacesAtom)),
    documentSurface: documentSurfaceOf(get),
  })

  /** A note, pinned, with the active doc following, as opening one anywhere does. */
  const openNote = (path: string) => {
    set(workspaceAtom, openPinned(get(workspaceAtom), path))
    set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
  }

  if (home.reach !== 'open') {
    set(workspaceAtom, openSurface(get(workspaceAtom), 'home'))
    return
  }
  const { target } = home
  switch (target.kind) {
    case 'daily': {
      const path = await set(ensureTodaysDailyAtom)
      if (path !== null) openNote(path)
      return
    }
    case 'file':
      openNote(target.path)
      return
    case 'surface':
      set(workspaceAtom, openSurface(get(workspaceAtom), target.surface))
  }
})
