/**
 * Completing a card, as a sequence the reader can watch (docs/features/tasks.md):
 * the check fills and ticks, the strike runs across the title, the card gives a
 * small flick, and only then does it leave for Done. Unticking runs it back.
 *
 * **The write goes first.** Acknowledgement must not wait on a file write and a
 * commit, so the status is written as the tick starts, and the card is
 * **parked**: the board keeps drawing it in the column it came from until the
 * sequence has played AND the write has landed. Only then is it released, and
 * it flies to its new column.
 *
 * **A recurring task rolls forward rather than finishing** (`completeTask`):
 * it ticks and strikes, then unwinds in place, and its due date moves when the
 * snapshot re-reads. It parks too: rolling forward returns it to Todo, and
 * from Doing that is a move.
 *
 * The glyph follows the stage, never `task.status`: the re-read lands in the
 * middle of the sequence and flips the status under it.
 */
import type { Task, TaskStatus } from '@holi/shared'
import { completeTask } from '@holi/shared'
import { useReducedMotion } from 'motion/react'
import { useRef, useState } from 'react'
import { check, instant } from '@/primitives'

type Stage = 'idle' | 'tick' | 'strike' | 'nudge' | 'settled' | 'unstrike' | 'untick'

const FILLED: Stage[] = ['tick', 'strike', 'nudge', 'settled', 'unstrike']
const STRUCK: Stage[] = ['strike', 'nudge', 'settled']
const RESTING: Stage[] = ['idle', 'settled']

export type Parking = {
  /** Draw `path` in `status`'s column until released, whatever the file says. */
  park: (path: string, status: TaskStatus) => void
  release: (path: string) => void
}

export function useCheckSequence(
  task: Task,
  today: string,
  parking: Parking,
  write: (path: string, status: TaskStatus) => Promise<unknown>,
) {
  const done = task.status === 'done'
  const [stage, setStage] = useState<Stage>(done ? 'settled' : 'idle')
  /** The write's promise, so the release can wait for it. */
  const written = useRef<Promise<unknown> | null>(null)
  /** Between the tick and the release: the card is not following the file. */
  const [inFlight, setInFlight] = useState(false)
  const rolls = useRef(false)
  const reduced = useReducedMotion() ?? false

  // The file changed under a resting card (a drag into Done, the agent, a
  // second window): follow it, without playing anything.
  if (RESTING.includes(stage) && (stage === 'settled') !== done && !inFlight) {
    setStage(done ? 'settled' : 'idle')
  }

  const finish = () => {
    const pending = written.current
    const release = () => {
      written.current = null
      setInFlight(false)
      parking.release(task.path)
    }
    if (pending) void pending.finally(release)
    else release()
  }

  const start = (to: TaskStatus, parkIn: TaskStatus | null) => {
    if (parkIn !== null) parking.park(task.path, parkIn)
    setInFlight(true)
    written.current = write(task.path, to).catch(() => {
      // The file is where it was: show that.
      written.current = null
      setInFlight(false)
      parking.release(task.path)
      setStage(done ? 'settled' : 'idle')
    })
  }

  const toggle = () => {
    if (stage === 'idle') {
      rolls.current = completeTask(task, today).status !== 'done'
      // Parked either way: a card that rolls forward returns to Todo, and one
      // ticked in Doing would otherwise jump there mid-sequence.
      start('done', task.status)
      setStage('tick')
    } else if (stage === 'settled') {
      rolls.current = false
      start('todo', 'done')
      setStage('unstrike')
    }
  }

  const onDrawn = () => {
    if (stage === 'tick') setStage('strike')
    if (stage === 'untick') {
      setStage('idle')
      finish()
    }
  }

  const onStruck = () => {
    if (stage === 'strike') {
      if (rolls.current) setStage('unstrike')
      // Reduced motion keeps the change and drops the travel: no flick.
      else if (reduced) {
        setStage('settled')
        finish()
      } else setStage('nudge')
    }
    if (stage === 'unstrike') setStage('untick')
  }

  const onFlicked = () => {
    if (stage !== 'nudge') return
    setStage('settled')
    finish()
  }

  return {
    toggle,
    filled: FILLED.includes(stage),
    struck: STRUCK.includes(stage),
    onDrawn,
    onStruck,
    /** Spread on the card: the small sideways flick at the end. */
    flick: {
      animate: { x: stage === 'nudge' ? check.nudgeX : 0 },
      transition: stage === 'nudge' ? check.nudge : instant,
      onAnimationComplete: onFlicked,
    },
  }
}
