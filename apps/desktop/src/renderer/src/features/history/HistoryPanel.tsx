/**
 * Version history for the open note, as a right-hand side panel beside the
 * editor.
 *
 * These are the file's actual git commits (`docs/features/history.md`): a flat
 * log, newest-first, each row its message, date, author and churn.
 *
 * **A drill-down, the nav menu's idea.** The log fills the drawer. Picking a
 * commit goes into it: the log slides away and the commit takes the whole
 * drawer, with "Back to log" at its top, its message and facts, the diff it
 * made to *this* file (vs its parent) and Restore. Back slides the log in
 * again where it was: both views stay mounted, so its scroll survives.
 * Restore writes the old content as a new commit.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Churn, DiffView, DrawerShell, DrawerTitle } from '@/composites'
import { Button, Dialog, Icon, Tooltip, spring } from '@/primitives'
import { cn } from '@/lib/cn'
import {
  diffAtom,
  historyOpenAtom,
  historyTargetPathAtom,
  loadDiffAtom,
  loadVersionsAtom,
  resetHistoryAtom,
  restoreVersionAtom,
  revisionCountAtom,
  selectedShaAtom,
  versionsAtom,
  type Version,
} from '@/state/history'
import { activeRemoteAtom, historyEpoch, historyEpochsAtom } from '@/state/vaults'

/** `date` is an ISO string, not a Date: no superjson transformer on the ipcLink. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** How far a view travels as the other takes its place, in px. */
const SHIFT = 24

export function HistoryPanel() {
  const open = useAtomValue(historyOpenAtom)
  const targetPath = useAtomValue(historyTargetPathAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const versions = useAtomValue(versionsAtom)
  const revisions = useAtomValue(revisionCountAtom)
  const diff = useAtomValue(diffAtom)
  const [selectedSha, setSelectedSha] = useAtom(selectedShaAtom)
  const setDiff = useSetAtom(diffAtom)
  const loadVersions = useSetAtom(loadVersionsAtom)
  const loadDiff = useSetAtom(loadDiffAtom)
  const restore = useSetAtom(restoreVersionAtom)
  const reset = useSetAtom(resetHistoryAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const reducedMotion = useReducedMotion() ?? false

  // History is per-file and follows focus: switching to another note must swap the
  // log, not leave the last one's commits up.
  // Not on close: the drawer slides out with what it showed, rather than
  // emptying on the way.
  useEffect(() => {
    if (!open || !targetPath) return
    reset()
    void loadVersions()
  }, [open, targetPath, loadVersions, reset])

  // A commit took the file while the drawer shows it: ask for the list again,
  // keeping the selection. The count follows on its own (`fileHistoryAtom`), and
  // the list must not lag behind it. Only when the epoch moves under the same
  // path: a new path is the effect above's job.
  const epoch = historyEpoch(useAtomValue(historyEpochsAtom), targetPath ?? '')
  const seen = useRef({ targetPath, epoch })
  useEffect(() => {
    const prev = seen.current
    seen.current = { targetPath, epoch }
    if (prev.targetPath !== targetPath || prev.epoch === epoch || !open) return
    void loadVersions()
  }, [targetPath, epoch, open, loadVersions])

  // The commit on the remote: GitHub is the vault's host (D60).
  const openCommit = (sha: string) => {
    if (remote) void window.holi.openExternal(`https://github.com/${remote}/commit/${sha}`)
  }

  const backToLog = () => {
    setError(null)
    setSelectedSha(null)
    setDiff(null)
  }

  const onRestore = async () => {
    if (!selectedSha) return
    setConfirming(false)
    setBusy(true)
    setError(null)
    try {
      await restore(selectedSha)
      // The restore is the newest commit now: the log is where it shows.
      backToLog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const selected = versions.find((v) => v.sha === selectedSha) ?? null
  const inCommit = selectedSha !== null

  /** Where a view rests, and where it goes while the other one shows: the log
   *  off to the left, the commit off to the right, as a step in and back. */
  const place = (shown: boolean, side: -1 | 1) =>
    shown
      ? { x: 0, opacity: 1, filter: 'blur(0px)' }
      : { x: side * SHIFT, opacity: 0, filter: 'blur(4px)' }
  const travel = reducedMotion ? { duration: 0 } : { ...spring, bounce: 0.15 }

  const row = (v: Version) => (
    <Button
      key={v.sha}
      variant="ghost"
      data-history-row={v.sha}
      onClick={() => void loadDiff(v.sha)}
      className="h-auto w-full min-w-0 flex-col items-start justify-start gap-0.5 rounded-md px-3 py-1.5 text-left font-normal"
    >
      <span className="block w-full truncate text-[13px] text-foreground">
        {v.subject || '(no message)'}
      </span>
      <span className="block w-full truncate text-[11px] text-muted-foreground">
        {when(v.date)} · {v.author}
        <Churn added={v.added} removed={v.removed} />
      </span>
    </Button>
  )

  return (
    <DrawerShell
      id="history"
      side="right"
      // Open while asked AND while there is a note to show: focusing the board
      // closes it the same way the button does, sliding out.
      open={open && targetPath !== null}
      label="History"
      header={<DrawerTitle title="History" subtitle={targetPath} />}
      aside={revisions === null ? undefined : `${revisions} revision${revisions === 1 ? '' : 's'}`}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <motion.div
          data-history-view="log"
          aria-hidden={inCommit}
          inert={inCommit}
          initial={false}
          animate={place(!inCommit, -1)}
          transition={travel}
          className="absolute inset-0 overflow-y-auto p-2"
        >
          {versions.length === 0 ? (
            <p className="px-3 py-1.5 text-[13px] text-muted-foreground">
              No commits yet. Edits become commits automatically as you work, and each shows here.
            </p>
          ) : (
            versions.map(row)
          )}
        </motion.div>

        <motion.div
          data-history-view="commit"
          aria-hidden={!inCommit}
          inert={!inCommit}
          initial={false}
          animate={place(inCommit, 1)}
          transition={travel}
          className={cn('absolute inset-0 flex flex-col', !inCommit && 'pointer-events-none')}
        >
          <div className="shrink-0 p-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={backToLog}
              className="w-full justify-start px-3 text-[13px] font-normal text-muted-foreground"
            >
              <Icon icon={ArrowLeft} size="sm" />
              Back to log
            </Button>
            {selected !== null && (
              <div className="px-3 pt-2 pb-1">
                <p className="text-[13px] break-words text-foreground">
                  {selected.subject || '(no message)'}
                </p>
                <p className="mt-0.5 flex min-w-0 items-center text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {when(selected.date)} · {selected.author}
                    <Churn added={selected.added} removed={selected.removed} />
                  </span>
                  <Tooltip content="Open this commit on GitHub">
                    <Button
                      variant="link"
                      onClick={() => openCommit(selected.sha)}
                      className="ml-auto h-auto shrink-0 p-0 pl-2 font-mono text-[11px] font-normal"
                    >
                      {selected.sha.slice(0, 7)}
                    </Button>
                  </Tooltip>
                </p>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {diff === null ? (
              <p className="px-5 py-1.5 text-[13px] text-muted-foreground">Loading…</p>
            ) : diff.before === '' && diff.after === '' ? (
              <p className="px-5 py-1.5 text-[13px] text-muted-foreground">
                This commit did not change this file.
              </p>
            ) : (
              <DiffView before={diff.before} after={diff.after} />
            )}
          </div>

          {error && <p className="px-5 pb-1 text-[13px] text-destructive">{error}</p>}
          <div className="shrink-0 p-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !inCommit}
              onClick={() => setConfirming(true)}
              className="w-full"
            >
              Restore this version
            </Button>
          </div>
        </motion.div>
      </div>

      {confirming && (
        <Dialog open onClose={() => setConfirming(false)} size="sm">
          <div className="grid min-w-0 gap-4">
            <Dialog.Header>Restore this version?</Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                It replaces the note&rsquo;s text with this commit&rsquo;s version as a new commit,
                and everyone in the vault will pull it. Nothing is erased: the current version stays
                in the log, so you can put it back.
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void onRestore()}>
                Restore
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </DrawerShell>
  )
}
