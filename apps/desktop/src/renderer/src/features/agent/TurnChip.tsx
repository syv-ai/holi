/**
 * The footer's word on what the agent's last turn changed (D88, #4).
 *
 * Once the drawer is closed this is the only thing that says a turn happened at
 * all, which is the same gap #15 closed for a running session. It is a count and
 * a door, nothing more: what changed is the panel's job.
 *
 * **A turn ENDING is the event.** `agent:status` already pushes on every
 * `setTurnActive`, so this watches `working` go true → false rather than polling
 * for a record. Reloading while it is still true would read the previous turn,
 * because the record for this one is written in that same handler.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { Button, Tooltip } from '@/primitives'
import { agentStatusAtom } from '@/state/agent'
import {
  latestTurnAtom,
  loadLatestTurnAtom,
  loadTurnFilesAtom,
  turnFilesAtom,
  turnReviewOpenAtom,
} from '@/state/turns'

export function TurnChip(): React.JSX.Element | null {
  const { working } = useAtomValue(agentStatusAtom)
  const turn = useAtomValue(latestTurnAtom)
  const files = useAtomValue(turnFilesAtom)
  const loadLatest = useSetAtom(loadLatestTurnAtom)
  const loadFiles = useSetAtom(loadTurnFilesAtom)
  const setOpen = useSetAtom(turnReviewOpenAtom)
  const wasWorking = useRef(working)

  // On mount, and on each turn that ends. The edge, not the level: `working`
  // stays false between turns and this must not re-ask on every unrelated push.
  useEffect(() => {
    const ended = wasWorking.current && !working
    wasWorking.current = working
    if (working) return
    if (ended || turn === null) void loadLatest()
  }, [working, turn, loadLatest])

  // The count comes from the range, so the files follow the record.
  useEffect(() => {
    if (turn !== null) void loadFiles()
  }, [turn, loadFiles])

  // A turn with no reachable files has nothing to open onto. The panel has
  // something to say about that state; the footer does not.
  if (turn === null || files.length === 0) return null

  const count = `${files.length} ${files.length === 1 ? 'file' : 'files'}`
  return (
    <Tooltip content="See what the assistant's last turn changed, and take any of it back">
      <Button
        variant="link"
        // The footer is `text-xs`; Button's own `text-sm font-medium` would put
        // this a size and a weight above everything around it.
        className="h-auto shrink-0 p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        Claude changed {count}
      </Button>
    </Tooltip>
  )
}
