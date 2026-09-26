/**
 * What the agent's last turn changed, and how to take a piece of it back (D88).
 *
 * The review happens AFTER the turn, never as a gate before the write:
 * `prd/vaults-sync.md` §Non-goals rules out an outbound gate, and Claude Code's
 * own permission prompts already ask. So this is a reading of a commit range,
 * shaped like `HistoryPanel` because it answers the same questions about one.
 *
 * The unit is a range rather than a tool-level record because git catches the
 * files the agent changed through `Bash` — a `sed`, an `mv`, a script — that a
 * `Write|Edit|MultiEdit` matcher never sees.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { DiffView, DrawerShell, DrawerTitle } from '@/composites'
import { Button } from '@/primitives'
import { cn } from '@/lib/cn'
import { useAck } from '@/lib/use-ack'
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
} from '@/state/turns'

/** `at` is an ISO string, not a Date — no superjson transformer on the ipcLink. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

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

  // The house busy/error wrapper (HistoryPanel, VaultSection) — reused.
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
    if (selected === null || resolved === null) return
    await revert({ path: selected, text: resolved })
    setResolved(null)
  })

  const row = (file: TurnFile) => (
    <Button
      key={file.path}
      variant="ghost"
      onClick={() => void loadDiff(file.path)}
      className={cn(
        'h-auto w-full min-w-0 justify-between gap-2 px-2 py-1 text-left text-xs font-normal',
        selected === file.path ? 'bg-accent text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{file.path}</span>
      <span className="shrink-0 font-mono text-[10px]">
        <span className="text-emerald-500">+{file.added}</span>{' '}
        <span className="text-destructive">−{file.removed}</span>
      </span>
    </Button>
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
              // Not "it changed nothing": a turn that changed nothing is never
              // recorded, so an empty list against a real turn means the commits it
              // names are no longer reachable (a reset, a re-clone).
              <p className="px-2 py-1 text-xs text-muted-foreground">
                This turn&rsquo;s history is gone. The commits it recorded are no longer in the
                vault, so there is nothing left to compare.
              </p>
            ) : (
              files.map(row)
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {selected === null ? (
              <p className="p-3 text-xs text-muted-foreground">Pick a file to see what changed.</p>
            ) : diff === null ? (
              <p className="p-3 text-xs text-muted-foreground">Loading…</p>
            ) : (
              <DiffView before={diff.before} after={diff.after} onResolve={setResolved} />
            )}
          </div>

          {error !== null && <p className="px-3 pb-1 text-xs text-destructive">{error}</p>}
          <div className="border-t border-divider p-2">
            {/* Acknowledge: keeping a resolution writes a revert COMMIT, so it
            gets a beat. Fired on the way in rather than after the await — the
            ack is feedback that the act was taken, and an 800ms bloom must not
            wait on git. */}
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
