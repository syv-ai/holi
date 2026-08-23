/**
 * What a vault opens on.
 *
 * One effect in `Shell` opens the vault and then calls this, once per remote.
 * Before `landing` existed the answer was always "today's daily, unless the
 * vault is shared, in which case nothing" — a rule nobody chose, which fell out
 * of daily notes being the only thing that auto-opened.
 *
 * The decision itself is `lib/landing-target.ts`, pure and tested on plain
 * values. This atom is the two things that cannot be pure: reading the settings,
 * and calling the right opener. If it grows a third responsibility, that one
 * belongs in the lib.
 */
import { atom } from 'jotai'
import { resolveLanding } from '../lib/landing-target'
import { ensureTodaysDailyAtom } from './daily'
import { appIdsAtom } from './apps'
import { openApp, openPinned, openSingleton, workspaceAtom } from './panes'
import { loadVaultSettingsAtom } from './settings'
import { activeDocAtom, snapshotAtom } from './vaults'

/**
 * Land on whatever this vault opens on — a note, an app, one of the singleton
 * surfaces, today's daily, or nothing at all.
 *
 * "Nothing at all" is a real answer, not a failure: one empty pane, which is
 * what a vault that keeps no daily notes and names no landing target should do.
 *
 * Never throws. A vault whose settings cannot be read resolves to the defaults
 * in main, so the worst case here is the behaviour Holi always had.
 */
export const openLandingAtom = atom(null, async (get, set): Promise<void> => {
  const settings = await set(loadVaultSettingsAtom)
  if (settings === null) return

  // FR-4: a vault that keeps daily notes keeps them whether or not you open on
  // one. Minting is `dailyNotes`; `landing` only decides what you are looking
  // at. It runs BEFORE the target is resolved so the snapshot already holds
  // today's file — a landing that names the daily by path would otherwise read
  // as rotted on the one morning it was minted.
  const dailyPath = settings.dailyNotes ? await set(ensureTodaysDailyAtom) : null

  const target = resolveLanding(settings, {
    docPaths: new Set(get(snapshotAtom).docs.map((d) => d.path)),
    appIds: new Set(get(appIdsAtom)),
  })
  if (target === null) return

  /** Land on a note: pinned, and the active doc follows. Matches what opening a
   *  note anywhere else does — the editor reads the active doc, not the tab. */
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

    // The board, the agenda and mail. `openSingleton` inserts leftmost and
    // focuses in place if it is somehow already open, which is exactly what
    // clicking it in the nav rail does — landing on one is the same request.
    default:
      set(workspaceAtom, openSingleton(get(workspaceAtom), target.kind))
      return
  }
})
