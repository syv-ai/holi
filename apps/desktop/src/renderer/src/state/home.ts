/**
 * Going Home: the vault's `home` setting, opened.
 *
 * One atom for every way there: the vault opening, the nav's Home, "Go home",
 * and an app's `holi.open('home')`. The recents or a folder document (a vault
 * app) are shown in the Home tab; another view or a file opens as itself, the tab it would be
 * anyway; a target that is not there opens the Home tab to say so. The decision is `lib/home-target.ts`.
 */
import { atom, type Getter } from 'jotai'
import { homeTargetOf, VAULT_SETTING_DEFAULTS, type HomeTarget } from '@holi/shared'
import type { Surface } from '@/plugin-api/types'
import { folderDocumentAt, surfaceLabel } from '@/lib/folder-documents'
import { resolveHome } from '../lib/home-target'
import { ensureTodaysDailyAtom } from './daily'
import { openPinned, openSurface, workspaceAtom } from './panes'
import { folderClaimsAtom, railAtom, surfacesAtom } from './plugins'
import { loadVaultSettingsAtom, vaultSettingsAtom } from './settings'
import { activeDocAtom, activeRemoteAtom, snapshotAtom } from './vaults'

/** What Home is right now, from the cached settings (the default until they
 *  are read). The Home tab renders from this. */
export const homeTargetAtom = atom((get): HomeTarget => {
  const cached = get(vaultSettingsAtom)
  const home =
    cached !== null && cached.remote === get(activeRemoteAtom)
      ? cached.settings.home
      : VAULT_SETTING_DEFAULTS.home
  return homeTargetOf(home)
})

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

/** The folder document Home shows in its tab, when Home names one the vault
 *  has finished: the Home tab renders that surface with it. */
export const homeDocumentAtom = atom((get): { surface: string; id: string } | null => {
  const target = get(homeTargetAtom)
  if (target.kind !== 'file') return null
  const surface = documentSurfaceOf(get)(target.path)
  return surface === null ? null : { surface, id: target.path }
})

/** The folder documents Home may name, by name: every finished one (each
 *  vault app), from its surface's instances. `group` is the nav menu's word
 *  for that surface's instances ("Apps"), so the picker can section them. */
export const homeDocumentsAtom = atom((get): { path: string; label: string; group: string }[] => {
  const surfaces = get(surfacesAtom)
  const rail = get(railAtom)
  const kinds = new Set(get(folderClaimsAtom).map((c) => c.folder.surface))
  return [...kinds]
    .flatMap((kind) => {
      const surface = surfaces.get(kind)
      if (surface?.instances === undefined) return []
      const group = rail.find((r) => r.surface === kind)?.label ?? surfaceLabel(surface)
      return get(surface.instances).map((path) => ({
        path,
        label: surfaceLabel(surface, path),
        group,
      }))
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path))
})

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

/**
 * What a vault opens on: Home. A vault that keeps daily notes mints today's
 * first whatever Home is, so the note exists before anything opens.
 */
export const openLandingAtom = atom(null, async (get, set): Promise<void> => {
  const settings = await set(loadVaultSettingsAtom)
  if (settings === null) return
  // Home on the daily mints it on the way there.
  if (settings.dailyNotes && settings.home !== 'daily') await set(ensureTodaysDailyAtom)
  await set(openHomeAtom)
})
