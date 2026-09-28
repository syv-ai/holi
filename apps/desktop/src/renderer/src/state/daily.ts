/**
 * Daily notes, renderer side (`docs/features/daily-notes.md`).
 *
 * Main does a deterministic if-not-exists-write, so two of your devices mint an
 * identical blob at an identical path and git merges them silently.
 *
 * This layer is the *mechanism* only: mint today's daily and land on it.
 * **Whether** to is `dailyNotes` in the vault's settings, asked by
 * `state/landing.ts`, which is what lets ⌘⇧D still mint one on demand in a
 * vault that keeps no daily notes automatically.
 */
import { atom } from 'jotai'
import { dailyNoteFilename } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { openPinned, workspaceAtom } from './panes'
import { todayAtom } from './clock'
import { loadVaultSettingsAtom } from './settings'
import { activeDocAtom, activeRemoteAtom, loadSnapshotAtom, snapshotAtom } from './vaults'

/**
 * The path today's daily note *would* have, whether or not it exists.
 *
 * A path rather than a lookup: the file tree marks the row that matches, so an
 * absent daily simply marks nothing. `todayAtom` is the client's own local date.
 */
export const todayDailyPathAtom = atom((get) => dailyNoteFilename(get(todayAtom)))

/**
 * Mint today's daily if it is not there yet, and say where it is. Lands on
 * nothing: that is the caller's business.
 *
 * **Split from the landing on purpose.** Minting is a property of `dailyNotes`,
 * and `landing` only decides what you are looking at. Folded together, a vault
 * that lands on its board would quietly stop journalling.
 */
export const ensureTodaysDailyAtom = atom(null, async (get, set): Promise<string | null> => {
  const remote = get(activeRemoteAtom)
  if (!remote) return null
  const { path, created } = await trpc.notes.getOrCreateDaily.mutate({ remote })
  if (created) await set(loadSnapshotAtom)
  return path
})

/**
 * Get-or-create today's daily for the active vault and land on it.
 * Returns the path, or null when there is no active vault. Opens the note
 * **pinned**: you are here to write in it, not browse it.
 *
 * **Unconditional.** The policy lives one layer up, in `landing`; anything
 * calling this is asking for today's note on purpose.
 */
export const openTodaysDailyAtom = atom(null, async (get, set): Promise<string | null> => {
  const path = await set(ensureTodaysDailyAtom)
  if (path === null) return null
  set(workspaceAtom, openPinned(get(workspaceAtom), path))
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
  return path
})

/**
 * Archive prior-day notes + GC stubs, then commit once. The sweep is the one
 * place a background process rewrites the vault's shape, so it lands as a
 * single deliberate commit rather than scattered autosaves.
 *
 * No-op when the vault keeps no daily notes, and when nothing changed: the
 * archiving stops with the minting, and resumes if the setting is turned back on.
 */
export const sweepDailyAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  // Cached by the landing that ran immediately before this on the launch path,
  // so the pair costs one read rather than two.
  const settings = await set(loadVaultSettingsAtom)
  if (settings?.dailyNotes !== true) return
  const { archived, deleted } = await trpc.notes.sweepDaily.mutate({ remote })
  if (archived > 0 || deleted > 0) {
    await set(loadSnapshotAtom)
    await trpc.sync.commitNow.mutate()
  }
})
