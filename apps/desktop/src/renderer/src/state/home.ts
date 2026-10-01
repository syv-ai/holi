/**
 * Going Home: the vault's `home` setting, opened.
 *
 * One atom for every way there: the vault opening, the nav's Home, "Go home",
 * and an app's `holi.open('home')`. The recents or an app are shown in the
 * Home tab; another view or a file opens as itself, the tab it would be
 * anyway; a target that is not there opens the Home tab to say so. The decision is `lib/home-target.ts`.
 */
import { atom } from 'jotai'
import { homeTargetOf, VAULT_SETTING_DEFAULTS, type HomeTarget } from '@holi/shared'
import { resolveHome } from '../lib/home-target'
import { appPathsAtom } from './apps'
import { ensureTodaysDailyAtom } from './daily'
import { openPinned, openSingleton, workspaceAtom } from './panes'
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

export const openHomeAtom = atom(null, async (get, set): Promise<void> => {
  const settings = await set(loadVaultSettingsAtom)
  if (settings === null) return
  const snapshot = get(snapshotAtom)
  const home = resolveHome(settings, {
    filePaths: new Set([...snapshot.docs, ...snapshot.files].map((f) => f.path)),
    appPaths: new Set(get(appPathsAtom)),
  })

  /** A note, pinned, with the active doc following, as opening one anywhere does. */
  const openNote = (path: string) => {
    set(workspaceAtom, openPinned(get(workspaceAtom), path))
    set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
  }

  if (home.reach !== 'open') {
    set(workspaceAtom, openSingleton(get(workspaceAtom), 'home'))
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
    default:
      set(workspaceAtom, openSingleton(get(workspaceAtom), target.kind))
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
