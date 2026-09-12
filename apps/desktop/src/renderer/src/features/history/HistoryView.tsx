/**
 * The vault's history, as a tab.
 *
 * A tab rather than the full-screen modal it used to be, for the reason
 * settings became one (#16): reading what a commit changed is exactly the thing
 * you want open beside the note it changed, and a modal blocks the window while
 * you try. It is splittable, closable and one-per-window for free.
 *
 * **Commit-first, and then every file at once.** Pick a commit on the left and
 * the right becomes one collapsible per changed file with that file's diff
 * inside it, rather than a second list you have to click through. A commit is a
 * single act and this reads it as one.
 *
 * The per-NOTE history side panel is a different surface and is untouched: that
 * one is file-first, and it is the first of a set of sidebars a note unfolds.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Tooltip } from '@/primitives'
import { Churn, DiffView, PanelHeader } from '@/composites'
import { cn } from '@/lib/cn'
import {
  commitDiffsAtom,
  commitFilesAtom,
  loadCommitDiffAtom,
  loadVaultLogAtom,
  resetVaultLogAtom,
  selectCommitAtom,
  selectedCommitShaAtom,
  vaultCommitsAtom,
  type Version,
} from '@/state/history'
import { activeRemoteAtom } from '@/state/vaults'

/** `date` is an ISO string, not a Date — no superjson transformer on the ipcLink. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * One changed file: a header that collapses, and the diff under it.
 *
 * It asks for its own diff when it first opens, so a commit touching thirty
 * files fetches thirty times in parallel instead of serially through a
 * selection — and a file you collapse and open again costs nothing, because the
 * answer is kept per commit rather than per view.
 */
function FileEntry({ path, sha }: { path: string; sha: string }): React.JSX.Element {
  // Expanded by default: a commit is usually small, and the surface exists to be
  // read rather than navigated.
  const [open, setOpen] = useState(true)
  const diffs = useAtomValue(commitDiffsAtom)
  const loadDiff = useSetAtom(loadCommitDiffAtom)
  const diff = diffs[path]

  useEffect(() => {
    if (open && diff === undefined) void loadDiff(path)
  }, [open, diff, loadDiff, path, sha])

  return (
    <div className="border-b border-divider last:border-b-0">
      <Button
        variant="ghost"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="h-auto w-full min-w-0 justify-start gap-1.5 rounded-none px-2 py-1.5 text-left text-xs font-normal"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{path}</span>
      </Button>
      {open && (
        <div className={cn('max-h-[60vh] overflow-auto border-t border-divider')}>
          {diff === undefined ? (
            <p className="p-3 text-xs text-muted-foreground">Loading…</p>
          ) : diff.before === '' && diff.after === '' ? (
            <p className="p-3 text-xs text-muted-foreground italic">
              This commit did not change this file&rsquo;s contents.
            </p>
          ) : (
            <DiffView before={diff.before} after={diff.after} />
          )}
        </div>
      )}
    </div>
  )
}

export function HistoryView(): React.JSX.Element {
  const commits = useAtomValue(vaultCommitsAtom)
  const selectedSha = useAtomValue(selectedCommitShaAtom)
  const files = useAtomValue(commitFilesAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const load = useSetAtom(loadVaultLogAtom)
  const selectCommit = useSetAtom(selectCommitAtom)
  const reset = useSetAtom(resetVaultLogAtom)

  // Per vault: a switch must not leave the last one's commits on screen, and the
  // tab outlives the switch.
  useEffect(() => {
    reset()
    void load()
  }, [remote, load, reset])

  // The commit on the remote — GitHub is the vault's host (D60).
  const openCommit = (sha: string) => {
    if (remote !== null) void window.holi.openExternal(`https://github.com/${remote}/commit/${sha}`)
  }

  // Two controls, not a button inside a button (invalid HTML): the message
  // selects the commit, the short sha opens it on the remote.
  const row = (c: Version) => (
    <div
      key={c.sha}
      className={cn(
        'motion-respond flex items-center gap-1 rounded',
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
          <Churn added={c.added} removed={c.removed} />
        </span>
      </Button>
      <Tooltip content={`open commit ${c.sha.slice(0, 7)} on GitHub`}>
        <Button
          variant="ghost"
          onClick={() => openCommit(c.sha)}
          className="h-auto shrink-0 px-1.5 py-1 font-mono text-[10px] font-normal text-muted-foreground hover:bg-transparent hover:text-brand"
        >
          {c.sha.slice(0, 7)}
        </Button>
      </Tooltip>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <span className="font-medium text-foreground">History</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{remote ?? ''}</span>
      </PanelHeader>

      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 overflow-y-auto border-r border-divider p-2">
          {commits.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No commits yet.</p>
          ) : (
            commits.map(row)
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selectedSha === null ? (
            <p className="p-3 text-xs text-muted-foreground">
              Pick a commit to see everything it changed.
            </p>
          ) : files.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">This commit changed no files.</p>
          ) : (
            files.map((path) => <FileEntry key={path} path={path} sha={selectedSha} />)
          )}
        </div>
      </div>
    </div>
  )
}
