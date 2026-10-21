/**
 * Where a quick agent is, read from Claude Code's listing and the question
 * desk (docs/features/quick-agent.md). Pure, so every reading is testable.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import type { QuickState } from '../../shared/quick'
import type { ClaudeRow } from '../claude/listing'

/** How long a session Holi just started may be missing from the listing
 *  before it counts as gone: the supervisor can take a moment to list it. */
export const START_GRACE_MS = 15_000

export function quickState(args: {
  /** Its row in the listing, if it has one. */
  row: ClaudeRow | undefined
  /** Its process is alive. */
  live: boolean
  /** Holi holds an AskUserQuestion call of its. */
  question: boolean
  /** The turn coordinator holds it in a turn: begun by its prompt, not yet
   *  ended by its `Stop` or a confirmed idle (`turn-coordinator.ts`). */
  inTurn: boolean
  /** How long ago Holi started it. */
  age: number
}): QuickState {
  const { row, live, question, inTurn, age } = args
  // A held question outranks everything: the listing says `busy` while the
  // hook waits.
  if (question) return 'question'
  if (row === undefined) return age < START_GRACE_MS ? 'working' : 'gone'
  if (row.state === 'failed') return 'failed'
  if (row.state === 'stopped') return 'gone'
  if (!live) {
    // Listed before its process is up, or after it finished and exited.
    if (row.state === 'done') return 'done'
    if (row.state === 'working') return age < START_GRACE_MS ? 'working' : 'failed'
    return 'gone'
  }
  if (row.status === 'waiting') return 'prompt'
  if (row.status === 'idle') {
    // The listing goes on saying `working` after a turn that was cut short
    // (a permission prompt declined with esc, which leaves the session
    // waiting for your next message), so an idle session is working only
    // while the coordinator holds its turn, as the session list reads it, or
    // as it starts, before its first prompt has reached the coordinator.
    if (inTurn) return 'working'
    return row.state === 'working' && age < START_GRACE_MS ? 'working' : 'done'
  }
  return 'working'
}
