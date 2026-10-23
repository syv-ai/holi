/**
 * The question an agent waits on, read from its open AskUserQuestion call, and
 * the keys that answer it.
 */
import { describe, expect, test } from 'vitest'
import { foldEntries } from '../renderer/chat/fold'
import type { ChatEntry, ChatItem } from '../renderer/chat/items'
import {
  askFailed,
  keysForAll,
  keysForAnswer,
  parseQuestions,
  parseQuestionsFrom,
  pendingQuestions,
  type AskQuestion,
} from '../renderer/lib/ask'

const INPUT = {
  questions: [
    {
      question: 'Which format?',
      header: 'Format',
      multiSelect: false,
      options: [
        { label: 'PDF', description: 'portable' },
        { label: 'Word', description: '' },
      ],
    },
  ],
}
const QUESTION: AskQuestion = {
  question: 'Which format?',
  header: 'Format',
  multiSelect: false,
  options: [
    { label: 'PDF', description: 'portable' },
    { label: 'Word', description: '' },
  ],
}
const ask = (id: string, args: Record<string, unknown> = INPUT): ChatEntry => ({
  kind: 'tool',
  id,
  name: 'AskUserQuestion',
  summary: '',
  args,
})
const items = (...entries: ChatEntry[]): ChatItem[] => foldEntries(entries).items

describe('pendingQuestions', () => {
  test('reads the structured args of a call with no result', () => {
    expect(pendingQuestions(items(ask('q')))).toEqual([QUESTION])
  })
  test('reads the JSON text an older item carried as input', () => {
    const old = {
      kind: 'tool',
      id: 'q',
      name: 'AskUserQuestion',
      summary: '',
      input: JSON.stringify(INPUT),
    } as unknown as ChatItem
    expect(pendingQuestions([old])).toEqual([QUESTION])
  })
  test('is null once answered, when there is no such call, or it cannot be read', () => {
    expect(
      pendingQuestions(
        items(ask('q'), { kind: 'tool-result', id: 'q', ok: true, text: 'answered' }),
      ),
    ).toBeNull()
    expect(pendingQuestions(items({ kind: 'user', id: 'u', text: 'hi' }))).toBeNull()
    expect(pendingQuestions(items(ask('q', { questions: [{ question: 'x' }] })))).toBeNull()
  })
  test('is the latest unanswered call', () => {
    const second = {
      questions: [{ question: 'Again?', options: [{ label: 'Yes' }] }],
    }
    const got = pendingQuestions(
      items(
        ask('one'),
        { kind: 'tool-result', id: 'one', ok: true, text: 'a' },
        ask('two', second),
      ),
    )
    expect(got?.[0]?.question).toBe('Again?')
  })
})

describe('parseQuestions', () => {
  test('reads JSON text, and parsed input alike', () => {
    expect(parseQuestions(JSON.stringify(INPUT))).toEqual([QUESTION])
    expect(parseQuestionsFrom(INPUT)).toEqual([QUESTION])
    expect(parseQuestionsFrom(JSON.stringify(INPUT))).toEqual([QUESTION])
  })
  test('is null for what it cannot read', () => {
    expect(parseQuestions('{nope')).toBeNull()
    expect(parseQuestionsFrom(undefined)).toBeNull()
    expect(parseQuestionsFrom(null)).toBeNull()
    expect(parseQuestionsFrom({ questions: [] })).toBeNull()
    expect(parseQuestionsFrom({ questions: ['x'] })).toBeNull()
    expect(parseQuestionsFrom({ questions: [{ question: 'q', options: [] }] })).toBeNull()
  })
  test('a multi-select is flagged', () => {
    const got = parseQuestionsFrom({
      questions: [{ question: 'q', multiSelect: true, options: [{ label: 'a' }] }],
    })
    expect(got?.[0]?.multiSelect).toBe(true)
  })
})

describe('askFailed', () => {
  test('is true when the latest ask failed or was refused', () => {
    expect(
      askFailed(items(ask('q'), { kind: 'tool-result', id: 'q', ok: false, text: 'bad' })),
    ).toBe(true)
    expect(
      askFailed(
        items(ask('q'), {
          kind: 'tool-result',
          id: 'q',
          ok: false,
          text: "The user doesn't want to proceed",
        }),
      ),
    ).toBe(true)
  })
  test('is false while it is waiting, once answered, or with no ask', () => {
    expect(askFailed(items(ask('q')))).toBe(false)
    expect(askFailed(items(ask('q'), { kind: 'tool-result', id: 'q', ok: true, text: 'a' }))).toBe(
      false,
    )
    expect(askFailed([])).toBe(false)
  })
  test('looks at the latest ask only', () => {
    expect(
      askFailed(
        items(ask('one'), { kind: 'tool-result', id: 'one', ok: false, text: 'bad' }, ask('two')),
      ),
    ).toBe(false)
  })
})

describe('the keys that answer', () => {
  const DOWN = '\x1b[B'
  test('a single choice is arrows down then Enter', () => {
    expect(keysForAnswer(QUESTION, { picked: [1], other: '' })).toEqual([`${DOWN}\r`])
  })
  test('words of their own go to the last row', () => {
    expect(keysForAnswer(QUESTION, { picked: [], other: ' mine ' })).toEqual([
      DOWN.repeat(2),
      'mine',
      '\r',
    ])
  })
  test('a multi-select toggles in order, and several questions end on a review Enter', () => {
    const multi = { ...QUESTION, multiSelect: true }
    expect(keysForAnswer(multi, { picked: [1, 0], other: '' })).toEqual([' ', `${DOWN} `, '\r'])
    expect(
      keysForAll(
        [QUESTION, QUESTION],
        [
          { picked: [0], other: '' },
          { picked: [1], other: '' },
        ],
      ),
    ).toEqual(['\r', `${DOWN}\r`, '\r'])
  })
})
