/**
 * Version history for the open note — the timeline, a read-only preview, and restore.
 *
 * A right-hand drawer beside the editor, mirroring AgentPanel's shape. Deliberately not
 * a third `viewAtom` entry (history is *about* the open note, not a peer surface to
 * notes/board) and deliberately not a modal — there is no modal/dialog primitive in this
 * codebase, and inventing one is a different slice.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import {
  historyOpenAtom,
  loadPreviewAtom,
  loadSnapshotsAtom,
  partitionSnapshots,
  previewAtom,
  resetHistoryAtom,
  restoreSnapshotAtom,
  selectedSnapshotIdAtom,
  showAllVersionsAtom,
  snapshotLabel,
  snapshotsAtom,
  type Snapshot,
} from '../state/history'
import { activeDocAtom } from '../state/vaults'

/** `takenAt` is an ISO string, not a Date — no superjson transformer on the ipcLink. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function HistoryPanel() {
  const open = useAtomValue(historyOpenAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const snapshots = useAtomValue(snapshotsAtom)
  const preview = useAtomValue(previewAtom)
  const selectedId = useAtomValue(selectedSnapshotIdAtom)
  const [showAll, setShowAll] = useAtom(showAllVersionsAtom)
  const loadSnapshots = useSetAtom(loadSnapshotsAtom)
  const loadPreview = useSetAtom(loadPreviewAtom)
  const restore = useSetAtom(restoreSnapshotAtom)
  const reset = useSetAtom(resetHistoryAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // History is per-doc: opening another note must not leave the last one's versions up.
  useEffect(() => {
    reset()
    if (open && activeDoc) void loadSnapshots()
  }, [open, activeDoc, loadSnapshots, reset])

  // The house busy/error wrapper (VaultSettings) — reused, not reinvented.
  const guard = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open || !activeDoc) return null
  const { milestones, automatic } = partitionSnapshots(snapshots)

  const onRestore = guard(async () => {
    if (!selectedId) return
    // window.confirm is the codebase's only destructive-confirm precedent (MembersSection).
    // Say what it does: it is a CRDT edit everyone sees, and it is itself undoable.
    const proceed = window.confirm(
      'Restore this version?\n\n' +
        "It replaces the note's text for everyone in the vault — this is an edit, not a private undo. " +
        'A "before restoring an older version" snapshot is taken first, so you can put it back.',
    )
    if (proceed) await restore(selectedId)
  })

  const row = (s: Snapshot) => (
    <button
      key={s.id}
      onClick={() => void loadPreview(s.id)}
      className={`w-full rounded px-2 py-1 text-left text-xs ${
        selectedId === s.id ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'
      }`}
    >
      <span className="block truncate">{snapshotLabel(s)}</span>
      <span className="block text-[10px] text-neutral-600">{when(s.takenAt)}</span>
    </button>
  )

  return (
    <aside className="flex w-80 min-w-0 flex-col border-l border-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-xs">
        <span className="text-neutral-300">History</span>
        <span className="min-w-0 flex-1 truncate text-neutral-600">{activeDoc.path}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="max-h-56 shrink-0 overflow-y-auto border-b border-neutral-900 p-2">
          {snapshots.length === 0 && (
            <p className="px-2 py-1 text-xs text-neutral-600">
              No versions yet. One is taken automatically every few minutes while a note is being
              edited, and before Claude edits it.
            </p>
          )}
          {milestones.map(row)}
          {/* D54 — display only. Nothing is deleted, and an automatic version restores
            * like any other; it is just not what you came here looking for. */}
          {automatic.length > 0 && (
            <>
              <button
                onClick={() => setShowAll((v) => !v)}
                className="mt-1 w-full px-2 py-1 text-left text-[10px] text-neutral-600 hover:text-neutral-400"
              >
                {showAll ? '⌃' : '⌄'} {automatic.length} automatic version
                {automatic.length === 1 ? '' : 's'}
              </button>
              {showAll && automatic.map(row)}
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {selectedId === null ? (
            <p className="text-xs text-neutral-600">Pick a version to read it.</p>
          ) : preview === null ? (
            <p className="text-xs text-neutral-600">Loading…</p>
          ) : preview === '' ? (
            <p className="text-xs text-neutral-600 italic">This version was empty.</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-300">
              {preview}
            </pre>
          )}
        </div>

        {error && <p className="px-3 pb-1 text-xs text-red-400">{error}</p>}
        <div className="border-t border-neutral-900 p-2">
          <button
            disabled={busy || selectedId === null}
            onClick={() => void onRestore()}
            className="w-full rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-40"
          >
            Restore this version
          </button>
        </div>
      </div>
    </aside>
  )
}
