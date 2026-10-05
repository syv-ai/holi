/**
 * What a chat shows for a session that waits on you, so nobody has to open
 * the terminal for it: a permission prompt (the call, with Allow and Deny) or
 * a question (`AskUserQuestion`: its options one question at a time, single or
 * multiple choice, or the person's own words), the answers sent together as
 * the key presses that answer Claude Code's dialog (`lib/ask`).
 *
 * Used by the smaller chat and the full chat alike. Only a dialog this cannot
 * read at all is handed over (`onFallback`), and a question whose call has not
 * reached the transcript yet is waited for, never handed over.
 */
import { ArrowLeft, HelpCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Icon, Input } from '@/primitives'
import {
  EMPTY_ANSWER,
  isAnswered,
  keysForAll,
  type AskAnswer,
  type AskQuestion,
} from '../../../agent/renderer/lib/ask'

const ENTER = '\r'
const ESCAPE = '\x1b'
/** The dialog redraws between one key run and the next; a key sent into the
 *  redraw is lost. */
const STEP_MS = 120
/** How long a question that is not readable yet is waited for before the
 *  terminal is offered: it may never come. */
const READ_MS = 4000

const PILL =
  'shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400'
const CARD = 'rounded-2xl border border-border/60 bg-muted/20 p-3 text-sm'

type Pressed = Promise<{ ok: true } | { ok: false; message: string }>

export function QuickAsk({
  waitingFor,
  tool,
  questions,
  press,
  fallbackLabel,
  onFallback,
}: {
  waitingFor: string | undefined
  /** The call it asks to run, as `Bash: ls`, when the transcript shows one. */
  tool: string
  /** Its open question, when the transcript has it. */
  questions: AskQuestion[] | null
  /** Press keys in the session's terminal. */
  press: (keys: string) => Pressed
  /** What a dialog this cannot draw offers, and where it goes. */
  fallbackLabel: string
  onFallback: () => void
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<AskAnswer[]>([])
  const [otherOpen, setOtherOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (keys: string[]): Promise<void> => {
    setSending(true)
    setError(null)
    for (const [i, k] of keys.entries()) {
      if (i > 0) await new Promise((done) => setTimeout(done, STEP_MS))
      const res = await press(k)
      if (!res.ok) {
        setSending(false)
        return setError(res.message)
      }
    }
    // Answered: the session leaves needs-you and this card goes with it. If it
    // did not (a key did not take), the card is usable again.
    setSending(false)
  }

  const permission = waitingFor === 'permission prompt'
  const unreadable = !permission && questions === null
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    setGaveUp(false)
    if (!unreadable) return
    const timer = setTimeout(() => setGaveUp(true), READ_MS)
    return () => clearTimeout(timer)
  }, [unreadable])

  if (!permission && questions !== null) {
    const q = questions[Math.min(step, questions.length - 1)]!
    const last = step === questions.length - 1
    const answer = answers[step] ?? EMPTY_ANSWER
    const setAnswer = (next: AskAnswer): void =>
      setAnswers((all) => {
        const copy = [...all]
        copy[step] = next
        return copy
      })
    const goTo = (to: number): void => {
      setStep(to)
      setOtherOpen(false)
    }
    /** This question is answered: on to the next, or send them all. */
    const advance = (done: AskAnswer): void => {
      const all = [...answers]
      all[step] = done
      if (!last) {
        setAnswers(all)
        return goTo(step + 1)
      }
      void run(keysForAll(questions, all))
    }
    const choose = (index: number): void => {
      if (q.multiSelect) {
        const picked = answer.picked.includes(index)
          ? answer.picked.filter((i) => i !== index)
          : [...answer.picked, index]
        return setAnswer({ picked, other: '' })
      }
      // One choice per question: picking IS the answer.
      advance({ picked: [index], other: '' })
    }
    const ready = isAnswered(answer)
    // A single choice already advanced on its press; the button is for the
    // answers that are not one press: several choices, or words.
    const needsButton = q.multiSelect || otherOpen

    return (
      <div data-quick-needs-you="question" className={CARD}>
        <div className="flex items-start gap-2.5">
          <Icon icon={HelpCircle} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-foreground">{q.question}</p>
              <span className={PILL}>
                {questions.length > 1 ? `${step + 1}/${questions.length}` : 'Needs you'}
              </span>
            </div>
            <div
              role={q.multiSelect ? 'group' : 'radiogroup'}
              aria-label={q.question}
              className="mt-2 flex flex-col gap-1"
            >
              {q.options.map((option, i) => {
                const on = answer.picked.includes(i) && answer.other.trim() === ''
                return (
                  <Button
                    key={option.label}
                    variant="ghost"
                    size="sm"
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    disabled={sending}
                    onClick={() => choose(i)}
                    className="h-auto w-full flex-col items-start gap-0 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 text-left font-normal whitespace-normal hover:border-ring/60 aria-checked:border-ring"
                  >
                    <span className="text-xs text-foreground">
                      {option.label}
                      {i === 0 && !q.multiSelect && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">Suggested</span>
                      )}
                    </span>
                    {option.description !== '' && (
                      <span className="line-clamp-2 text-[11px] text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </Button>
                )
              })}
              {/* Claude Code's dialog always ends on "Other": the person's own
                  words, which win over a picked option. */}
              {otherOpen ? (
                <Input
                  autoFocus
                  value={answer.other}
                  disabled={sending}
                  aria-label={q.question}
                  placeholder="Write your own answer…"
                  className="h-8 text-xs"
                  onChange={(event) => setAnswer({ picked: [], other: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && ready && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      advance(answer)
                    }
                  }}
                />
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={sending}
                  className="h-auto w-fit px-1 py-0.5 text-xs font-normal text-muted-foreground"
                  onClick={() => setOtherOpen(true)}
                >
                  Write another answer
                </Button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              {step > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Previous question"
                  disabled={sending}
                  onClick={() => goTo(step - 1)}
                >
                  <Icon icon={ArrowLeft} />
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={sending}
                onClick={() => void run([ESCAPE])}
              >
                Cancel
              </Button>
              {needsButton && (
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={!ready || sending}
                  onClick={() => advance(answer)}
                >
                  {last ? 'Send answer' : 'Next'}
                </Button>
              )}
            </div>
            {error !== null && <p className="pt-1 text-xs text-destructive">{error}</p>}
          </div>
        </div>
      </div>
    )
  }

  // Waiting on a question not readable yet (transcript or job record): it is
  // written a moment after the dialog opens, and this looks again each second.
  const reading = !permission && waitingFor === 'input needed' && !gaveUp

  return (
    <div
      data-quick-needs-you={permission ? 'permission' : reading ? 'reading' : 'other'}
      className={CARD}
    >
      <div className="flex items-start gap-2.5">
        <Icon icon={ShieldCheck} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {permission
                  ? 'Allow this to run?'
                  : reading
                    ? 'Reading its question…'
                    : 'Claude is waiting for you'}
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {permission && tool !== '' ? tool : (waitingFor ?? 'It has a question')}
              </p>
            </div>
            <span className={PILL}>{permission ? 'Approval required' : 'Needs you'}</span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {permission && (
              <>
                <Button size="sm" disabled={sending} onClick={() => void run([ENTER])}>
                  Allow
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sending}
                  onClick={() => void run([ESCAPE])}
                >
                  Deny
                </Button>
              </>
            )}
            {!permission && (
              <Button
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() => void run([ESCAPE])}
              >
                Cancel
              </Button>
            )}
            {!reading && (
              <Button size="sm" variant="ghost" onClick={onFallback}>
                {fallbackLabel}
              </Button>
            )}
          </div>
          {error !== null && <p className="pt-1 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  )
}
