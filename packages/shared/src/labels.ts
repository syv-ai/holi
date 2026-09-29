/** Virtual labels: the board's GitHub-style chips.
 *
 * `overdue` and `p1`/`p2`/`p3` are **computed here and never stored**. They render
 * beside a task's real `tags` and filter identically, but nothing writes them.
 *
 * Why not store them: every write of `overdue` at midnight is a file rewrite and an
 * autosave commit, so a hundred tasks going overdue would be a hundred commits on an
 * idle vault. It would also make `tags` half machine-owned, so an agent deleting
 * `overdue` would have it silently re-added.
 */
import { stampDate, stampEpoch, stampTime } from './dates'
import type { Task } from './types'

export type VirtualLabel = 'overdue' | 'p1' | 'p2' | 'p3'

const PRIORITY_LABEL = { high: 'p1', medium: 'p2', low: 'p3' } as const

/**
 * Whether a task is late, given the moment `now`.
 *
 * Two rules, because `due` is a stamp and the time on it is optional:
 *
 * - **Due names an hour** → late once that minute has passed. A task due at
 *   14:00 is late at 14:01 and not at 14:00.
 * - **Due names only a day** → late once the DAY has passed. An all-day task
 *   due today is not late at 00:01, which is why this is two rules rather than
 *   one epoch comparison with a midnight default.
 *
 * An unparseable `due` is never overdue, so a typo costs a chip rather than
 * throwing mid-render.
 */
function isOverdue(due: string, now: string): boolean {
  const at = stampEpoch(due, 0)
  if (at === null) return false
  if (stampTime(due) !== null) {
    const nowEpoch = stampEpoch(now, 0)
    return nowEpoch !== null && at < nowEpoch
  }
  const today = stampDate(now)
  return today !== null && due < today
}

/** `now` is passed in, never read from the clock: the rules stay pure, and the
 * caller owns the timezone question. It is a TIMED stamp (`YYYY-MM-DDTHH:MM`)
 * because a due date may name an hour. */
export function virtualLabels(
  task: Pick<Task, 'due' | 'priority' | 'status'>,
  now: string,
): VirtualLabel[] {
  const labels: VirtualLabel[] = []
  if (task.status !== 'done' && task.due !== undefined && isOverdue(task.due, now)) {
    labels.push('overdue')
  }
  if (task.priority !== undefined) labels.push(PRIORITY_LABEL[task.priority])
  return labels
}

/** Everything the board shows as a chip: virtual labels first, then the task's own
 * tags. One list, so the card renders and filters them uniformly. */
export function allLabels(
  task: Pick<Task, 'due' | 'priority' | 'status' | 'tags'>,
  now: string,
): string[] {
  return [...virtualLabels(task, now), ...task.tags]
}
