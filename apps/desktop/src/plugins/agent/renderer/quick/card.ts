/**
 * A question card, as keys move it (docs/features/quick-agent.md). Pure: the
 * card component (`QuestionCard.tsx`) feeds it actions and draws its state.
 *
 * - **1–4** answer at once: pick that option and go to the next question, or
 *   send after the last. On a multi-select they toggle instead.
 * - **⏎** takes the highlighted option, which starts on Claude's
 *   recommendation; on a multi-select it sends what is picked.
 * - **↑ ↓** move the highlight, through "Your own answer" at the end. Not in
 *   the quick panel, where they step through the dock's agents
 *   (`arrows: false`): there nothing moves the highlight off where it
 *   starts, since nothing could move it back. A pick leaves it, and leaving
 *   your own answer puts it back.
 * - **o** writes your own answer; ⏎ sends it, esc goes back to the options.
 * - **←** goes back a question.
 */
import { joinPicked, type AskAnswers, type AskQuestion } from '../../shared/questions'

export interface CardState {
  /** Which question of the call is showing. */
  index: number
  /** The highlighted row: an option, or `options.length` for your own answer. */
  highlight: number
  /** A multi-select's picked options. */
  picked: readonly number[]
  /** Your own answer while you write it; null on the options. */
  own: string | null
  answers: AskAnswers
}

export type CardAction =
  /** A number key, 1-based. */
  | { type: 'digit'; n: number }
  | { type: 'enter' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'back' }
  /** Start writing your own answer. */
  | { type: 'own' }
  | { type: 'own-text'; text: string }
  /** Leave your own answer for the options. */
  | { type: 'own-cancel' }
  /** A click on an option, 0-based. */
  | { type: 'click'; index: number }

/** The option Claude recommends: the one its label says so of, else the first. */
export function recommended(q: AskQuestion): number {
  const at = q.options.findIndex((o) => /\(recommended\)/i.test(o.label))
  return at === -1 ? 0 : at
}

export function initialCard(questions: readonly AskQuestion[]): CardState {
  return { index: 0, highlight: recommended(questions[0]!), picked: [], own: null, answers: {} }
}

/** The card after `action`, and the answers once the last question is
 *  answered. `arrows` as for `cardKey`. */
export function reduceCard(
  questions: readonly AskQuestion[],
  state: CardState,
  action: CardAction,
  { arrows = true }: { arrows?: boolean } = {},
): { state: CardState; done?: AskAnswers } {
  const q = questions[state.index]
  if (q === undefined) return { state }
  const rows = q.options.length + 1

  /** Answer this question with `answer` and move on, or finish. */
  const answer = (value: string): { state: CardState; done?: AskAnswers } => {
    const answers = { ...state.answers, [q.question]: value }
    const next = questions[state.index + 1]
    if (next === undefined) return { state: { ...state, answers, own: null }, done: answers }
    return {
      state: {
        index: state.index + 1,
        highlight: recommended(next),
        picked: [],
        own: null,
        answers,
      },
    }
  }

  // The highlight follows a pick only where ↑ ↓ can take it on from there.
  const toggle = (i: number): CardState => ({
    ...state,
    highlight: arrows ? i : state.highlight,
    picked: state.picked.includes(i)
      ? state.picked.filter((p) => p !== i)
      : [...state.picked, i].sort((a, b) => a - b),
  })

  switch (action.type) {
    case 'digit': {
      const i = action.n - 1
      if (state.own !== null || i < 0 || i >= q.options.length) return { state }
      return q.multiSelect ? { state: toggle(i) } : answer(q.options[i]!.label)
    }
    case 'click': {
      const i = action.index
      if (i < 0 || i >= q.options.length) return { state }
      return q.multiSelect ? { state: toggle(i) } : answer(q.options[i]!.label)
    }
    case 'enter': {
      if (state.own !== null) {
        return state.own.trim() === '' ? { state } : answer(state.own.trim())
      }
      if (state.highlight === q.options.length) return { state: { ...state, own: '' } }
      if (!q.multiSelect) return answer(q.options[state.highlight]!.label)
      const picked = state.picked.length > 0 ? state.picked : [state.highlight]
      return answer(joinPicked(q.options, new Set(picked)))
    }
    case 'up':
      if (state.own !== null) return { state }
      return { state: { ...state, highlight: (state.highlight - 1 + rows) % rows } }
    case 'down':
      if (state.own !== null) return { state }
      return { state: { ...state, highlight: (state.highlight + 1) % rows } }
    case 'back': {
      if (state.own !== null || state.index === 0) return { state }
      const prev = questions[state.index - 1]!
      const answers = { ...state.answers }
      delete answers[prev.question]
      delete answers[q.question]
      return {
        state: {
          index: state.index - 1,
          highlight: recommended(prev),
          picked: [],
          own: null,
          answers,
        },
      }
    }
    case 'own':
      return { state: { ...state, highlight: q.options.length, own: state.own ?? '' } }
    case 'own-text':
      return state.own === null ? { state } : { state: { ...state, own: action.text } }
    case 'own-cancel':
      return {
        state: { ...state, own: null, highlight: arrows ? state.highlight : recommended(q) },
      }
  }
}

/** The action a key press is, or null for one the card leaves alone (esc is
 *  the panel's, typing is the field's, and with `arrows: false` ↑ ↓ are the
 *  dock's). */
export function cardKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  state: CardState,
  { arrows = true }: { arrows?: boolean } = {},
): CardAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (!arrows && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return null
  if (state.own !== null) {
    if (e.key === 'Enter') return { type: 'enter' }
    if (e.key === 'Escape') return { type: 'own-cancel' }
    return null
  }
  if (/^[1-9]$/.test(e.key)) return { type: 'digit', n: Number(e.key) }
  switch (e.key) {
    case 'Enter':
      return { type: 'enter' }
    case 'ArrowUp':
      return { type: 'up' }
    case 'ArrowDown':
      return { type: 'down' }
    case 'ArrowLeft':
    case 'Backspace':
      return { type: 'back' }
    case 'o':
    case 'O':
      return { type: 'own' }
    default:
      return null
  }
}
