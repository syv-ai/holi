/**
 * A quick agent's light (docs/features/quick-agent.md): which of the
 * `--agent-*` colours its state is, and the words for it. One table for its
 * panel and its dot in the dock, so the two never disagree.
 */
import type { QuickState } from '../../shared/quick'

/** The lights, as the HUD's CSS names them (`data-light`). */
export type Light = 'working' | 'asking' | 'done' | 'failed'

export const LIGHT: Record<QuickState, Light> = {
  working: 'working',
  question: 'asking',
  prompt: 'asking',
  done: 'done',
  failed: 'failed',
  // A stopped agent is on its way out of the dock: the last thing it was.
  gone: 'done',
}

export const STATE_WORDS: Record<QuickState, string> = {
  working: 'working',
  question: 'needs you',
  prompt: 'needs you',
  done: 'done',
  failed: 'failed',
  gone: 'stopped',
}
