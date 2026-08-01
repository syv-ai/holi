/**
 * Version history for the open note — a right-hand drawer beside the editor,
 * mirroring AgentPanel's shape (not a `viewAtom` peer, not a modal).
 *
 * These are the file's actual git commits (`prd/vaults-sync.md` §History): a flat
 * log, newest-first, each row its sha, message and author. Picking one shows the
 * diff that commit made to *this* file (vs its parent) in a merge view; the sha
 * links to the commit on the remote; Restore writes the old content as a new commit.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import {
  diffAtom,
  historyOpenAtom,
  historyTargetPathAtom,
  loadDiffAtom,
  loadVersionsAtom,
  resetHistoryAtom,
  restoreVersionAtom,
  selectedShaAtom,
  versionsAtom,
  type Version,
} from '../state/history'
import { activeRemoteAtom } from '../state/vaults'
import { DiffView } from './DiffView'

/** `date` is an ISO string, not a Date — no superjson transformer on the ipcLink. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function HistoryPanel() {
  const open = useAtomValue(historyOpenAtom)
  const targetPath = useAtomValue(historyTargetPathAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const versions = useAtomValue(versionsAtom)
  const diff = useAtomValue(diffAtom)
  const [selectedSha] = useAtom(selectedShaAtom)
  const loadVersions = useSetAtom(loadVersionsAtom)
  const loadDiff = useSetAtom(loadDiffAtom)
  const restore = useSetAtom(restoreVersionAtom)
  const reset = useSetAtom(resetHistoryAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // History is per-file and follows focus: switching to another note must swap the
  // log, not leave the last one's commits up.
  useEffect(() => {
    reset()
    if (open && targetPath) void loadVersions()
  }, [open, targetPath, loadVersions, reset])

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

  if (!open || targetPath === null) return null

  // The commit on the remote — GitHub is the vault's host (D60). Opens in the browser.
  const openCommit = (sha: string) => {
    if (remote) void window.holi.openExternal(`https://github.com/${remote}/commit/${sha}`)
  }

  const onRestore = guard(async () => {
    if (!selectedSha) return
    // window.confirm is the codebase's only destructive-confirm precedent (MembersSection).
    const proceed = window.confirm(
      'Restore this version?\n\n' +
        "It replaces the note's text with this commit's version as a new commit — everyone in " +
        'the vault will pull it. Nothing is erased: the current version stays in the log, so you ' +
        'can put it back.',
    )
    if (proceed) await restore(selectedSha)
  })

  // A row is two controls, not a button inside a button (invalid HTML): the message
  // selects the commit to diff; the short sha opens that commit on the remote.
  const row = (v: Version) => (
    <div
      key={v.sha}
      className={`flex items-center gap-1 rounded ${
        selectedSha === v.sha ? 'bg-neutral-800' : 'hover:bg-neutral-900'
      }`}
    >
      <button
        onClick={() => void loadDiff(v.sha)}
        className={`min-w-0 flex-1 px-2 py-1 text-left text-xs ${
          selectedSha === v.sha ? 'text-neutral-100' : 'text-neutral-400'
        }`}
      >
        <span className="block truncate">{v.subject || '(no message)'}</span>
        <span className="block text-[10px] text-neutral-600">
          {when(v.date)} · {v.author}
        </span>
      </button>
      <button
        onClick={() => openCommit(v.sha)}
        title={`open commit ${v.sha.slice(0, 7)} on GitHub`}
        className="shrink-0 rounded px-1.5 py-1 font-mono text-[10px] text-neutral-600 hover:text-sky-400"
      >
        {v.sha.slice(0, 7)}
      </button>
    </div>
  )

  return (
    <aside className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-xs">
        <span className="text-neutral-300">History</span>
        <span className="min-w-0 flex-1 truncate text-neutral-600">{targetPath}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="max-h-56 shrink-0 overflow-y-auto border-b border-neutral-900 p-2">
          {versions.length === 0 && (
            <p className="px-2 py-1 text-xs text-neutral-600">
              No commits yet — edits become commits automatically as you work, and each shows here.
            </p>
          )}
          {versions.map(row)}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {selectedSha === null ? (
            <p className="p-3 text-xs text-neutral-600">Pick a commit to see what it changed.</p>
          ) : diff === null ? (
            <p className="p-3 text-xs text-neutral-600">Loading…</p>
          ) : diff.before === '' && diff.after === '' ? (
            <p className="p-3 text-xs text-neutral-600 italic">This commit did not change this file.</p>
          ) : (
            <DiffView before={diff.before} after={diff.after} />
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
