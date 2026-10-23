/**
 * The vault's task statuses: the board's columns (docs/features/tasks.md).
 *
 * A vault lists them in `.holi/statuses.yaml`, committed, so everyone who
 * clones it plans with the same columns. The file is optional: without it, or
 * when it cannot be used, a vault has `DEFAULT_STATUSES`, gr8r's five.
 *
 * ```yaml
 * statuses:
 *   - id: backlog
 *     name: Backlog
 *     category: backlog
 *   - id: todo
 *     name: To do
 *     category: unstarted
 * ```
 *
 * **The `id` is what a task file says** (`status: todo`); the `name` is only
 * what a column is called, so renaming a column rewrites no task. **The
 * `category` is what the app reasons with**: whether a task is open or done,
 * how far the project has come, where a task with an unknown status shows.
 * A vault can rename, reorder and add statuses without teaching the app what
 * any of them mean.
 *
 * The three statuses Holi always had are ids in the default list (`todo`,
 * `doing`, `done`), so an existing task needs nothing rewritten. A status a
 * vault does not list still has a column to show in (`columnFor`), and the
 * task's file keeps saying what it said until someone moves it.
 *
 * **Nothing here throws.** The file is someone else's in a shared vault; a typo
 * in it costs the vault its own columns, with a warning, never its board.
 */
import { parse as parseYaml } from 'yaml'
import type { TaskStatus } from './types'

/** Where the vault's statuses live: committed, beside the other `.holi/` files. */
export const STATUSES_FILE = '.holi/statuses.yaml'

/**
 * What a status means to the app, whatever it is called.
 *
 * - `backlog`: not planned yet. Open.
 * - `unstarted`: planned, not begun. Open. The first one is where a new task,
 *   a reopened one and a task with an unknown status go.
 * - `started`: being worked on. Open.
 * - `review`: done by its doer, waiting on someone. Open.
 * - `completed`: finished. Moving a task into one is completion, so a
 *   recurring task rolls forward instead (`completeTask`).
 */
export type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'review' | 'completed'

export const STATUS_CATEGORIES: readonly StatusCategory[] = [
  'backlog',
  'unstarted',
  'started',
  'review',
  'completed',
]

export interface StatusDef {
  /** What a task file's `status` says. Lower-case, digits and dashes. */
  id: TaskStatus
  /** The column's name. */
  name: string
  category: StatusCategory
}

/** gr8r's five. `todo`, `doing` and `done` are the ids Holi always wrote. */
export const DEFAULT_STATUSES: readonly StatusDef[] = [
  { id: 'backlog', name: 'Backlog', category: 'backlog' },
  { id: 'todo', name: 'To do', category: 'unstarted' },
  { id: 'doing', name: 'In progress', category: 'started' },
  { id: 'review', name: 'Review', category: 'review' },
  { id: 'done', name: 'Done', category: 'completed' },
]

const STATUS_ID = /^[a-z0-9][a-z0-9-]*$/

/** Whether `value` can be a status id in the file. */
export const isStatusId = (value: string): boolean => STATUS_ID.test(value)

export interface ResolvedStatuses {
  statuses: StatusDef[]
  /** Why the file was not used, or what in it was dropped. */
  warnings: string[]
}

/**
 * The statuses `text` (the file's contents, or null when there is none) gives
 * the vault. A bad entry is dropped with a warning; a list left without an
 * `unstarted` and a `completed` status cannot place new or finished tasks, so
 * the vault then has the defaults.
 */
export function parseStatusesFile(text: string | null): ResolvedStatuses {
  const defaults = (warnings: string[]): ResolvedStatuses => ({
    statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
    warnings,
  })
  if (text === null || text.trim() === '') return defaults([])

  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return defaults([`${STATUSES_FILE} is not valid YAML: ${(err as Error).message}`])
  }
  const list = (raw as { statuses?: unknown } | null)?.statuses
  if (!Array.isArray(list)) return defaults([`${STATUSES_FILE} has no \`statuses\` list`])

  const warnings: string[] = []
  const statuses: StatusDef[] = []
  list.forEach((entry: unknown, index) => {
    const at = `${STATUSES_FILE} statuses[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`${at} is not a map`)
      return
    }
    const { id, name, category } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !isStatusId(id)) {
      warnings.push(`${at}: id must be lower-case letters, digits and dashes`)
      return
    }
    if (statuses.some((s) => s.id === id)) {
      warnings.push(`${at}: ${id} is listed twice`)
      return
    }
    if (typeof category !== 'string' || !STATUS_CATEGORIES.includes(category as StatusCategory)) {
      warnings.push(`${at}: category must be one of ${STATUS_CATEGORIES.join(' | ')}`)
      return
    }
    const label = typeof name === 'string' && name.trim() !== '' ? name.trim() : id
    statuses.push({ id, name: label, category: category as StatusCategory })
  })

  for (const needed of ['unstarted', 'completed'] as const) {
    if (!statuses.some((s) => s.category === needed)) {
      return defaults([...warnings, `${STATUSES_FILE} has no ${needed} status`])
    }
  }
  return { statuses, warnings }
}

/** The first status of `category`, if the vault has one. */
export function firstOfCategory(
  statuses: readonly StatusDef[],
  category: StatusCategory,
): StatusDef | undefined {
  return statuses.find((s) => s.category === category)
}

/** Where new and reopened tasks go: the first `unstarted` status. */
export function openingStatus(statuses: readonly StatusDef[]): StatusDef {
  return firstOfCategory(statuses, 'unstarted') ?? DEFAULT_STATUSES[1]!
}

/** The status completion writes: the first `completed` status. */
export function completedStatus(statuses: readonly StatusDef[]): StatusDef {
  return firstOfCategory(statuses, 'completed') ?? DEFAULT_STATUSES[4]!
}

/** Holi's three old words, by what they meant, for a vault that renamed them. */
const LEGACY_CATEGORY: Record<string, StatusCategory> = {
  todo: 'unstarted',
  doing: 'started',
  done: 'completed',
}

/**
 * The status a task shows under: its own when the vault lists it; for one of
 * the three old words a vault no longer lists, the first status of what that
 * word meant; for anything else the first `unstarted` one. Display only: the
 * file keeps its word until the task is moved.
 */
export function columnFor(statuses: readonly StatusDef[], status: TaskStatus): StatusDef {
  const own = statuses.find((s) => s.id === status)
  if (own !== undefined) return own
  const legacy = LEGACY_CATEGORY[status]
  return (legacy && firstOfCategory(statuses, legacy)) || openingStatus(statuses)
}

/** What a task's status means, by the column it shows under. */
export function categoryOf(statuses: readonly StatusDef[], status: TaskStatus): StatusCategory {
  return columnFor(statuses, status).category
}

/** Whether a task with `status` is finished. Everything else is open. */
export function isClosedStatus(statuses: readonly StatusDef[], status: TaskStatus): boolean {
  return categoryOf(statuses, status) === 'completed'
}
