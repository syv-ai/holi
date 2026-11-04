/**
 * The vault's task statuses, read off disk for the writes that need them
 * (`statuses.ts` in shared, docs/features/tasks.md). Completion is the one:
 * moving a task into any `completed` status completes it, and a recurring
 * task's next occurrence opens in the first `unstarted` one.
 *
 * Read on every such write rather than cached: it is one small file, and a
 * cache would be one more thing to invalidate when a teammate's edit arrives.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  completedStatus,
  isClosedStatus,
  openingStatus,
  parseStatusesFile,
  STATUSES_FILE,
  type CompletionStatuses,
  type StatusDef,
  type TaskStatus,
} from '@holi/shared'

export async function readVaultStatuses(root: string): Promise<StatusDef[]> {
  const text = await readFile(join(root, STATUSES_FILE), 'utf8').catch(() => null)
  return parseStatusesFile(text).statuses
}

/**
 * What completing a task in this vault writes, given the status it is being
 * set to (`status`), or none when it is completed by name (`holi tasks
 * complete`): a move into one of several completed statuses lands in that one.
 */
export function completionStatuses(
  statuses: readonly StatusDef[],
  status?: TaskStatus,
): CompletionStatuses {
  return {
    done:
      status !== undefined && isClosedStatus(statuses, status)
        ? status
        : completedStatus(statuses).id,
    reopen: openingStatus(statuses).id,
  }
}
