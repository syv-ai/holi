/**
 * The broad version-control dialog — the whole vault's git history, opened from
 * the footer sync state. Commit-first (the drawer beside the editor is file-first):
 * pick a commit on the left, see the files it changed in the middle, read the diff
 * on the right. Each sha links to the commit on the remote.
 *
 * A centered modal overlay — the codebase has no dialog primitive, so this owns its
 * own backdrop (click-away and Esc close). It reuses `DiffView` (the merge view) so
 * a commit's diff looks exactly like the drawer's.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import {
  commitDiffAtom,
  commitFilesAtom,
  loadVaultLogAtom,
  resetVaultLogAtom,
  selectCommitAtom,
  selectCommitFileAtom,
  selectedCommitFileAtom,
  selectedCommitShaAtom,
  vaultCommitsAtom,
} from '../state/history'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/primitives'
import { activeRemoteAtom } from '../state/vaults'
import { usePanelLayout } from '../state/preferences'
import { DiffView } from './DiffView'

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function VaultHistory({ onClose }: { onClose: () => void }) {
  const commits = useAtomValue(vaultCommitsAtom)
  const selectedSha = useAtomValue(selectedCommitShaAtom)
  const files = useAtomValue(commitFilesAtom)
  const selectedFile = useAtomValue(selectedCommitFileAtom)
  const diff = useAtomValue(commitDiffAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const load = useSetAtom(loadVaultLogAtom)
  const selectCommit = useSetAtom(selectCommitAtom)
  const selectFile = useSetAtom(selectCommitFileAtom)
  const reset = useSetAtom(resetVaultLogAtom)
  const layout = usePanelLayout(remote, 'vault-history')

  useEffect(() => {
    void load()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      reset()
    }
  }, [load, reset, onClose])

  const openCommit = (sha: string) => {
    if (remote) void window.holi.openExternal(`https://github.com/${remote}/commit/${sha}`)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-900 px-4 py-2 text-sm">
          <span className="text-neutral-200">History</span>
          <span className="min-w-0 flex-1 truncate text-neutral-600">{remote ?? ''}</span>
          <button
            onClick={onClose}
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs hover:bg-neutral-700"
          >
            Close
          </button>
        </div>

        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          {/* Commits */}
          <ResizablePanel id="commits" defaultSize={288} minSize={180}>
            <div className="h-full overflow-y-auto p-2">
            {commits.length === 0 && (
              <p className="px-2 py-1 text-xs text-neutral-600">No commits yet.</p>
            )}
            {commits.map((c) => (
              <div
                key={c.sha}
                className={`flex items-center gap-1 rounded ${
                  selectedSha === c.sha ? 'bg-neutral-800' : 'hover:bg-neutral-900'
                }`}
              >
                <button
                  onClick={() => void selectCommit(c.sha)}
                  className={`min-w-0 flex-1 px-2 py-1 text-left text-xs ${
                    selectedSha === c.sha ? 'text-neutral-100' : 'text-neutral-400'
                  }`}
                >
                  <span className="block truncate">{c.subject || '(no message)'}</span>
                  <span className="block text-[10px] text-neutral-600">
                    {when(c.date)} · {c.author}
                  </span>
                </button>
                <button
                  onClick={() => openCommit(c.sha)}
                  title={`open commit ${c.sha.slice(0, 7)} on GitHub`}
                  className="shrink-0 rounded px-1.5 py-1 font-mono text-[10px] text-neutral-600 hover:text-sky-400"
                >
                  {c.sha.slice(0, 7)}
                </button>
              </div>
            ))}
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Files in the selected commit */}
          <ResizablePanel id="files" defaultSize={256} minSize={160}>
            <div className="h-full overflow-y-auto p-2">
            {selectedSha === null ? (
              <p className="px-2 py-1 text-xs text-neutral-600">Pick a commit.</p>
            ) : files.length === 0 ? (
              <p className="px-2 py-1 text-xs text-neutral-600">No files changed.</p>
            ) : (
              files.map((f) => (
                <button
                  key={f}
                  onClick={() => void selectFile(f)}
                  title={f}
                  className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                    selectedFile === f
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-900'
                  }`}
                >
                  {f}
                </button>
              ))
            )}
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Diff of the selected file */}
          <ResizablePanel id="diff" minSize={280}>
            <div className="h-full overflow-hidden">
            {selectedFile === null ? (
              <p className="p-3 text-xs text-neutral-600">Pick a file to see its diff.</p>
            ) : diff === null ? (
              <p className="p-3 text-xs text-neutral-600">Loading…</p>
            ) : (
              <DiffView before={diff.before} after={diff.after} />
            )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
