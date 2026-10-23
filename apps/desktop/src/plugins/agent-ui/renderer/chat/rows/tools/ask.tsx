/**
 * AskUserQuestion once it has an outcome: the questions, the options, and the
 * ones chosen highlighted by background. The answers are keyed by the
 * question's text, so a hostile key such as `constructor` is looked up as an
 * own property only. When the question was dismissed (the call failed or was
 * refused) nothing is highlighted.
 */
import { Check, MessageCircleQuestion } from 'lucide-react'
import { Icon } from '@/primitives'
import { cn } from '@/plugin-api'
import type { ToolItem } from '../../../../../agent/renderer/public'
import type { ToolRenderer } from '../registry'
import { argsOf, arr, dataOf, firstStr, flag, get, isRec, recs, str, textOf } from './coerce'
import { Caption, Chip, Stack } from './parts'
import { stateOf, type CardView } from './view'

interface Option {
  label: string
  description: string | undefined
}

interface Question {
  question: string
  header: string | undefined
  multi: boolean
  options: Option[]
}

function questionsOf(item: ToolItem): Question[] {
  const raw = argsOf(item).questions ?? dataOf(item).questions
  return recs(raw)
    .map((q) => ({
      question: firstStr(q, ['question']) ?? '',
      header: firstStr(q, ['header']),
      multi: flag(q.multiSelect),
      options: arr(q.options)
        .map((o) =>
          typeof o === 'string'
            ? { label: o, description: undefined }
            : { label: firstStr(o, ['label']) ?? '', description: firstStr(o, ['description']) },
        )
        .filter((o) => o.label !== ''),
    }))
    .filter((q) => q.question !== '')
}

/** The answers by question: the structured result, else parsed from the text
 *  ("User has answered your questions: "Q"="A", ..."). */
function answersOf(item: ToolItem): Map<string, string> {
  const answers = new Map<string, string>()
  const structured = get(dataOf(item), 'answers')
  if (isRec(structured)) {
    for (const key of Object.keys(structured)) {
      const value = str(get(structured, key))
      if (value !== undefined) answers.set(key, value)
    }
  }
  if (answers.size > 0) return answers
  const pair = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g
  for (const m of textOf(item).matchAll(pair)) {
    if (m[1] !== undefined && m[2] !== undefined) answers.set(m[1], m[2])
  }
  return answers
}

function isChosen(question: Question, option: Option, answer: string | undefined): boolean {
  if (answer === undefined) return false
  if (answer === option.label) return true
  return question.multi && answer.split(',').some((part) => part.trim() === option.label)
}

export const askRenderer: ToolRenderer = (item) => {
  const questions = questionsOf(item)
  if (questions.length === 0) return null
  const state = stateOf(item)
  const answers = answersOf(item)
  const dismissed = state === 'error' || state === 'rejected'
  const answered = !dismissed && state === 'done' && answers.size > 0

  const first = questions[0]
  const firstAnswer = first === undefined ? undefined : answers.get(first.question)
  const summary =
    questions.length === 1 && first !== undefined
      ? answered && firstAnswer !== undefined
        ? `${first.question} → ${firstAnswer}`
        : first.question
      : `${questions.length} questions`

  const chips = dismissed
    ? ['dismissed']
    : state === 'pending'
      ? ['waiting for you']
      : answered
        ? ['answered']
        : []

  const view: CardView = {
    label: state === 'pending' ? 'Asking' : 'Asked',
    icon: MessageCircleQuestion,
    summary,
    chips,
    body: (
      <Stack>
        {questions.slice(0, 4).map((q, qi) => {
          const answer = answered ? answers.get(q.question) : undefined
          const matched = q.options.some((o) => isChosen(q, o, answer))
          return (
            <div key={qi} className="flex flex-col gap-1" data-chat-question="">
              <div className="flex items-center gap-2">
                {q.header !== undefined && <Chip>{q.header}</Chip>}
                <span className={cn('text-sm', dismissed && 'text-muted-foreground')}>
                  {q.question}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5 text-xs">
                {q.options.slice(0, 4).map((o, oi) => {
                  const chosen = isChosen(q, o, answer)
                  return (
                    <li
                      key={oi}
                      data-chosen={chosen ? '' : undefined}
                      className={cn(
                        'flex items-baseline gap-2 rounded-md px-2 py-1',
                        chosen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {chosen && <Icon icon={Check} size="sm" />}
                      <span className="shrink-0">{o.label}</span>
                      {o.description !== undefined && (
                        <span className="min-w-0 truncate text-muted-foreground">
                          {o.description}
                        </span>
                      )}
                    </li>
                  )
                })}
                {answer !== undefined && !matched && (
                  <li
                    data-chosen=""
                    className="flex items-center gap-2 rounded-md bg-accent px-2 py-1 text-accent-foreground"
                  >
                    <Icon icon={Check} size="sm" />
                    <span>{answer}</span>
                  </li>
                )}
              </ul>
            </div>
          )
        })}
        {questions.length > 4 && <Caption>{`${questions.length - 4} more questions`}</Caption>}
      </Stack>
    ),
  }
  return view
}
