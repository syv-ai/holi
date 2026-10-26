/**
 * What the agent's last turn changed, and how to take a piece of it back.
 *
 * The review happens AFTER the turn, never as a gate before the write:
 * `features/vaults-sync.md` rules out an outbound gate, and Claude Code's
 * own permission prompts already ask. So this is a reading of a commit range,
 * shaped like `HistoryPanel` because it answers the same questions about one.
 *
 * The unit is a range rather than a tool-level record because git catches the
 * files the agent changed through `Bash` (a `sed`, an `mv`, a script) that a
 * `Write|Edit|MultiEdit` matcher never sees.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { cn, useAck } from '@/plugin-api'
import {
  reviewTurnAtom,
  loadTurnDiffAtom,
  loadTurnFilesAtom,
  revertFileAtom,
  selectedTurnPathAtom,
  turnDiffAtom,
  turnFilesAtom,
  turnReviewOpenAtom,
  type TurnFile,
} from './state/turns'
import { DiffView } from '@/composites/diff-view'
import { DrawerShell, DrawerTitle } from '@/composites/drawer-shell'
import { EmptyState, LoadingRows } from '@/composites/empty-state'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** `at` is an ISO string, not a Date: no superjson transformer on the ipcLink. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const folder = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

export function TurnReview(): React.JSX.Element | null {
  const open = useAtomValue(turnReviewOpenAtom)
  const turn = useAtomValue(reviewTurnAtom)
  const files = useAtomValue(turnFilesAtom)
  const diff = useAtomValue(turnDiffAtom)
  const selected = useAtomValue(selectedTurnPathAtom)
  const loadFiles = useSetAtom(loadTurnFilesAtom)
  const loadDiff = useSetAtom(loadTurnDiffAtom)
  const revert = useSetAtom(revertFileAtom)
  const setOpen = useSetAtom(turnReviewOpenAtom)
  /**
   * The text the reviewer has resolved to, held here rather than written as it
   * changes. `DiffView` reports every document change, and an editable merge view
   * means that includes typing, so writing on each one would be a commit per
   * keystroke. Null when nothing has been resolved yet, which is also what
   * disables the control at the foot.
   */
  const [resolved, setResolved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && turn !== null) void loadFiles()
  }, [open, turn, loadFiles])

  // A different file is a different resolution; carrying one across would write
  // one file's text over another's.
  useEffect(() => {
    setResolved(null)
  }, [selected])

  // Above the early return, because every hook must run on every render.
  const { ref: keepRef, ack } = useAck<HTMLButtonElement>()

  // Nothing to say about no turn. While one is open and then goes (a vault
  // switch), the drawer still slides out, empty.
  const shown = open && turn !== null

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

  const onKeep = guard(async () => {
    if (selected === null || resolved === null || diff === null) return
    await revert({ path: selected, text: resolved, base: diff.after })
    setResolved(null)
  })

  const row = (file: TurnFile) => (
    <Button
      variant="ghost"
      // The whole path, read in order: the row shows its name first.
      aria-label={`${file.path}, +${file.added} −${file.removed}`}
      onClick={() => void loadDiff(file.path)}
      className={cn(
        'h-auto w-full min-w-0 justify-between gap-2 px-2 py-1 text-left text-xs font-normal',
        selected === file.path ? 'bg-accent text-foreground' : 'text-muted-foreground',
      )}
    >
      {/* The name first and the folder after it, muted: a path cut at its
          end loses the filename, the one part that says which file it is.
          The whole path is the tooltip. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 truncate text-foreground">{basename(file.path)}</span>
        {folder(file.path) !== '' && (
          <span className="min-w-0 truncate text-muted-foreground">{folder(file.path)}</span>
        )}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums">
        <span className="text-diff-added-foreground">+{file.added}</span>{' '}
        <span className="text-diff-removed-foreground">−{file.removed}</span>
      </span>
    </Button>
  )
  const tipped = (file: TurnFile) => (
    <Tooltip key={file.path}>
      <TooltipTrigger asChild>{row(file)}</TooltipTrigger>
      <TooltipContent side="bottom">{file.path}</TooltipContent>
    </Tooltip>
  )

  return (
    <DrawerShell
      id="turn-review"
      side="right"
      open={shown}
      label="Last turn"
      header={
        <DrawerTitle title="Last turn" subtitle={turn === null ? undefined : when(turn.at)} />
      }
      onClose={() => setOpen(false)}
    >
      {turn !== null && (
        <>
          <div className="max-h-56 shrink-0 overflow-y-auto border-b border-divider p-2">
            {files.length === 0 ? (
              // Not "it changed nothing": the chip never opens a turn that changed
              // nothing, so an empty list against a real turn means the commits it
              // names are no longer reachable (a reset, a re-clone).
              <EmptyState
                title="This turn’s history is gone"
                description="The commits it recorded are no longer in the vault, so there is nothing left to compare."
              />
            ) : (
              files.map(tipped)
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {selected === null ? (
              <EmptyState title="Pick a file to see what changed" />
            ) : diff === null ? (
              <LoadingRows label="Loading the change" lines={3} />
            ) : (
              <DiffView before={diff.before} after={diff.after} onResolve={setResolved} />
            )}
          </div>

          {error !== null && (
            <p role="alert" className="px-4 pb-1 text-xs text-pretty text-destructive">
              {error}
            </p>
          )}
          <div className="border-t border-divider p-2">
            {/* Acknowledge: keeping a resolution writes a revert COMMIT, so it
            gets a beat. Fired on the way in rather than after the await: the
            ack is feedback that the act was taken and must not wait on git. */}
            <Button
              ref={keepRef}
              variant="secondary"
              size="sm"
              disabled={busy || resolved === null}
              onClick={() => {
                ack('bloom')
                void onKeep()
              }}
              className="w-full"
            >
              Keep this resolution
            </Button>
          </div>
        </>
      )}
    </DrawerShell>
  )
}
