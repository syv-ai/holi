/**
 * A question a quick agent asked through Claude Code's AskUserQuestion tool,
 * as Holi holds it while the person answers (docs/features/quick-agent.md).
 *
 * Shared by the main side, which reads the tool call out of the hook's JSON and
 * builds the hook's answer, and the renderer, which draws the card and checks
 * the answer before sending it. Pure: no Node, no DOM.
 */

/** One option of a question, as Claude Code's tool input carries it. */
export interface AskOption {
  label: string
  description?: string
}

/** One question of a call: Claude Code allows one to four per call, each with
 *  two to four options, and the person may always write their own answer. */
export interface AskQuestion {
  question: string
  /** A short chip label, at most 12 characters by the tool's own rule. */
  header?: string
  multiSelect: boolean
  options: AskOption[]
}

/** A call waiting on the person: the questions, and the session that asked. */
export interface PendingQuestion {
  /** Claude Code's tool-use id, else one Holi minted. Answers name it. */
  id: string
  /** The session's job id. */
  job: string
  questions: AskQuestion[]
  /** When Holi took it, in ms since the epoch: oldest is answered first. */
  askedAt: number
}

/** The answers to a call, by question text, as the tool takes them: an
 *  option's label, several joined by ", " for a multi-select, or the person's
 *  own words. */
export type AskAnswers = Record<string, string>

const MAX_QUESTIONS = 4
const MAX_OPTIONS = 4
/** The longest answer Holi passes on: a typed answer is a sentence or a
 *  paragraph, not a document. */
export const MAX_ANSWER_LENGTH = 4_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/**
 * The questions out of an AskUserQuestion tool input, or null when it is not
 * one Holi can show: then Claude Code asks the ordinary way. Builds fresh
 * values and never returns what it parsed.
 */
export function parseAskInput(input: unknown): AskQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input['questions'])) return null
  const raw = input['questions']
  if (raw.length === 0 || raw.length > MAX_QUESTIONS) return null
  const questions: AskQuestion[] = []
  const seen = new Set<string>()
  for (const q of raw) {
    if (!isRecord(q)) return null
    const question = text(q['question'])
    if (question === null || seen.has(question)) return null
    seen.add(question)
    if (!Array.isArray(q['options'])) return null
    const options: AskOption[] = []
    for (const o of q['options']) {
      if (!isRecord(o)) return null
      const label = text(o['label'])
      if (label === null) return null
      const description = text(o['description'])
      options.push(description === null ? { label } : { label, description })
    }
    if (options.length < 1 || options.length > MAX_OPTIONS) return null
    const header = text(q['header'])
    questions.push({
      question,
      ...(header === null ? {} : { header }),
      multiSelect: q['multiSelect'] === true,
      options,
    })
  }
  return questions
}

/**
 * Whether `answers` answers every question of `questions` and nothing else,
 * each with some words of a sensible length. The renderer checks before it
 * sends and main checks again before the answer reaches Claude.
 */
export function answersComplete(questions: readonly AskQuestion[], answers: unknown): boolean {
  if (!isRecord(answers)) return false
  const keys = Object.keys(answers)
  if (keys.length !== questions.length) return false
  return questions.every((q) => {
    const value = answers[q.question]
    return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ANSWER_LENGTH
  })
}

/** A multi-select's answer: the picked labels in the order offered. */
export function joinPicked(options: readonly AskOption[], picked: ReadonlySet<number>): string {
  return options
    .filter((_o, i) => picked.has(i))
    .map((o) => o.label)
    .join(', ')
}
