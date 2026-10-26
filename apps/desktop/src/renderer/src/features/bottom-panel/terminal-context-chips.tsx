import { FileDiffIcon, FolderIcon, GitBranchIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/reui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import type { TerminalContext } from '@/state/panel-terminals'

/**
 * The front terminal's context chips (docs/features/status-bar.md), as Warp
 * draws them above its prompt: where the shell is, the branch there, and
 * the changed files with the lines added and removed. Main reads them
 * (`main/terminal/terminal-context.ts`) and pushes each change.
 */

/**
 * A path longer than this loses its middle.
 * @public exported for its test
 */
export const PATH_CHARS = 48

/** `~/Development/…/repos/holi`: the start and the end of a long path, which
 *  say where it is, with the middle given up.
 * @public exported for its test
 */
export function middleTruncate(text: string, max: number = PATH_CHARS): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep * 0.4)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

const count = new Intl.NumberFormat()

export function TerminalContextChips({
  context,
  className,
}: {
  /** Null until main first reads it. */
  context: TerminalContext | null
  className?: string
}) {
  const row = cn('flex min-w-0 shrink-0 items-center gap-1.5', className)
  if (context === null) {
    return (
      <div className={row} role="status" aria-label="Reading where the shell is">
        <Skeleton className="h-5.5 w-40" />
        <Skeleton className="h-5.5 w-24" />
      </div>
    )
  }
  const { cwd, label, git } = context
  const copy = () => {
    void navigator.clipboard
      .writeText(cwd)
      .then(() => toast.success('Path copied'))
      .catch(() => toast.error('Could not copy the path'))
  }
  return (
    <div className={row} data-terminal-context>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            size="lg"
            role="button"
            tabIndex={0}
            aria-label={`Copy ${cwd}`}
            onClick={copy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                copy()
              }
            }}
            className="text-muted-foreground hover:bg-accent hover:text-foreground min-w-0 cursor-pointer justify-start font-mono font-normal"
          >
            <FolderIcon aria-hidden />
            <span className="truncate">{middleTruncate(label)}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono">
          {cwd}
        </TooltipContent>
      </Tooltip>
      {git === null ? null : (
        <>
          <Badge
            variant="outline"
            size="lg"
            className="text-muted-foreground min-w-0 font-mono font-normal"
          >
            <GitBranchIcon aria-hidden />
            <span className="truncate">{git.branch}</span>
          </Badge>
          {git.files === 0 ? null : (
            <Badge
              variant="outline"
              size="lg"
              aria-label={changesLabel(git)}
              className="text-muted-foreground font-mono font-normal tabular-nums"
            >
              <FileDiffIcon aria-hidden />
              <span>{count.format(git.files)}</span>
              {git.added === 0 && git.removed === 0 ? null : <span aria-hidden>•</span>}
              {git.added === 0 ? null : (
                <span className="text-success-foreground dark:text-success">
                  +{count.format(git.added)}
                </span>
              )}
              {git.removed === 0 ? null : (
                <span className="text-destructive-foreground dark:text-destructive">
                  −{count.format(git.removed)}
                </span>
              )}
            </Badge>
          )}
        </>
      )}
    </div>
  )
}

function changesLabel(git: NonNullable<TerminalContext['git']>): string {
  const files = `${git.files} changed ${git.files === 1 ? 'file' : 'files'}`
  return `${files}, ${git.added} lines added, ${git.removed} removed`
}
