/**
 * An agent tab: its terminal, and under it the turn chip for the session it
 * was opened for. Kept mounted while hidden (`Surface.keepMounted`): an
 * unmounted terminal loses its scrollback and must visibly replay main's
 * mirror.
 *
 * Over the terminal of a quick agent that is asking something, its question
 * card: the hook holds the question for Holi, so the terminal itself shows
 * only that a hook is running (docs/features/quick-agent.md).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useMemo } from 'react'
import type { AskAnswers } from '../shared/questions'
import { QuestionCard } from './quick/QuestionCard'
import { agentCap } from './agent-cap'
import './quick/quick.css'
import { questionForAtom } from './state/questions'
import {
  agentGeometryAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  sessionTitled,
} from './state/sessions'
import { SessionTerminal } from './SessionTerminal'
import { TurnChip } from './TurnChip'
import { activeRemoteAtom } from '@/plugin-api'

/**
 * The session an agent tab shows, as far as Holi can say: the one its title
 * names, else the one Holi opened it for.
 */
function useTabSession(terminalId: string): string | null {
  const terminals = useAtomValue(agentTerminalsAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const terminal = terminals.find((t) => t.id === terminalId)
  if (terminal === undefined) return null
  return sessionTitled(terminal, sessions)?.id ?? terminal.launchedFor
}

/** The question card over a quick agent's terminal, while it asks. */
function AgentQuestion({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const sessionId = useTabSession(terminalId)
  const question = useAtomValue(useMemo(() => questionForAtom(sessionId), [sessionId]))
  const remote = useAtomValue(activeRemoteAtom)
  const answer = useCallback(
    (answers: AskAnswers) => {
      if (remote !== null && question !== null) {
        void agentCap.answer(remote, { id: question.id, answers })
      }
    },
    [remote, question],
  )
  if (question === null) return null
  return (
    // The HUD is dark in either scheme, as the terminal under it is. Inside
    // the terminal's own box, over a fade that lets its last lines go quiet.
    <div
      data-theme="dark"
      className="pointer-events-none absolute inset-x-6 bottom-4 flex justify-center"
    >
      <div
        aria-hidden
        className="absolute inset-x-0 -top-24 bottom-0 bg-linear-to-t from-background from-70% to-transparent motion-in-fade"
      />
      <div
        data-light="asking"
        data-surface="overlay"
        className="quick-hud pointer-events-auto relative mb-4 w-full max-w-xl p-4 pb-3 motion-in-bottom"
      >
        <QuestionCard key={question.id} question={question} onAnswer={answer} keys="focus" />
      </div>
    </div>
  )
}

/**
 * The turn chip for the session an agent tab was opened for. The agents list,
 * and a tab whose terminal Holi did not open for a session, have none: nothing
 * published says which session they show.
 */
function AgentTurnChip({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const terminals = useAtomValue(agentTerminalsAtom)
  const sessionId = terminals.find((t) => t.id === terminalId)?.launchedFor ?? null
  if (sessionId === null) return null
  return (
    <div className="shrink-0 border-t border-divider px-2 py-1">
      {/* Keyed, so the chip's "just landed" refs belong to one session. */}
      <TurnChip key={sessionId} sessionId={sessionId} />
    </div>
  )
}

export function AgentSurface({
  id,
  visible,
}: {
  id?: string
  visible: boolean
}): React.JSX.Element | null {
  /** The last geometry a visible terminal measured, for sessions spawned
   *  without a tab of their own to measure. */
  const setGeometry = useSetAtom(agentGeometryAtom)
  if (id === undefined) return null
  return (
    <>
      <div className={visible ? 'relative flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <SessionTerminal
          terminalId={id}
          visible={visible}
          onGeometry={(cols, rows) => setGeometry({ cols, rows })}
        />
        {visible && <AgentQuestion terminalId={id} />}
      </div>
      <AgentTurnChip terminalId={id} />
    </>
  )
}
