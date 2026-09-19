/**
 * What one session's last turn changed (D88, #4).
 *
 * It sits under its own tab's terminal, because a turn belongs to a session and
 * a vault runs several (D100). It used to be in the footer, where it was the
 * only thing that said a turn had happened at all once the drawer was shut — a
 * job the sidebar's Sessions section now does better, and one a single chip
 * could not do honestly for three sessions anyway.
 *
 * It is a count and a door, nothing more: what changed is `TurnReview`'s job.
 *
 * **A turn ENDING is the event.** `agent:sessions` pushes on every bracket, so
 * this watches its own session's state leave `working` rather than polling for a
 * record. Reloading while it is still working would read the previous turn,
 * because the record for this one is written as the bracket closes.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { useAck } from '@/lib/use-ack'
import { Button, Tooltip } from '@/primitives'
import { agentSessionsAtom } from '@/state/agent'
import {
  latestTurnsAtom,
  loadLatestTurnsAtom,
  loadTurnCountAtom,
  rangeKey,
  reviewTurnAtom,
  turnCountsAtom,
  turnReviewOpenAtom,
} from '@/state/turns'

export function TurnChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const working =
    useAtomValue(agentSessionsAtom).find((s) => s.id === sessionId)?.state === 'working'
  const turn = useAtomValue(latestTurnsAtom)[sessionId] ?? null
  const counts = useAtomValue(turnCountsAtom)
  const loadLatest = useSetAtom(loadLatestTurnsAtom)
  const loadCount = useSetAtom(loadTurnCountAtom)
  const setReviewTurn = useSetAtom(reviewTurnAtom)
  const setOpen = useSetAtom(turnReviewOpenAtom)
  const wasWorking = useRef(working)
  const { ref: chipRef, ack } = useAck<HTMLButtonElement>()
  const acked = useRef<string | null>(null)

  // On mount, and on each turn this session ends. The edge, not the level:
  // `working` stays false between turns and this must not re-ask on every
  // unrelated push.
  useEffect(() => {
    const ended = wasWorking.current && !working
    wasWorking.current = working
    if (working) return
    if (ended || turn === null) void loadLatest()
  }, [working, turn, loadLatest])

  /**
   * Acknowledge: a turn that has just landed gets one beat.
   *
   * Keyed on the turn's range rather than on `working` going false, because the
   * record loads asynchronously AFTER the turn ends — at the moment of that edge
   * this chip may still be rendering `null`, and there would be no node to
   * acknowledge on. The first record seen is deliberately silent: opening a
   * vault that already has a turn behind it is not an event.
   */
  useEffect(() => {
    if (turn === null) return
    const key = rangeKey(turn)
    if (acked.current !== null && acked.current !== key) ack('bloom')
    acked.current = key
  }, [turn, ack])

  // The count comes from the range, so it follows the record.
  useEffect(() => {
    if (turn !== null) void loadCount(turn)
  }, [turn, loadCount])

  const count = turn === null ? undefined : counts[rangeKey(turn)]
  // A turn with no reachable files has nothing to open onto, and a count that
  // has not arrived yet has nothing to say. `TurnReview` has something to say
  // about the first state; a chip does not.
  if (turn === null || count === undefined || count === 0) return null

  const files = `${count} ${count === 1 ? 'file' : 'files'}`
  return (
    <Tooltip
      content={
        turn.overlapped === true
          ? 'See what this turn changed. Another session was working at the same time, so the range holds its edits too — they shared one settle commit and cannot be told apart by git.'
          : "See what this session's last turn changed, and take any of it back"
      }
    >
      <Button
        ref={chipRef}
        variant="link"
        data-turn-chip={sessionId}
        className="h-auto shrink-0 justify-start p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
        onClick={() => {
          setReviewTurn(turn)
          setOpen(true)
        }}
      >
        Claude changed {files}
        {turn.overlapped === true && (
          <span className="text-muted-foreground"> · overlapped another session</span>
        )}
      </Button>
    </Tooltip>
  )
}
