/**
 * Daily notes, renderer side — path-based, personal-gated, offline-complete.
 *
 * The correctness boundary is no longer a server's unique index (D45, gone): the
 * main proc does a deterministic if-not-exists-write, so two of your devices
 * mint an identical blob at an identical path and git merges them silently.
 *
 * This layer is now the *mechanism* only: mint today's daily and land on it.
 * **Whether** to is `dailyNotes` in the vault's settings, and it is asked by
 * `state/landing.ts` — which is what lets ⌘⇧D still mint one on demand in a
 * vault that keeps no daily notes automatically.
 */
import { atom } from 'jotai'
import { dailyNoteFilename } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { openPinned, workspaceAtom } from './panes'
import { todayAtom } from './tasks'
import { loadVaultSettingsAtom } from './settings'
import { activeDocAtom, activeRemoteAtom, loadSnapshotAtom, snapshotAtom } from './vaults'


/**
 * The path today's daily note *would* have, whether or not it exists.
 *
 * A path rather than a lookup: the file tree marks the row that matches, so an
 * absent daily simply marks nothing — which is the honest rendering in a shared
 * vault, where there is never one (§Daily notes are personal-vault-only).
 * `todayAtom` is the client's own local date, because nothing else computes
 * "today" (`prd/daily-notes.md`).
 */
export const todayDailyPathAtom = atom((get) => dailyNoteFilename(get(todayAtom)))

/**
 * Get-or-create today's daily for the active vault and land on it (FR-4).
 * Returns the path, or null when there is no active vault. Opens the note
 * **pinned** — you are here to write in it, not browse it.
 *
 * **Unconditional.** It used to refuse in a shared vault, which meant ⌘⇧D was
 * silently dead there; the policy now lives one layer up, so this is the verb
 * and `landing` decides when to say it. Anything calling this is asking for
 * today's note on purpose.
 */
export const openTodaysDailyAtom = atom(null, async (get, set): Promise<string | null> => {
  const remote = get(activeRemoteAtom)
  if (!remote) return null

  const { path, created } = await trpc.notes.getOrCreateDaily.mutate({ remote })
  if (created) await set(loadSnapshotAtom)
  set(workspaceAtom, openPinned(get(workspaceAtom), path))
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
  return path
})

/**
 * Archive prior-day notes + GC stubs (FR-5), then commit — once. The sweep is
 * the one place a background process rewrites the vault's shape, so it lands as
 * a single deliberate commit rather than scattered autosaves (§Archiving).
 *
 * No-op when the vault keeps no daily notes, and when nothing changed. Off means
 * "stop doing this behind my back", so the archiving stops with the minting —
 * and resumes where it left off if the setting is turned back on.
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
