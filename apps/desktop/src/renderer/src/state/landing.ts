/**
 * What a vault opens on.
 *
 * One effect in `Shell` opens the vault and then calls this, once per remote.
 * The decision itself is `lib/landing-target.ts`, pure and tested; this atom is
 * the two things that cannot be pure: reading the settings, and calling the
 * right opener.
 */
import { atom } from 'jotai'
import { resolveLanding } from '../lib/landing-target'
import { ensureTodaysDailyAtom } from './daily'
import { appIdsAtom } from './apps'
import { openApp, openPinned, openSingleton, workspaceAtom } from './panes'
import { loadVaultSettingsAtom } from './settings'
import { activeDocAtom, snapshotAtom } from './vaults'

/**
 * Land on whatever this vault opens on: a note, an app, one of the singleton
 * surfaces, today's daily, or nothing at all (one empty pane, a real answer).
 *
 * Never throws. A vault whose settings cannot be read resolves to the defaults
 * in main.
 */
export const openLandingAtom = atom(null, async (get, set): Promise<void> => {
  const settings = await set(loadVaultSettingsAtom)
  if (settings === null) return

  // A vault that keeps daily notes keeps them whether or not you open on one.
  // Minting runs BEFORE the target is resolved so the snapshot already holds
  // today's file; a landing that names the daily by path would otherwise read
  // as rotted on the morning it was minted.
  const dailyPath = settings.dailyNotes ? await set(ensureTodaysDailyAtom) : null

  const target = resolveLanding(settings, {
    docPaths: new Set(get(snapshotAtom).docs.map((d) => d.path)),
    appIds: new Set(get(appIdsAtom)),
  })
  if (target === null) return

  /** Land on a note: pinned, and the active doc follows, as opening a note
   *  anywhere else does. */
  const landOnNote = (path: string) => {
    set(workspaceAtom, openPinned(get(workspaceAtom), path))
    set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
  }

  switch (target.kind) {
    // Already minted above, so this is only the landing half.
    case 'daily':
      if (dailyPath !== null) landOnNote(dailyPath)
      return

    case 'note':
      landOnNote(target.path)
      return

    case 'app':
      set(workspaceAtom, openApp(get(workspaceAtom), target.appId))
      return

    // The singleton surfaces: the same request as clicking one in the nav rail.
    default:
      set(workspaceAtom, openSingleton(get(workspaceAtom), target.kind))
      return
  }
})
