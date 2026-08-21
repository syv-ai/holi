/**
 * Daily notes, renderer side — path-based, personal-gated, offline-complete.
 *
 * The correctness boundary is no longer a server's unique index (D45, gone): the
 * main proc does a deterministic if-not-exists-write, so two of your devices
 * mint an identical blob at an identical path and git merges them silently. All
 * this layer does is decide *whether* to ask (personal vaults only) and land you
 * on the result.
 */
import { atom } from 'jotai'
import { dailyNoteFilename } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { openPinned, workspaceAtom } from './panes'
import { todayAtom } from './tasks'
import { activeDocAtom, activeRemoteAtom, loadSnapshotAtom, snapshotAtom } from './vaults'

/**
 * A vault is personal unless we positively know it has more than one GitHub
 * collaborator (`daily-notes.md` OQ#2, resolved). Checked via `github.collaborators`
 * when online; any failure — offline, signed out — defaults to **personal**, the
 * common case and the one that keeps daily notes working on a plane. Auto-creating
 * a daily in a *shared* vault is the harm this guards against, and that only
 * happens on a positive >1 answer.
 */
export async function isPersonalVault(remote: string): Promise<boolean> {
  try {
    const { collaborators } = await trpc.github.collaborators.query({ remote })
    return collaborators.length <= 1
  } catch {
    return true
  }
}

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
 * Returns the path, or null when there is nothing to do (no vault, or a shared
 * one). Opens the note **pinned** — you are here to write in it, not browse it.
 */
export const openTodaysDailyAtom = atom(null, async (get, set): Promise<string | null> => {
  const remote = get(activeRemoteAtom)
  if (!remote) return null
  if (!(await isPersonalVault(remote))) return null

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
 * No-op on shared vaults and when nothing changed.
 */
export const sweepDailyAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  if (!(await isPersonalVault(remote))) return
  const { archived, deleted } = await trpc.notes.sweepDaily.mutate({ remote })
  if (archived > 0 || deleted > 0) {
    await set(loadSnapshotAtom)
    await trpc.sync.commitNow.mutate()
  }
})
