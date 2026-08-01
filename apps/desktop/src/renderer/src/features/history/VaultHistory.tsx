/**
 * The broad version-control dialog — the whole vault's git history, opened from
 * the footer sync state. Commit-first (the side panel beside the editor is
 * file-first): pick a commit on the left, see the files it changed in the middle,
 * read the diff on the right. Each sha links to the commit on the remote.
 *
 * A fixed-height workspace modal on the `Dialog` primitive (`size="full"`): the
 * backdrop, Escape and focus-trap it used to hand-roll now come from Radix, and
 * the built-in close (top-right) replaces the old text button. It reuses
 * `DiffView` (the merge view) so a commit's diff looks exactly like the panel's.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { Button, Dialog, ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/primitives'
import { cn } from '@/lib/cn'
import { DiffView, PanelHeader } from '@/composites'
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
} from '@/state/history'
import { activeRemoteAtom } from '@/state/vaults'
import { usePanelLayout } from '@/state/preferences'

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

  // Load the log while open; drop it on close. Escape/backdrop close is Radix's now.
  useEffect(() => {
    void load()
    return () => reset()
  }, [load, reset])

  const openCommit = (sha: string) => {
    if (remote) void window.holi.openExternal(`https://github.com/${remote}/commit/${sha}`)
  }

  return (
    <Dialog open onClose={onClose} size="full">
      {/* The shared panel bar, sized for the modal: h-auto over the Dialog's own
          padding, and pr-10 to clear the primitive's absolute close button. */}
      <PanelHeader className="h-auto px-4 py-2 pr-10 text-sm">
        <Dialog.Header>History</Dialog.Header>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{remote ?? ''}</span>
      </PanelHeader>

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
              <p className="px-2 py-1 text-xs text-muted-foreground">No commits yet.</p>
            )}
            {commits.map((c) => (
              <div
                key={c.sha}
                className={cn(
                  'flex items-center gap-1 rounded',
                  selectedSha === c.sha ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <Button
                  variant="ghost"
                  onClick={() => void selectCommit(c.sha)}
                  className={cn(
                    'h-auto min-w-0 flex-1 flex-col items-start justify-start gap-0 px-2 py-1 text-left text-xs font-normal hover:bg-transparent',
                    selectedSha === c.sha ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span className="block w-full truncate">{c.subject || '(no message)'}</span>
                  <span className="block w-full truncate text-[10px] text-muted-foreground">
                    {when(c.date)} · {c.author}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => openCommit(c.sha)}
                  title={`open commit ${c.sha.slice(0, 7)} on GitHub`}
                  className="h-auto shrink-0 px-1.5 py-1 font-mono text-[10px] font-normal text-muted-foreground hover:bg-transparent hover:text-primary"
                >
                  {c.sha.slice(0, 7)}
                </Button>
              </div>
            ))}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Files in the selected commit */}
        <ResizablePanel id="files" defaultSize={256} minSize={160}>
          <div className="h-full overflow-y-auto p-2">
            {selectedSha === null ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">Pick a commit.</p>
            ) : files.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No files changed.</p>
            ) : (
              files.map((f) => (
                <Button
                  key={f}
                  variant="ghost"
                  onClick={() => void selectFile(f)}
                  title={f}
                  className={cn(
                    'block h-auto w-full justify-start truncate px-2 py-1 text-left text-xs font-normal',
                    selectedFile === f
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  {f}
                </Button>
              ))
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Diff of the selected file */}
        <ResizablePanel id="diff" minSize={280}>
          <div className="h-full overflow-hidden">
            {selectedFile === null ? (
              <p className="p-3 text-xs text-muted-foreground">Pick a file to see its diff.</p>
            ) : diff === null ? (
              <p className="p-3 text-xs text-muted-foreground">Loading…</p>
            ) : (
              <DiffView before={diff.before} after={diff.after} />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Dialog>
  )
}
