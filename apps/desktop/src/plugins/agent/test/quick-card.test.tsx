import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  cardKey,
  initialCard,
  recommended,
  reduceCard,
  type CardState,
} from '../renderer/quick/card'
import { QuestionCard } from '../renderer/quick/QuestionCard'
import type { AskQuestion, PendingQuestion } from '../shared/questions'

const NAMES: AskQuestion = {
  question: 'Which naming scheme?',
  header: 'Names',
  multiSelect: false,
  options: [
    { label: 'Title only', description: 'No date' },
    { label: 'Date first (Recommended)', description: 'YYYY-MM-DD title' },
    { label: 'Keep as is' },
  ],
}
const TAGS: AskQuestion = {
  question: 'Which tags?',
  multiSelect: true,
  options: [{ label: 'work' }, { label: 'home' }, { label: 'later' }],
}

const play = (questions: AskQuestion[], options: { arrows?: boolean }, keys: string[]) => {
  let state: CardState = initialCard(questions)
  let done: Record<string, string> | undefined
  for (const key of keys) {
    const action = cardKey({ key, metaKey: false, ctrlKey: false, altKey: false }, state, options)
    if (action === null) continue
    const next = reduceCard(questions, state, action, options)
    state = next.state
    done = next.done ?? done
  }
  return { state, done }
}

/** Keys on the card over a session's tab in the main window. */
const run = (questions: AskQuestion[], ...keys: string[]) => play(questions, {}, keys)
/** Keys on the card in a quick panel, where ↑ ↓ are the dock's. */
const inPanel = (questions: AskQuestion[], ...keys: string[]) =>
  play(questions, { arrows: false }, keys)

describe('the card', () => {
  it("starts on Claude's recommendation", () => {
    expect(recommended(NAMES)).toBe(1)
    expect(initialCard([NAMES]).highlight).toBe(1)
    expect(recommended(TAGS)).toBe(0)
  })

  it('answers at once on a number, ⏎ on the highlight', () => {
    expect(run([NAMES], '3').done).toEqual({ 'Which naming scheme?': 'Keep as is' })
    expect(run([NAMES], 'Enter').done).toEqual({
      'Which naming scheme?': 'Date first (Recommended)',
    })
    expect(run([NAMES], 'ArrowUp', 'Enter').done).toEqual({ 'Which naming scheme?': 'Title only' })
    expect(run([NAMES], '9').done).toBeUndefined()
  })

  it('toggles a multi-select on numbers, and sends the picks on ⏎', () => {
    expect(run([TAGS], '3', '1', 'Enter').done).toEqual({ 'Which tags?': 'work, later' })
    expect(run([TAGS], '1', '1', 'Enter').done).toEqual({ 'Which tags?': 'work' })
  })

  it('goes question by question, and back', () => {
    const { state, done } = run([NAMES, TAGS], '1')
    expect(done).toBeUndefined()
    expect(state.index).toBe(1)
    expect(run([NAMES, TAGS], '1', 'ArrowLeft').state.index).toBe(0)
    expect(run([NAMES, TAGS], '1', '2', 'Enter').done).toEqual({
      'Which naming scheme?': 'Title only',
      'Which tags?': 'home',
    })
  })

  it('takes your own words on O, and esc returns to the options', () => {
    let state = initialCard([NAMES])
    state = reduceCard([NAMES], state, { type: 'own' }).state
    // Typing is the field's: number keys are words now.
    expect(cardKey({ key: '1', metaKey: false, ctrlKey: false, altKey: false }, state)).toBeNull()
    state = reduceCard([NAMES], state, { type: 'own-text', text: 'by project' }).state
    expect(reduceCard([NAMES], state, { type: 'enter' }).done).toEqual({
      'Which naming scheme?': 'by project',
    })
    expect(reduceCard([NAMES], state, { type: 'own-cancel' }).state.own).toBeNull()
  })

  it("gives ↑ ↓ away when the arrows are the dock's", () => {
    const state = initialCard([NAMES])
    const key = (k: string) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false })
    expect(cardKey(key('ArrowDown'), state, { arrows: false })).toBeNull()
    expect(cardKey(key('ArrowUp'), state, { arrows: false })).toBeNull()
    expect(cardKey(key('ArrowDown'), state)).toEqual({ type: 'down' })
    // Everything else is the card's still.
    expect(cardKey(key('2'), state, { arrows: false })).toEqual({ type: 'digit', n: 2 })
    expect(cardKey(key('Enter'), state, { arrows: false })).toEqual({ type: 'enter' })
  })

  it("in the quick panel, never leaves the highlight off Claude's recommendation", () => {
    // Your own answer, then esc: ⏎ takes the recommendation, not the empty field.
    expect(inPanel([NAMES], 'o', 'Escape', 'Enter').done).toEqual({
      'Which naming scheme?': 'Date first (Recommended)',
    })
    // A pick and an unpick: ⏎ with nothing picked takes the recommendation,
    // not the option just unpicked.
    expect(inPanel([TAGS], '2', '2').state.highlight).toBe(0)
    expect(inPanel([TAGS], '2', '2', 'Enter').done).toEqual({ 'Which tags?': 'work' })
    // What is picked still goes on ⏎ after your own answer was left.
    expect(inPanel([TAGS], '1', '3', 'o', 'Escape', 'Enter').done).toEqual({
      'Which tags?': 'work, later',
    })
    // Over the tab, ↑ ↓ can take it on, so it follows a pick there.
    expect(run([TAGS], '2', '2').state.highlight).toBe(1)
  })

  it('leaves modified keys and esc alone', () => {
    const state = initialCard([NAMES])
    expect(cardKey({ key: '1', metaKey: true, ctrlKey: false, altKey: false }, state)).toBeNull()
    expect(
      cardKey({ key: 'Escape', metaKey: false, ctrlKey: false, altKey: false }, state),
    ).toBeNull()
  })
})

describe('QuestionCard', () => {
  const question: PendingQuestion = { id: 'q1', job: 'quick001', questions: [NAMES], askedAt: 0 }

  it('answers from the window on a number key', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard question={question} onAnswer={onAnswer} keys="window" />)
    expect(screen.getByText('recommended')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '2' })
    expect(onAnswer).toHaveBeenCalledWith({ 'Which naming scheme?': 'Date first (Recommended)' })
  })

  it('in the main window, takes keys only while it has focus', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard question={question} onAnswer={onAnswer} keys="focus" />)
    fireEvent.keyDown(window, { key: '1' })
    expect(onAnswer).not.toHaveBeenCalled()
    const card = document.querySelector('[data-quick-card]')!
    fireEvent.keyDown(card, { key: '1' })
    expect(onAnswer).toHaveBeenCalledWith({ 'Which naming scheme?': 'Title only' })
  })

  it('in the quick panel, leaves ↑ ↓ to the dock, and says so in its foot', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard question={question} onAnswer={onAnswer} keys="window" arrows={false} />)
    expect(screen.getByText('agents')).toBeInTheDocument()
    expect(screen.getByText('close')).toBeInTheDocument()
    expect(screen.queryByText('move')).toBeNull()
    // The highlight stays on Claude's recommendation.
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith({ 'Which naming scheme?': 'Date first (Recommended)' })
  })

  it('in the quick panel, goes back to the recommendation from your own answer', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard question={question} onAnswer={onAnswer} keys="window" arrows={false} />)
    fireEvent.keyDown(window, { key: 'o' })
    fireEvent.keyDown(screen.getByLabelText('Your own answer'), { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith({ 'Which naming scheme?': 'Date first (Recommended)' })
  })

  it('names the dock key while it waits for the keyboard', () => {
    render(<QuestionCard question={question} onAnswer={vi.fn()} keys="window" waiting="⌃⌘J" />)
    expect(screen.getByText('⌃⌘J')).toBeInTheDocument()
    expect(screen.getByText(/to answer/)).toBeInTheDocument()
  })

  it('answers on a click, and once only', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard question={question} onAnswer={onAnswer} keys="window" />)
    fireEvent.click(screen.getByText('Keep as is'))
    fireEvent.keyDown(window, { key: '1' })
    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith({ 'Which naming scheme?': 'Keep as is' })
  })
})
