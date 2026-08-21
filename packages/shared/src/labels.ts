/** Virtual labels — the board's GitHub-style chips.
 *
 * `overdue` and `p1`/`p2`/`p3` are **computed here and never stored**. They render
 * beside a task's real `tags` and filter identically, so the board reads like a
 * labelled issue list — but nothing writes them to the file.
 *
 * Why not store them: something would have to write `overdue` onto a task the moment
 * it tipped over at midnight, and every such write is a file rewrite and therefore an
 * autosave commit. A hundred tasks going overdue is a hundred commits on an otherwise
 * idle vault — and on a shared one, a hundred commits to publish. (The reasoning
 * survives D60 intact; only the mechanism it names changed, from a version bump and a
 * mirror bot to a file write and a local commit.) It would also make `tags` half
 * machine-owned, so an agent deleting `overdue` would have it silently re-added.
 *
 * `priority` and `due` stay real fields. This is a *rendering* of them.
 */
import { stampDate, stampEpoch, stampTime } from './dates'
import type { Task } from './types'

export type VirtualLabel = 'overdue' | 'p1' | 'p2' | 'p3'

const PRIORITY_LABEL = { high: 'p1', medium: 'p2', low: 'p3' } as const

/**
 * Whether a task is late, given the moment `now`.
 *
 * Two rules, because `due` is a stamp and the time on it is optional (D79):
 *
 * - **Due names an hour** → late once that minute has passed. A task due at
 *   14:00 is late at 14:01 and not at 14:00.
 * - **Due names only a day** → late once the DAY has passed. An all-day task
 *   due today is not late at 00:01; you have the day. That is the boundary the
 *   old day-granular rule got right, and the reason this is two rules rather
 *   than one epoch comparison with a midnight default.
 *
 * An unparseable `due` is never overdue — inert, like an unparseable reminder,
 * so a legacy `1d` or a typo costs a chip rather than throwing mid-render.
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
 * caller owns the timezone question (the reminder anchor has the same shape).
 * It is a TIMED stamp — `YYYY-MM-DDTHH:MM` — because a due date may name an
 * hour and a date alone could not answer that. */
export function virtualLabels(
  task: Pick<Task, 'due' | 'priority' | 'status'>,
  now: string,
): VirtualLabel[] {
  const labels: VirtualLabel[] = []
  // A done task is never overdue — it is done.
  if (task.status !== 'done' && task.due !== undefined && isOverdue(task.due, now)) {
    labels.push('overdue')
  }
  if (task.priority !== undefined) labels.push(PRIORITY_LABEL[task.priority])
  return labels
}

/** Everything the board shows as a chip: virtual labels first, then the task's own
 * tags. One list, so the card renders (and slice 2 filters) them uniformly. */
export function allLabels(
  task: Pick<Task, 'due' | 'priority' | 'status' | 'tags'>,
  now: string,
): string[] {
  return [...virtualLabels(task, now), ...task.tags]
}
