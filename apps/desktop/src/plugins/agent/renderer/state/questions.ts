/**
 * The questions the open vault's quick agents are waiting on, for the card
 * over a session's tab (docs/features/quick-agent.md). Main pushes the list
 * as the agent's `questions` event whenever it changes.
 */
import { atom } from 'jotai'
import type { PendingQuestion } from '../../shared/questions'

export const agentQuestionsAtom = atom<readonly PendingQuestion[]>([])

/** The question a session is waiting on, oldest first, if any. */
export const questionForAtom = (sessionId: string | null) =>
  atom((get) =>
    sessionId === null ? null : (get(agentQuestionsAtom).find((q) => q.job === sessionId) ?? null),
  )

/**
 * A session the quick panel asked the main window to show (its ⏎ on a finished
 * agent). Held until the vault it is in is the one showing: a window just
 * opened for it has not opened its vault yet.
 */
export const pendingOpenAtom = atom<{ remote: string; id: string } | null>(null)
