/**
 * The questions quick agents are waiting on (docs/features/quick-agent.md).
 *
 * A quick agent's `PreToolUse` hook on AskUserQuestion posts the tool call to
 * the bridge and waits for the answer (`claude/quick.ts`). The route hands it
 * here, and it is held, one entry per call, until the person answers it in the
 * quick panel or over the session's tab, or the hook goes away: the session
 * stopped, or its `curl` gave up. The answer becomes the hook's output, which
 * Claude Code takes as the person's answer without drawing its own box.
 *
 * Holding a question is what makes a session need you: Claude Code's listing
 * says `busy` the whole time a hook runs, so the session list reads this desk
 * (`sessions.ts`) rather than waiting for a `waiting` that never comes.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { randomUUID } from 'node:crypto'
import {
  answersComplete,
  parseAskInput,
  type AskAnswers,
  type PendingQuestion,
} from '../../shared/questions'

/** What the hook prints: Claude Code's documented answer to AskUserQuestion. */
export interface AskHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'allow'
    updatedInput: Record<string, unknown>
  }
}

export interface QuestionDeskDeps {
  /** The list changed: a question arrived, was answered, or went away. */
  onChange(pending: readonly PendingQuestion[]): void
  now?: () => number
  mintId?: () => string
}

export interface QuestionDesk {
  /**
   * Hold the hook's tool call until it is answered. Null when Holi is not
   * taking it (not a question it can show) or it went away unanswered; the
   * hook then prints nothing and Claude Code asks the ordinary way.
   */
  ask(job: string, hookInput: unknown, signal: AbortSignal): Promise<AskHookOutput | null>
  /** Answer a held call. False when it is gone or the answers do not answer
   *  every question. */
  answer(id: string, answers: AskAnswers): boolean
  /** Every held call, oldest first. */
  pending(): readonly PendingQuestion[]
  /** Whether this session is waiting on a held call. */
  has(job: string): boolean
  /** Let go of a session's calls unanswered: it stopped, or Holi left its
   *  vault. Its hook falls through to Claude Code's own box. */
  release(job: string): void
  releaseAll(): void
}

interface Held {
  question: PendingQuestion
  /** The tool input as Claude Code sent it, so the answer keeps every field. */
  toolInput: Record<string, unknown>
  settle(output: AskHookOutput | null): void
}

export function createQuestionDesk(deps: QuestionDeskDeps): QuestionDesk {
  const now = deps.now ?? Date.now
  const mintId = deps.mintId ?? randomUUID
  /** Insertion-ordered: the order they were asked. */
  const held = new Map<string, Held>()

  const changed = (): void => deps.onChange(desk.pending())

  const take = (id: string): Held | undefined => {
    const h = held.get(id)
    if (h !== undefined) held.delete(id)
    return h
  }

  const desk: QuestionDesk = {
    ask(job, hookInput, signal) {
      if (signal.aborted) return Promise.resolve(null)
      const input = hookInput as Record<string, unknown> | null
      const toolInput = input?.['tool_input']
      const questions = parseAskInput(toolInput)
      if (questions === null) return Promise.resolve(null)
      const given = input?.['tool_use_id']
      const id = typeof given === 'string' && given !== '' && !held.has(given) ? given : mintId()
      return new Promise((resolve) => {
        const onAbort = (): void => {
          if (take(id) !== undefined) changed()
          resolve(null)
        }
        held.set(id, {
          question: { id, job, questions, askedAt: now() },
          toolInput: toolInput as Record<string, unknown>,
          settle: (output) => {
            signal.removeEventListener('abort', onAbort)
            resolve(output)
          },
        })
        signal.addEventListener('abort', onAbort, { once: true })
        changed()
      })
    },

    answer(id, answers) {
      const h = held.get(id)
      if (h === undefined || !answersComplete(h.question.questions, answers)) return false
      take(id)
      h.settle({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...h.toolInput, answers: { ...answers } },
        },
      })
      changed()
      return true
    },

    pending: () => [...held.values()].map((h) => h.question),

    has: (job) => [...held.values()].some((h) => h.question.job === job),

    release(job) {
      let any = false
      for (const [id, h] of [...held]) {
        if (h.question.job !== job) continue
        held.delete(id)
        h.settle(null)
        any = true
      }
      if (any) changed()
    },

    releaseAll() {
      if (held.size === 0) return
      const all = [...held.values()]
      held.clear()
      for (const h of all) h.settle(null)
      changed()
    },
  }
  return desk
}
