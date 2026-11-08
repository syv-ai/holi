import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { HistoryIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ignoredPathsAtom, isUnsyncedPath } from '@/state/vaults'

import { HistoryDialog } from './history-dialog'
import { commitAge, shortSha } from './commit-format'
import { useFileAuthors, useFileHistory } from './use-file-history'

/**
 * A file header's history, as GitHub puts it above a file: its latest
 * commit (`4a14110 · 2 months ago`) and History, which opens the commits
 * dialog. The same for a document and for code. A local file with no
 * commits shows Local instead.
 */
export function FileHistoryButton({ path }: { path: string }) {
  const { history, retry } = useFileHistory(path)
  const authors = useFileAuthors(path)
  const [open, setOpen] = useState(false)
  const latest = history.kind === 'ready' ? history.commits[0] : undefined
  const unsynced = isUnsyncedPath(useAtomValue(ignoredPathsAtom), path)

  // A file git ignores has no history to show unless it was committed before
  // it was ignored: it says where it lives instead.
  if (unsynced && latest === undefined) {
    return <span className="text-muted-foreground shrink-0 text-xs">Local</span>
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {latest !== undefined ? (
        // The commit line is the first to give way, below a 768px header.
        <span className="text-muted-foreground hidden text-xs whitespace-nowrap tabular-nums @3xl/view-header:inline">
          <span className="font-mono">{shortSha(latest.sha)}</span> ·{' '}
          <time dateTime={latest.date}>{commitAge(latest.date)}</time>
        </span>
      ) : null}
      {/* Its label gives way below a 512px header; the name stays. */}
      <Button variant="ghost" size="sm" aria-label="History" onClick={() => setOpen(true)}>
        <HistoryIcon data-icon="inline-start" aria-hidden="true" />
        <span className="hidden @lg/view-header:inline">History</span>
      </Button>
      <HistoryDialog
        path={path}
        history={history}
        authors={authors}
        onRetry={retry}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  )
}

/** The same commits dialog on its own, for whatever names a path's history
 *  without a file header: a vault app's approval opens its bundle's. */
export function FileHistoryDialog({
  path,
  open,
  onOpenChange,
  sha,
}: {
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The commit to open on, as `HistoryDialog`'s `sha`. */
  sha?: string
}) {
  // Asks git and GitHub only while open: the dialog stays mounted for its
  // close animation, and a closed one wants nothing.
  const { history, retry } = useFileHistory(path, open)
  const authors = useFileAuthors(path, open)
  return (
    <HistoryDialog
      path={path}
      history={history}
      authors={authors}
      onRetry={retry}
      open={open}
      onOpenChange={onOpenChange}
      {...(sha === undefined ? {} : { sha })}
    />
  )
}
