/**
 * A task, as its file says it (docs/features/tasks.md). The **path is the
 * identity**: there are no generated ids.
 */

export type TaskStatus = 'todo' | 'doing' | 'done'
export type Priority = 'low' | 'medium' | 'high'

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type RecurrenceWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface Recurrence {
  frequency: RecurrenceFrequency
  interval: number
  weekdays?: RecurrenceWeekday[]
  /** YYYY-MM-DD. Occurrences after this date stop the roll-forward. */
  endDate?: string
}

/**
 * A task: a `task.<name>.md` file, parsed.
 *
 * The **path is the identity**, and its **containing folder is its swim lane**,
 * so there is no `area` field. There is no `id` (nothing to join on), no
 * `version` (git arbitrates between machines), and no `related[]` (a task links
 * to things by writing wiki-links in its body).
 */
export interface Task {
  /** Vault-relative, '/'-separated, e.g. `projects/q2/task.fix-login.md`. */
  path: string
  /** The body's first heading at any level, falling back to the filename.
   *  Never empty, and never stored: `serializeTaskFile` writes no `title`. */
  title: string
  status: TaskStatus
  /** A stamp: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when the task is due at a
   *  time. The absence of a time is meaningful: due that day, not at midnight
   *  on it. */
  due?: string
  priority?: Priority
  tags: string[]
  /**
   * Who the task is for: GitHub logins of the vault's members, without the
   * `@`, each once whatever its case. Empty when it is no one's in
   * particular, which is every member's: its reminder then reaches everyone
   * running Holi. A login is a name, not an identity (an account can be
   * renamed), the same trade GitHub's own `@mentions` make.
   */
  assignees: string[]
  /** When to be notified, as a stamp: an absolute moment, never an offset
   *  from `due`. A stamp with no time fires at `ANCHOR_HOUR`. Anything
   *  that is not a stamp is inert: it is carried through the file untouched and
   *  never fires. */
  reminder?: string
  recurrence?: Recurrence
  /**
   * The card's rank within its board cell: a sparse number, not a position
   * (docs/features/tasks.md). Absent sorts last, which is where a task the
   * agent just wrote belongs.
   *
   * In the file rather than a side file because the file is the whole task.
   */
  order?: number
  /** The markdown body. */
  description: string
  /**
   * Frontmatter keys this version of Holi does not understand, carried through
   * untouched.
   *
   * Editing a task rewrites the whole file, so without this a drag would silently
   * eat any key a human or another tool put there on purpose. Absent rather than
   * `{}` when everything was understood: an empty map must serialize identically
   * to never having had one.
   */
  extra?: Record<string, unknown>
}

/** The lane a task sits in: its containing folder, '' for the vault root. */
export function taskArea(task: Pick<Task, 'path'>): string {
  const cut = task.path.lastIndexOf('/')
  return cut === -1 ? '' : task.path.slice(0, cut)
}
