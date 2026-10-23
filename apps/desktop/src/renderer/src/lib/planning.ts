/**
 * The planning view's pure rules (docs/features/planning.md): narrowing,
 * ordering and grouping tasks by the vault's statuses, and the numbers the
 * Overview shows. No state and no clock: the caller passes `now`.
 */
import {
  columnFor,
  isOverdue,
  parseDate,
  stampDate,
  DAY_MS,
  type Priority,
  type StatusCategory,
  type StatusDef,
  type Task,
} from '@holi/shared'
import { sortCell } from './board-order'

export interface PlanningFilter {
  search: string
  /** GitHub logins: a task assigned to any of them. */
  people: string[]
  /** A task carrying every one. */
  tags: string[]
  /** A task with any of them; `none` is a task with no priority. */
  priorities: (Priority | 'none')[]
}

export const EMPTY_PLANNING_FILTER: PlanningFilter = {
  search: '',
  people: [],
  tags: [],
  priorities: [],
}

export type PlanningSort = 'manual' | 'due' | 'priority' | 'start' | 'title'

export const PLANNING_SORTS: readonly { id: PlanningSort; name: string }[] = [
  { id: 'manual', name: 'Manual' },
  { id: 'due', name: 'Due date' },
  { id: 'priority', name: 'Priority' },
  { id: 'start', name: 'Start date' },
  { id: 'title', name: 'Title' },
]

/** Highest first, the way the menus list them. */
export const PRIORITIES: readonly { id: Priority; name: string }[] = [
  { id: 'urgent', name: 'Urgent' },
  { id: 'high', name: 'High' },
  { id: 'medium', name: 'Medium' },
  { id: 'low', name: 'Low' },
]

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

export function priorityName(priority: Priority): string {
  return PRIORITIES.find((p) => p.id === priority)?.name ?? priority
}

export function isFiltered(filter: PlanningFilter): boolean {
  return (
    filter.search.trim() !== '' ||
    filter.people.length > 0 ||
    filter.tags.length > 0 ||
    filter.priorities.length > 0
  )
}

export function matchesPlanningFilter(task: Task, filter: PlanningFilter): boolean {
  const needle = filter.search.trim().toLowerCase()
  if (needle !== '') {
    const hay = `${task.title}\n${task.description}\n${task.tags.join(' ')}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }
  if (
    filter.people.length > 0 &&
    !filter.people.some((p) => task.assignees.some((a) => a.toLowerCase() === p.toLowerCase()))
  ) {
    return false
  }
  if (filter.tags.length > 0 && !filter.tags.every((t) => task.tags.includes(t))) return false
  if (
    filter.priorities.length > 0 &&
    !filter.priorities.includes(task.priority === undefined ? 'none' : task.priority)
  ) {
    return false
  }
  return true
}

/** Absent sorts last, whatever the key; ties by title so a rescan never
 *  reshuffles. */
function byKey<K>(
  key: (task: Task) => K | undefined,
  compare: (a: K, b: K) => number,
): (a: Task, b: Task) => number {
  return (a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka === undefined && kb !== undefined) return 1
    if (kb === undefined && ka !== undefined) return -1
    if (ka !== undefined && kb !== undefined) {
      const c = compare(ka, kb)
      if (c !== 0) return c
    }
    return a.title.localeCompare(b.title)
  }
}

const text = (a: string, b: string) => a.localeCompare(b)

export function sortTasks(tasks: Task[], sort: PlanningSort): Task[] {
  switch (sort) {
    case 'manual':
      return sortCell(tasks)
    case 'due':
      return [...tasks].sort(byKey((t) => t.due, text))
    case 'start':
      return [...tasks].sort(byKey((t) => t.start, text))
    case 'priority':
      return [...tasks].sort(
        byKey(
          (t) => (t.priority === undefined ? undefined : PRIORITY_RANK[t.priority]),
          (a, b) => a - b,
        ),
      )
    case 'title':
      return [...tasks].sort((a, b) => a.title.localeCompare(b.title))
  }
}

/** Every task under the status it shows in (`columnFor`), each status
 *  present, in the vault's order. */
export function groupByStatus(
  tasks: Iterable<Task>,
  statuses: readonly StatusDef[],
  sort: PlanningSort,
): Record<string, Task[]> {
  const groups: Record<string, Task[]> = Object.fromEntries(statuses.map((s) => [s.id, []]))
  for (const task of tasks) groups[columnFor(statuses, task.status).id]!.push(task)
  for (const id of Object.keys(groups)) groups[id] = sortTasks(groups[id]!, sort)
  return groups
}

export interface ProgressSummary {
  total: number
  done: number
  /** Whole percent of tasks in a completed status. */
  percent: number
  overdue: number
  byStatus: { status: StatusDef; count: number }[]
}

export function progressSummary(
  tasks: readonly Task[],
  statuses: readonly StatusDef[],
  now: string,
): ProgressSummary {
  const byStatus = statuses.map((status) => ({ status, count: 0 }))
  let done = 0
  let overdue = 0
  for (const task of tasks) {
    const column = columnFor(statuses, task.status)
    byStatus.find((b) => b.status.id === column.id)!.count += 1
    if (column.category === 'completed') done += 1
    else if (task.due !== undefined && isOverdue(task.due, now)) overdue += 1
  }
  const total = tasks.length
  return {
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    overdue,
    byStatus,
  }
}

/** The next `limit` open tasks that have a due date, soonest first. */
export function comingUp(
  tasks: readonly Task[],
  statuses: readonly StatusDef[],
  limit = 6,
): Task[] {
  return sortTasks(
    tasks.filter(
      (t) => t.due !== undefined && columnFor(statuses, t.status).category !== 'completed',
    ),
    'due',
  ).slice(0, limit)
}

/** Whole days from `today` to the day of `stamp`: negative once past, null
 *  for a stamp that is not a date. */
export function daysUntil(today: string, stamp: string): number | null {
  const from = parseDate(today)
  const day = stampDate(stamp)
  const to = day === null ? null : parseDate(day)
  if (from === null || to === null) return null
  return Math.round((to - from) / DAY_MS)
}

/** `2026-10-23` → `Oct 23`, with the year only when it is not this one. */
export function shortDate(stamp: string, today: string): string {
  const day = stampDate(stamp)
  if (day === null) return stamp
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  })
}

/** A GitHub login's avatar, served by GitHub. Falls back to initials when
 *  offline or for a name that is not a login. */
export function avatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`
}

export function initials(name: string): string {
  const parts = name
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/** A status category's identity colour: its dot and its column's tint. Raw
 *  palette only where a token has no meaning to borrow. */
export const CATEGORY_DOT: Record<StatusCategory, string> = {
  backlog: 'bg-muted-foreground/70',
  unstarted: 'bg-yellow-500 dark:bg-yellow-400',
  started: 'bg-sky-500 dark:bg-sky-400',
  review: 'bg-info',
  completed: 'bg-success',
}
