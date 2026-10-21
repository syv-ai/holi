/**
 * What marking a task done writes (docs/features/tasks.md).
 *
 * **Done on a recurring task is its next occurrence, not the end of it.** `due`
 * advances to on-or-after today (`nextDueCatchup`), keeping its time; the
 * reminder moves by the same whole-day delta, keeping its own time; status
 * returns to `todo`. A task with no rule, or no `due` to advance from, is
 * simply `done`.
 *
 * The fields to write rather than a whole task, so a writer that holds the
 * frontmatter as YAML (the editor's widget) applies the same rule as one that
 * holds a `Task` (main's `tasks.update`).
 */
import { nextDueCatchup } from './recurrence'
import { shiftForRollover } from './reminder'
import type { Task, TaskStatus } from './types'

export interface Completion {
  status: TaskStatus
  due?: string
  reminder?: string
}

export function completeTask(
  task: Pick<Task, 'due' | 'recurrence' | 'reminder'>,
  today: string,
): Completion {
  const rolled =
    task.recurrence !== undefined && task.due !== undefined
      ? nextDueCatchup(task.due, task.recurrence, today)
      : null
  if (rolled === null) return { status: 'done' }
  if (task.reminder === undefined) return { status: 'todo', due: rolled }
  // A reminder is a wall-clock stamp tied to the old occurrence, so it moves
  // with the due date. An inert (non-stamp) reminder is carried as it is.
  const reminder = shiftForRollover(task.reminder, task.due!, rolled) ?? task.reminder
  return { status: 'todo', due: rolled, reminder }
}
