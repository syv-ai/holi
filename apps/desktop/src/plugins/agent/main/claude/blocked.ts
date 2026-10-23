/**
 * The question a background session is blocked on, as Claude Code's
 * supervisor holds it.
 *
 * A session that asks (`AskUserQuestion`) can wait with its question only in
 * the job's `state.json` (`block.questions`), the call not yet in the
 * transcript. The listing says `waiting` and not what for, so the chat reads
 * it here. The file is Claude Code's own, not a stable interface: anything
 * that is not the shape this expects reads as no question.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The open question's input as JSON text (`{ questions: [...] }`, what the
 *  `AskUserQuestion` call carries), or null when the job is not blocked on one. */
export async function readBlockedQuestion(
  configDir: string,
  jobId: string,
): Promise<string | null> {
  // A job id names a folder: nothing else may reach outside `jobs/`.
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) return null
  const raw = await readFile(join(configDir, 'jobs', jobId, 'state.json'), 'utf8').catch(() => null)
  if (raw === null) return null
  let state: unknown
  try {
    state = JSON.parse(raw)
  } catch {
    return null
  }
  const block = (state as { block?: unknown } | null)?.block
  const questions = (block as { questions?: unknown } | null)?.questions
  return Array.isArray(questions) && questions.length > 0 ? JSON.stringify({ questions }) : null
}
