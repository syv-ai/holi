/**
 * Version history — thin over a server that already had all of it.
 *
 * `snapshots.list/take/restore` have been built and tested since the CRDT slice, and
 * until now the only caller was main, taking one. Nobody could see the timeline, so
 * `agent.md`'s "before Claude edited" was a safety net you could not reach.
 *
 * History is **per-doc**: everything here keys off `activeDocAtom`, and opening a
 * different note clears the selection and the preview.
 */
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeDocAtom } from './vaults'

export interface Snapshot {
  id: string
  /** ISO string, NOT a Date: there is no superjson transformer on the ipcLink, so the
   * server's `Date` arrives serialized. `list` already orders newest-first — read it,
   * do not re-sort it, and this never has to be parsed. */
  takenAt: string
  reason: string | null
  label: string | null
  authorId: string | null
}

export const historyOpenAtom = atom(false)
export const snapshotsAtom = atom<Snapshot[]>([])
export const selectedSnapshotIdAtom = atom<string | null>(null)
export const previewAtom = atom<string | null>(null)
/** D54 is display-only: this reveals the folded rows, it does not change what exists. */
export const showAllVersionsAtom = atom(false)

// ------------------------------------------------------------------ reducers
// Pure, exported, and tested directly — the atoms are just where they live.

/**
 * Split the timeline into what someone did and what the clock did (D54).
 *
 * A doc touched all day mints an interval snapshot every 10 minutes, so within a week a
 * visible timeline is mostly unlabelled rows — and the `pre-agent-write` snapshot the
 * whole feature exists to surface is buried among them. The fix is display, not
 * deletion: retention is an open question in `prd/vaults-collaboration.md` and this
 * invents no answer to it. Nothing here deletes anything, and an automatic version is
 * restorable like any other.
 *
 * Splits on `reason`, not on a missing `label`: every writer except `interval` happens
 * to set a label today, so keying on that would be a coincidence rather than a rule.
 */
export function partitionSnapshots(rows: Snapshot[]): { milestones: Snapshot[]; automatic: Snapshot[] } {
  return {
    milestones: rows.filter((s) => s.reason !== 'interval'),
    automatic: rows.filter((s) => s.reason === 'interval'),
  }
}

/**
 * What to call a version. `label` and `reason` are both nullable columns, and four
 * `SnapshotReason` values have no writer at all — so a row this has never seen is not
 * impossible, and must not reach a user as "null".
 */
export function snapshotLabel(s: Snapshot): string {
  if (s.label) return s.label
  if (s.reason && s.reason !== 'interval') return s.reason
  return 'automatic version'
}

// ------------------------------------------------------------------- write atoms

export const loadSnapshotsAtom = atom(null, async (get, set) => {
  const doc = get(activeDocAtom)
  if (!doc) return
  set(snapshotsAtom, (await trpc.snapshots.list.query({ docId: doc.id })) as Snapshot[])
})

export const loadPreviewAtom = atom(null, async (get, set, snapshotId: string) => {
  const doc = get(activeDocAtom)
  if (!doc) return
  set(selectedSnapshotIdAtom, snapshotId)
  set(previewAtom, null)
  const { text } = await trpc.snapshots.preview.query({ docId: doc.id, snapshotId })
  // The note may have been closed, or another version picked, while this was in flight.
  if (get(selectedSnapshotIdAtom) === snapshotId) set(previewAtom, text)
})

/**
 * Restore is a CRDT edit, not a rewind: `replaceAllText` goes through the live room, so
 * the open editor updates itself and every connected member sees it. Nothing to refetch
 * about the doc.
 *
 * The list IS refetched — the restore just minted a `pre-restore` row, and a timeline
 * missing the undo of the thing you just did is missing it at the one moment it matters.
 */
export const restoreSnapshotAtom = atom(null, async (get, set, snapshotId: string) => {
  const doc = get(activeDocAtom)
  if (!doc) return
  await trpc.snapshots.restore.mutate({ docId: doc.id, snapshotId })
  await set(loadSnapshotsAtom)
})

/** Opening a different note must not leave the last one's versions on screen. */
export const resetHistoryAtom = atom(null, (_get, set) => {
  set(snapshotsAtom, [])
  set(selectedSnapshotIdAtom, null)
  set(previewAtom, null)
  set(showAllVersionsAtom, false)
})
