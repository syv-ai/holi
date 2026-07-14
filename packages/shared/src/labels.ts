/** Virtual labels — the board's GitHub-style chips (D41).
 *
 * `overdue` and `p1`/`p2`/`p3` are **computed here and never stored**. They render
 * beside a task's real `tags` and filter identically, so the board reads like a
 * labelled issue list — but nothing writes them to the record.
 *
 * Why not store them: something would have to write `overdue` onto a task the moment
 * it tipped over at midnight. Every such write bumps `version`, which rewrites the
 * task file, which — with the git mirror on — makes the bot *commit*. A hundred tasks
 * going overdue is a hundred commits on an otherwise idle vault: the exact failure D33
 * exists to prevent. It would also make `tags` half machine-owned, so an agent deleting
 * `overdue` would have it silently re-added under it.
 *
 * `priority` and `due` stay real fields. This is a *rendering* of them.
 */
import type { Task } from './types'

export type VirtualLabel = 'overdue' | 'p1' | 'p2' | 'p3'

const PRIORITY_LABEL = { high: 'p1', medium: 'p2', low: 'p3' } as const

/** `today` is passed in, never read from the clock: the rules stay pure, and the
 * caller owns the timezone question (the reminder anchor has the same shape). */
export function virtualLabels(
  task: Pick<Task, 'due' | 'priority' | 'status'>,
  today: string,
): VirtualLabel[] {
  const labels: VirtualLabel[] = []
  // A done task is never overdue — it is done. And `due === today` is due, not late:
  // you have the day. Both boundaries are the ones people notice when they are wrong.
  if (task.status !== 'done' && task.due !== undefined && task.due < today) labels.push('overdue')
  if (task.priority !== undefined) labels.push(PRIORITY_LABEL[task.priority])
  return labels
}

/** Everything the board shows as a chip: virtual labels first, then the task's own
 * tags. One list, so the card renders (and slice 2 filters) them uniformly. */
export function allLabels(
  task: Pick<Task, 'due' | 'priority' | 'status' | 'tags'>,
  today: string,
): string[] {
  return [...virtualLabels(task, today), ...task.tags]
}
