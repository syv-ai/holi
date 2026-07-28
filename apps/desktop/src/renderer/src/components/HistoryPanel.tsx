/**
 * Version history for the open note — the timeline, a read-only preview, and restore.
 *
 * A right-hand drawer beside the editor, mirroring AgentPanel's shape. Deliberately not
 * a third `viewAtom` entry (history is *about* the open note, not a peer surface to
 * notes/board) and deliberately not a modal — there is no modal/dialog primitive in this
 * codebase, and inventing one is a different slice.
 *
 * The timeline IS git history (`prd/vaults-sync.md` §History): each row is a commit that
 * touched the file, keyed by sha; restore writes the old content back as a new commit.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import {
  historyOpenAtom,
  loadPreviewAtom,
  loadVersionsAtom,
  partitionVersions,
  previewAtom,
  resetHistoryAtom,
  restoreVersionAtom,
  selectedShaAtom,
  showAllVersionsAtom,
  versionLabel,
  versionsAtom,
  type Version,
} from '../state/history'
import { activeDocAtom } from '../state/vaults'

/** `date` is an ISO string, not a Date — no superjson transformer on the ipcLink. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function HistoryPanel() {
  const open = useAtomValue(historyOpenAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const versions = useAtomValue(versionsAtom)
  const preview = useAtomValue(previewAtom)
  const selectedSha = useAtomValue(selectedShaAtom)
  const [showAll, setShowAll] = useAtom(showAllVersionsAtom)
  const loadVersions = useSetAtom(loadVersionsAtom)
  const loadPreview = useSetAtom(loadPreviewAtom)
  const restore = useSetAtom(restoreVersionAtom)
  const reset = useSetAtom(resetHistoryAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // History is per-doc: opening another note must not leave the last one's versions up.
  useEffect(() => {
    reset()
    if (open && activeDoc) void loadVersions()
  }, [open, activeDoc, loadVersions, reset])

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
  const { landmarks, automatic } = partitionVersions(versions)

  const onRestore = guard(async () => {
    if (!selectedSha) return
    // window.confirm is the codebase's only destructive-confirm precedent (MembersSection).
    // Say what it does: it lands a new commit everyone in the vault will pull, and it is
    // itself revertible from this same timeline — not a private, silent undo.
    const proceed = window.confirm(
      'Restore this version?\n\n' +
        "It replaces the note's text with this older version as a new commit — everyone in " +
        'the vault will pull it. Nothing is erased: the current version stays in the timeline, ' +
        'so you can put it back.',
    )
    if (proceed) await restore(selectedSha)
  })

  const row = (v: Version) => (
    <button
      key={v.sha}
      onClick={() => void loadPreview(v.sha)}
      className={`w-full rounded px-2 py-1 text-left text-xs ${
        selectedSha === v.sha ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'
      }`}
    >
      <span className="block truncate">{versionLabel(v)}</span>
      <span className="block text-[10px] text-neutral-600">
        {when(v.date)} · {v.author}
      </span>
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
          {versions.length === 0 && (
            <p className="px-2 py-1 text-xs text-neutral-600">
              No versions yet — this file has no commits. Edits become commits automatically as
              you work, and each one shows up here.
            </p>
          )}
          {landmarks.map(row)}
          {/* Display only — the autosave run is folded so the landmarks stand out.
            * Nothing is hidden from restore; these are just not what you came looking for. */}
          {automatic.length > 0 && (
            <>
              <button
                onClick={() => setShowAll((v) => !v)}
                className="mt-1 w-full px-2 py-1 text-left text-[10px] text-neutral-600 hover:text-neutral-400"
              >
                {showAll ? '⌃' : '⌄'} {automatic.length} automatic save
                {automatic.length === 1 ? '' : 's'}
              </button>
              {showAll && automatic.map(row)}
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {selectedSha === null ? (
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
            disabled={busy || selectedSha === null}
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
