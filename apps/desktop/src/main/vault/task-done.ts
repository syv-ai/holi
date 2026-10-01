/**
 * What `holi tasks complete` does: complete a task file the way the app does.
 *
 * The agent can only write files, and writing `status: done` into a recurring
 * task ends the series instead of rolling it forward. This applies the same
 * rule as the board's checkbox (`completeTask`), so "mark the rent task done"
 * has a correct answer.
 *
 * Every refusal names the problem, since the agent is the caller.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import {
  completeTask,
  isTaskFilePath,
  parseTaskFile,
  serializeTaskFile,
  vaultRelPath,
  type Task,
  type VaultRelPath,
} from '@holi/shared'
import { resolveRelative } from '@holi/shared/path-safety-node'
import { absPathFor, writeAtomic } from './vault-files'

export type TaskDoneResult =
  | { ok: true; path: string; status: 'done' }
  | { ok: true; path: string; status: 'todo'; due: string; reminder?: string }
  | { ok: false; error: string }

export async function taskDoneOp(
  root: string,
  path: string,
  today: string,
): Promise<TaskDoneResult> {
  let rel: VaultRelPath
  try {
    rel = vaultRelPath(isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, ''))
    // Canonicalised, so a symlink inside the vault cannot lead the write out of it.
    await resolveRelative(root, rel)
  } catch {
    return { ok: false, error: `${path} is not a path inside this vault` }
  }
  if (!isTaskFilePath(rel)) {
    return { ok: false, error: `${rel} is not a task file; a task is named task.<slug>.md` }
  }

  const text = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
  if (text === null) return { ok: false, error: `no task at ${rel}` }

  let task: Task
  try {
    task = parseTaskFile(text, rel)
  } catch (error) {
    return { ok: false, error: `${rel}: ${(error as Error).message}` }
  }

  const completion = completeTask(task, today)
  await writeAtomic(root, rel, serializeTaskFile({ ...task, ...completion }))

  if (completion.status === 'done') return { ok: true, path: rel, status: 'done' }
  return {
    ok: true,
    path: rel,
    status: 'todo',
    due: completion.due!,
    ...(completion.reminder !== undefined ? { reminder: completion.reminder } : {}),
  }
}
