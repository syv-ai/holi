/**
 * A question Holi holds for a session (docs/features/quick-agent.md): a quick
 * agent's hook keeps Claude Code from drawing its own box, so there is no
 * dialog to press keys into, and the answer goes back through the question
 * desk instead. Drawn as the quick panel draws it, the same card, in the
 * chat's place for a question and over its terminal when that is showing.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useMemo, useState } from 'react'
import type { AskAnswers, PendingQuestion } from '../../../agent/shared/questions'
import { QuestionCard } from '../../../agent/renderer/quick/QuestionCard'
import '../../../agent/renderer/quick/quick.css'
import { questionForAtom } from '../../../agent/renderer/state/questions'
import { answerHeldAtom } from '../../../agent/renderer/state/send'
import { cn } from '@/plugin-api'

/** The question Holi holds for a session, oldest first, or null. */
export function useHeldQuestion(sessionId: string): PendingQuestion | null {
  return useAtomValue(useMemo(() => questionForAtom(sessionId), [sessionId]))
}

export function HeldQuestion({
  question,
  className,
}: {
  question: PendingQuestion
  className?: string
}): React.JSX.Element {
  const answerHeld = useSetAtom(answerHeldAtom)
  const [error, setError] = useState<string | null>(null)
  const answer = useCallback(
    (answers: AskAnswers) => {
      void answerHeld({ id: question.id, answers }).then((res) =>
        setError(res.ok ? null : res.message),
      )
    },
    [answerHeld, question.id],
  )
  return (
    // The HUD is dark in either scheme, as the quick panel is.
    <div data-theme="dark" data-held-question={question.id} className={className}>
      <div
        data-light="asking"
        data-surface="overlay"
        className={cn('quick-hud pointer-events-auto relative w-full p-4 pb-3')}
      >
        <QuestionCard key={question.id} question={question} onAnswer={answer} keys="focus" />
        {error !== null && <p className="pt-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}
