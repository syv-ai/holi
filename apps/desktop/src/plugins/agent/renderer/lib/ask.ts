/**
 * The question an agent is waiting on, read from its open `AskUserQuestion`
 * call in the transcript, and the keys that answer it in Claude Code's dialog.
 * Pure.
 *
 * The chat draws the question itself so nobody has to open the terminal for
 * it. Only a call that cannot be read (no options, a shape this does not know)
 * is left to the terminal.
 */
import type { ChatItem } from '../chat/items'

export interface AskOption {
  label: string
  description: string
}

export interface AskQuestion {
  question: string
  header: string
  options: AskOption[]
  /** Several options may be chosen. */
  multiSelect: boolean
}

/** What was chosen for one question: option indexes (one, or several for a
 *  multi-select), or words of the person's own in place of an option. */
export interface AskAnswer {
  picked: number[]
  other: string
}

export const EMPTY_ANSWER: AskAnswer = { picked: [], other: '' }

/** Whether a question has an answer worth sending. */
export const isAnswered = (a: AskAnswer | undefined): boolean =>
  a !== undefined && (a.other.trim() !== '' || a.picked.length > 0)

/** Claude Code's name for the tool that asks the person something. */
const ASK_TOOL = 'AskUserQuestion'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The questions of the call still waiting for an answer, or null when the
 *  session is not asking one, or asks one this cannot read. A call is waiting
 *  while it has no result. */
export function pendingQuestions(items: readonly ChatItem[]): AskQuestion[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind !== 'tool' || item.name !== ASK_TOOL || item.result !== undefined) continue
    return parseQuestionsFrom(inputOf(item))
  }
  return null
}

/** A call's input: the structured `args`, or the JSON text an older item
 *  carried as `input`. */
function inputOf(item: object): unknown {
  const { args, input } = item as { args?: unknown; input?: unknown }
  if (args !== undefined && args !== null && typeof args === 'object') return args
  return typeof input === 'string' ? input : undefined
}

/** The questions in an `AskUserQuestion` input's JSON, or null when it has
 *  none this can read. */
export function parseQuestions(json: string): AskQuestion[] | null {
  let input: unknown
  try {
    input = JSON.parse(json)
  } catch {
    return null
  }
  return parseQuestionsFrom(input)
}

/** The questions in an `AskUserQuestion` input already parsed (a call's
 *  `args`), or null when it has none this can read. A string is taken as the
 *  input's JSON. */
export function parseQuestionsFrom(input: unknown): AskQuestion[] | null {
  if (typeof input === 'string') return parseQuestions(input)
  const raw = (input as { questions?: unknown } | null | undefined)?.questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: AskQuestion[] = []
  for (const q of raw as unknown[]) {
    if (q === null || typeof q !== 'object') return null
    const r = q as Record<string, unknown>
    if (!Array.isArray(r['options'])) return null
    const options = (r['options'] as unknown[]).flatMap((o) => {
      const label =
        o !== null && typeof o === 'object' ? text((o as Record<string, unknown>)['label']) : ''
      return label === ''
        ? []
        : [{ label, description: text((o as Record<string, unknown>)['description']) }]
    })
    if (text(r['question']) === '' || options.length === 0) return null
    questions.push({
      question: text(r['question']),
      header: text(r['header']),
      options,
      multiSelect: r['multiSelect'] === true,
    })
  }
  return questions
}

/** Whether the latest `AskUserQuestion` call was refused (its input could not
 *  be read, say): Claude Code opened no dialog for it, so the session is not
 *  waiting on anyone, whatever its status still says. */
export function askFailed(items: readonly ChatItem[]): boolean {
  const call = [...items].reverse().find((i) => i.kind === 'tool' && i.name === ASK_TOOL)
  return (
    call !== undefined &&
    call.kind === 'tool' &&
    (call.state === 'error' || call.state === 'rejected' || call.result?.ok === false)
  )
}

const DOWN = '\x1b[B'
const ENTER = '\r'
const SPACE = ' '

/**
 * The key presses that answer one question in the dialog's list, as chunks
 * to send one after another (the dialog redraws between them).
 *
 * The cursor starts on the first option, so choosing is that many arrows down
 * and Enter. A multi-select toggles each chosen option with Space, walking
 * down in order, then Enter. The dialog's own last row, "Other", is the
 * person's words: arrow down to it, type, Enter.
 */
export function keysForAnswer(question: AskQuestion, answer: AskAnswer): string[] {
  const other = answer.other.trim()
  if (other !== '') return [DOWN.repeat(question.options.length), other, ENTER]
  if (!question.multiSelect) return [DOWN.repeat(answer.picked[0] ?? 0) + ENTER]
  const chunks: string[] = []
  let cursor = 0
  for (const index of [...answer.picked].sort((a, b) => a - b)) {
    chunks.push(DOWN.repeat(index - cursor) + SPACE)
    cursor = index
  }
  chunks.push(ENTER)
  return chunks
}

/** Every question's keys in order; a dialog with several ends on a review
 *  page that one more Enter confirms. */
export function keysForAll(
  questions: readonly AskQuestion[],
  answers: readonly AskAnswer[],
): string[] {
  const chunks = questions.flatMap((q, i) => keysForAnswer(q, answers[i] ?? EMPTY_ANSWER))
  return questions.length > 1 ? [...chunks, ENTER] : chunks
}
