/**
 * A quick agent's question, answered with the keyboard
 * (docs/features/quick-agent.md): in its quick panel, and over its session's
 * tab in the main window. The keys are `card.ts`'s; this draws its state.
 *
 * `keys` says where the keys come from: the whole window (the panel, which is
 * nothing but this card while it asks) or only while the card has focus (the
 * main window, where the terminal beside it has keys of its own). In the
 * panel ↑ ↓ are the dock's, stepping to the agent above or below, and esc
 * puts the panel away (`arrows={false}`): the foot names those instead.
 *
 * One card per call: a caller keys it by the call's id, so a new call starts
 * a new card.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AskAnswers, PendingQuestion } from '../../shared/questions'
import {
  cardKey,
  initialCard,
  isRecommended,
  reduceCard,
  type CardAction,
  type CardState,
} from './card'
import { Button, Input } from '@/primitives'

/** An option's label without the "(Recommended)" Claude marks it with: the
 *  card says so with its own badge. */
const plainLabel = (label: string): string => label.replace(/\s*\(recommended\)\s*/i, ' ').trim()

export function QuestionCard({
  question,
  onAnswer,
  keys,
  arrows = true,
  waiting,
}: {
  question: PendingQuestion
  onAnswer(answers: AskAnswers): void
  keys: 'window' | 'focus'
  /** Whether ↑ ↓ move the highlight. False in the quick panel, where they
   *  step through the dock's agents. */
  arrows?: boolean
  /** Showing without the keyboard: the dock's key, which gives it the
   *  keyboard and which the foot names. Absent while it has the keyboard. */
  waiting?: string | null
}): React.JSX.Element {
  const { questions } = question
  const [state, setState] = useState<CardState>(() => initialCard(questions))
  const stateRef = useRef(state)
  stateRef.current = state
  const sent = useRef(false)

  const act = useCallback(
    (action: CardAction) => {
      if (sent.current) return
      const { state: next, done } = reduceCard(questions, stateRef.current, action, { arrows })
      stateRef.current = next
      setState(next)
      if (done !== undefined) {
        sent.current = true
        onAnswer(done)
      }
    },
    [questions, onAnswer, arrows],
  )

  const onKey = useCallback(
    (e: KeyboardEvent | React.KeyboardEvent) => {
      const action = cardKey(e, stateRef.current, { arrows })
      if (action === null) return
      e.preventDefault()
      e.stopPropagation()
      act(action)
    },
    [act, arrows],
  )

  useEffect(() => {
    if (keys !== 'window') return
    const listener = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [keys, onKey])

  const q = questions[state.index]!
  const ownRow = q.options.length
  const writing = state.own !== null

  const rows = useMemo(
    () =>
      q.options.map((option, i) => ({
        i,
        label: plainLabel(option.label),
        description: option.description,
        recommended: isRecommended(option.label),
      })),
    [q],
  )

  return (
    <div
      // The main window's card takes keys while it has focus; the panel's
      // listens on the window.
      tabIndex={keys === 'focus' ? 0 : -1}
      onKeyDown={keys === 'focus' ? (e) => onKey(e) : undefined}
      data-quick-card
      data-writing={writing}
      className="flex flex-col gap-3 outline-none"
    >
      {/* In the column the option titles share, the keycaps hanging left of it. */}
      <div className="flex flex-col gap-1.5 pl-[31px]">
        {(q.header !== undefined || q.multiSelect || questions.length > 1) && (
          // `gap-1`: the dot of "TAGS · PICK ANY" sits centred between them.
          <div className="flex items-center gap-1">
            {q.header !== undefined && <span className="quick-tag shrink-0">{q.header}</span>}
            {/* A multi-select says so before the first key, not only in its foot. */}
            {q.multiSelect && (
              <span className="quick-label shrink-0">
                {q.header !== undefined ? '· ' : ''}pick any
              </span>
            )}
            {questions.length > 1 && (
              <span className="quick-label ml-auto shrink-0 tracking-[0.04em]">
                {state.index + 1}/{questions.length}
              </span>
            )}
          </div>
        )}
        <p className="text-[15px] font-medium leading-snug text-foreground">{q.question}</p>
      </div>

      {/* Bled into the margin, so the keycaps sit in the question's column and
          the highlight reaches past it. */}
      <div className="-mx-2.5 flex flex-col gap-0.5" role="listbox" aria-label={q.question}>
        {rows.map((row) => {
          const active = !writing && state.highlight === row.i
          const picked = state.picked.includes(row.i)
          return (
            <Button
              key={row.i}
              variant="ghost"
              role="option"
              // The card is driven by its own keys, never by tabbing through it.
              tabIndex={-1}
              aria-selected={q.multiSelect ? picked : active}
              data-active={active}
              data-own={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => act({ type: 'click', index: row.i })}
              className="quick-row h-auto w-full items-start justify-start gap-3 whitespace-normal px-2.5 py-2 text-left font-normal motion-respond hover:bg-foreground/5 focus-visible:ring-0"
            >
              {/* On a multi-select the key is the box: filled once picked. */}
              <span
                className="quick-key shrink-0 motion-respond"
                data-picked={q.multiSelect && picked}
              >
                {row.i + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-px">
                <span className="flex items-baseline gap-2 text-[13px] leading-[17px] text-foreground">
                  <span className="min-w-0">{row.label}</span>
                  {row.recommended && <span className="quick-badge shrink-0">recommended</span>}
                </span>
                {row.description !== undefined && (
                  <span className="text-[12px] leading-snug text-muted-foreground">
                    {row.description}
                  </span>
                )}
              </span>
            </Button>
          )
        })}

        <div
          data-active={state.highlight === ownRow}
          data-own
          className="quick-row flex items-center gap-3 px-2.5 py-2 motion-respond"
        >
          {/* Lowercase, as the key is pressed: a capital O reads as a zero. */}
          <span className="quick-key shrink-0 motion-respond">o</span>
          {writing ? (
            <Input
              variant="bare"
              autoFocus
              aria-label="Your own answer"
              placeholder="Your own answer, then ⏎"
              value={state.own ?? ''}
              onChange={(e) => act({ type: 'own-text', text: e.target.value })}
              onKeyDown={(e) => onKey(e)}
              className="quick-input text-[13px]"
            />
          ) : (
            <Button
              variant="ghost"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => act({ type: 'own' })}
              className="h-auto flex-1 justify-start p-0 text-[13px] font-normal text-muted-foreground hover:bg-transparent focus-visible:ring-0"
            >
              Your own answer…
            </Button>
          )}
        </div>
      </div>

      <Foot>
        {waiting !== undefined ? (
          <WaitingHint hotkey={waiting} />
        ) : writing ? (
          <>
            <Hint keys="⏎" primary>
              send
            </Hint>
            <Hint keys="esc">back to the options</Hint>
          </>
        ) : (
          <>
            <Hint keys={`1–${q.options.length}`}>{q.multiSelect ? 'pick' : 'answer'}</Hint>
            <Hint keys="⏎" primary>
              {q.multiSelect ? 'send picked' : 'take highlighted'}
            </Hint>
            <Hint keys="↑↓">{arrows ? 'move' : 'agents'}</Hint>
            {state.index > 0 && <Hint keys="←">back</Hint>}
            {!arrows && <Hint keys="esc">close</Hint>}
          </>
        )}
      </Foot>
    </div>
  )
}

/** The keys a panel answers, along its foot. */
export function Foot({ children }: { children: React.ReactNode }) {
  return <div className="quick-foot flex flex-wrap items-center gap-x-4 gap-y-1">{children}</div>
}

/**
 * A key and what it does, for the row of hints under a panel. `primary` is
 * the panel's main thing, its key lit in the light's colour.
 */
export function Hint({
  keys,
  primary = false,
  children,
}: {
  keys: string
  primary?: boolean
  children: React.ReactNode
}) {
  return (
    // Whole or not at all: a foot that runs out of room wraps between hints.
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
      <span className="quick-key" data-primary={primary} data-word={/^[a-z]{2,}$/i.test(keys)}>
        {keys}
      </span>
      {children}
    </span>
  )
}

/** The foot of a panel out beside the dock without the keyboard: the key
 *  that gives it the keyboard, the dock's. */
export function WaitingHint({ hotkey }: { hotkey: string | null }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      Press
      {hotkey === null ? (
        ' the dock key '
      ) : (
        <span className="quick-key" data-primary>
          {hotkey}
        </span>
      )}
      to answer
    </span>
  )
}
