/**
 * The task file format — `task.<name>.md`, YAML frontmatter + a markdown body
 * that *is* the task's description (prd/tasks.md).
 *
 * **The title is the body's first heading**, at any level, and there is no
 * `title:` key. A name written in frontmatter is a second place for the same
 * fact, and two places drift: the file said one thing and the card another the
 * moment anyone edited the document. `firstHeading` is the whole rule, the
 * filename is the fallback for a body that has none, and a `title:` left over
 * in an older file is carried through as an unknown key — visible in the
 * frontmatter editor, where deleting it is one click.
 *
 * The file is the task. There is no record behind it, so this module is not a
 * projection edge any more: it is simply how a `Task` is spelled on disk, and
 * both directions are total.
 *
 *   - parse:     file -> Task   (runs on every task in the vault, on every scan)
 *   - serialize: Task -> file   (a full rewrite; there is nothing to patch)
 *
 * Two rules make it forgiving where it used to be strict, and both are
 * deliberate:
 *
 *   - **Frontmatter is optional, and so is every key in it.** The identity is
 *     the filename, so a file the agent created with one `Write` and no
 *     ceremony is a valid task. Requiring frontmatter would make the cheapest
 *     path the broken one.
 *   - **Unknown keys are ignored, never rejected.** Files written before D60
 *     carry `id`/`version`/`area`/`related`. Rejecting them would turn a
 *     migrated vault into a wall of unparseable tasks.
 *
 * It still throws `TaskFileError` for a value that is *present and wrong* — a
 * status outside the vocabulary, a due date that is not a date. That distinction
 * is the whole design: absent means "not set", malformed means "you meant
 * something and it did not land", and only the second is worth interrupting for.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parseStamp } from './dates'
import { firstHeading } from './headings'
import type {
  Priority,
  Recurrence,
  RecurrenceFrequency,
  RecurrenceWeekday,
  Task,
  TaskStatus,
} from './types'

export class TaskFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskFileError'
  }
}

/** The filename marker. One glob (`**\/task.*.md`) finds every task in a vault,
 * and no note can become one by accident — which is exactly why the marker is
 * in the name rather than in frontmatter a copy-paste could carry. */
export const TASK_PREFIX = 'task.'

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']
const FREQUENCIES: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly']
const WEEKDAYS: RecurrenceWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The keys this version understands. Everything else in the frontmatter lands in
 * `Task.extra` and is written back verbatim — see the field's own comment. */
const KNOWN_KEYS = new Set(['status', 'due', 'priority', 'tags', 'reminder', 'recurrence', 'order'])

const SLUG_MAX = 60
const SLUG_FALLBACK = 'task'

/** `Review the Q2 doc` -> `review-the-q2-doc`. Never empty, never edge-dashed.
 *
 * This result becomes a **filename**, so collapsing every non-alphanumeric run
 * is load-bearing rather than cosmetic: a surviving `/` would silently relocate
 * the task into another folder (changing its lane), and `..` would leave the
 * vault entirely. */
export function taskSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  return slug === '' ? SLUG_FALLBACK : slug
}

export function taskFileName(title: string): string {
  return `${TASK_PREFIX}${taskSlug(title)}.md`
}

/** The canonical path for a new task in `folder` ('' = the vault root). */
export function taskFilePath(folder: string, title: string): string {
  const name = taskFileName(title)
  return folder === '' ? name : `${folder}/${name}`
}

/** Is this file a task? The name decides, and nothing else does. */
export function isTaskFilePath(rel: string): boolean {
  const base = rel.split('/').at(-1) ?? ''
  return base.startsWith(TASK_PREFIX) && base.endsWith('.md')
}

/**
 * `projects/q2/task.fix-login.md` -> `Fix login`.
 *
 * The fallback title, for a body that carries no heading. Only
 * the first character is capitalised: the slug has already lost the original
 * casing, and title-casing every word would turn `task.fix-the-ci.md` into
 * "Fix The Ci", which reads worse than the sentence case it replaced.
 */
export function titleFromTaskPath(rel: string): string {
  const base = rel.split('/').at(-1) ?? ''
  const stem = base.slice(TASK_PREFIX.length).replace(/\.md$/, '')
  const words = stem.replace(/-+/g, ' ').trim()
  return words === '' ? SLUG_FALLBACK : words.charAt(0).toUpperCase() + words.slice(1)
}

export function serializeTaskFile(
  // `title` is accepted and ignored: it is the body's first heading, so there is
  // nothing to write. Optional rather than required so a caller building a file
  // from scratch is not made to invent a field the format does not have.
  task: Omit<Task, 'path' | 'title'> & { path?: string; title?: string },
): string {
  // Key order is fixed so an unchanged task always serializes byte-identically.
  // The editor's watcher tells its own save from a foreign write by comparing
  // text, so an unstable serializer would make every rewrite look foreign.
  const front: Record<string, unknown> = { status: task.status }

  if (task.due !== undefined) front.due = task.due
  if (task.priority !== undefined) front.priority = task.priority
  if (task.tags.length) front.tags = task.tags
  if (task.reminder !== undefined) front.reminder = task.reminder
  if (task.recurrence !== undefined) front.recurrence = compactRecurrence(task.recurrence)
  if (task.order !== undefined) front.order = task.order
  // Last, always: the known keys keep their fixed order so an unknown one cannot
  // reorder the file out from under the byte-stability rule above.
  for (const [key, value] of Object.entries(task.extra ?? {})) front[key] = value

  const body = task.description.trim()
  const yaml = stringifyYaml(front)
  return body === '' ? `---\n${yaml}---\n` : `---\n${yaml}---\n\n${body}\n`
}

/**
 * Parse a task file. `path` supplies the identity and the fallback title, so it
 * is required — a task read without knowing where it lives has no name.
 */
export function parseTaskFile(text: string, path: string): Task {
  const { yaml, body } = splitFrontmatter(text)

  let front: Record<string, unknown> = {}
  if (yaml !== null) {
    let raw: unknown
    try {
      raw = parseYaml(yaml)
    } catch (err) {
      throw new TaskFileError(`frontmatter is not valid YAML: ${(err as Error).message}`)
    }
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TaskFileError('frontmatter must be a YAML map')
      }
      front = raw as Record<string, unknown>
    }
  }

  const task: Task = {
    path,
    title: firstHeading(body) ?? titleFromTaskPath(path),
    status: front.status === undefined ? 'todo' : enumOf(front.status, STATUSES, 'status'),
    tags: [],
    description: body,
  }

  // The same readers a patch goes through (PATCH_READERS), so a file and an edit
  // are held to one vocabulary. Absent *and* null both mean "not set" — a key
  // written as `due:` with nothing after it is an empty field, not a malformed
  // one, and only a value that is present and wrong is worth interrupting for.
  for (const key of ['due', 'priority', 'tags', 'reminder', 'recurrence', 'order'] as const) {
    const value = front[key]
    if (value === undefined || value === null) continue
    Object.assign(task, { [key]: PATCH_READERS[key]!(value) })
  }

  const extra = Object.fromEntries(Object.entries(front).filter(([k]) => !KNOWN_KEYS.has(k)))
  if (Object.keys(extra).length > 0) task.extra = extra

  return task
}

/**
 * A field edit, on its way to a file. `undefined` for a key that is *present*
 * means "clear it" — which is why the caller must merge by spreading rather than
 * by testing each value for undefined.
 */
export type TaskPatch = Partial<
  Pick<
    Task,
    'status' | 'due' | 'priority' | 'tags' | 'reminder' | 'recurrence' | 'order' | 'description'
  >
>

/** The fields a patch may name, and how each one reads. Sharing these readers
 * with `parseTaskFile` is the point: an edit and a hand-written file are held to
 * the same vocabulary, so the board cannot write a file it would then refuse. */
const PATCH_READERS: Record<string, (v: unknown) => unknown> = {
  status: (v) => enumOf(v, STATUSES, 'status'),
  // A stamp (D79): the time is optional, and its absence is meaningful — a task
  // due `2026-08-25` is due that day, not at midnight on it. `parseStamp` rather
  // than a fourth regex here: the validity rules (real calendar dates, hour and
  // minute bounds) live in `dates.ts` and must not be restated.
  due: (v) => {
    if (typeof v !== 'string' || parseStamp(v) === null) {
      throw new TaskFileError(
        `due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM, got: ${JSON.stringify(v)}`,
      )
    }
    return v
  },
  priority: (v) => enumOf(v, PRIORITIES, 'priority'),
  tags: (v) => {
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) {
      throw new TaskFileError('tags must be a list of strings')
    }
    return v
  },
  reminder: (v) => {
    // NOT checked against the stamp shape, and deliberately so — even though the
    // picker is now the only thing that writes one. These readers are shared
    // with `parseTaskFile` on purpose, so a strict reader here would make a
    // hand-written `reminder: 1d` break the whole task into the broken strip.
    // An unparseable reminder is inert (prd/tasks.md §Recurrence & reminders),
    // never an error: it costs a notification, not a task.
    if (typeof v !== 'string') throw new TaskFileError('reminder must be a string')
    return v
  },
  recurrence: parseRecurrence,
  // Lenient, like `reminder` and for the same reason: these readers are shared
  // with `parseTaskFile`, so throwing here would take a hand-written
  // `order: first` and break the whole task into the broken strip over a sort
  // key. Junk reads as no rank, and no rank sorts last.
  order: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
  description: (v) => {
    if (typeof v !== 'string') throw new TaskFileError('description must be a string')
    return v
  },
}

/** The fields with a meaningful empty state. `null` on one of these clears it;
 * `null` anywhere else is a bug in the caller, not a value. */
const CLEARABLE = new Set(['due', 'priority', 'reminder', 'recurrence'])

/**
 * Validate a field edit before it becomes a file write.
 *
 * Deliberately **stricter than the file parser**: an unknown key throws here,
 * where the parser carries it into `Task.extra`. The parser must tolerate keys
 * from a hand-edited or migrated file; a patch comes from our own UI, so an
 * unrecognised key is a typo — and silently dropping it looks to the user like
 * the edit simply did not take.
 */
export function parseTaskPatch(raw: unknown): TaskPatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskFileError('patch must be an object')
  }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const read = PATCH_READERS[key]
    if (read === undefined) throw new TaskFileError(`unknown field: ${key}`)
    if (value === null) {
      if (!CLEARABLE.has(key)) throw new TaskFileError(`${key} cannot be cleared`)
      // Present-and-undefined. The merge spreads, so this unsets the field.
      patch[key] = undefined
      continue
    }
    patch[key] = read(value)
  }
  return patch as TaskPatch
}

/** `yaml: null` means the file had no frontmatter fence at all — a valid task
 * whose body is the whole file. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { yaml: null, body: normalized.trim() }

  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    throw new TaskFileError('unterminated YAML frontmatter: no closing `---`')
  }
  const yaml = normalized.slice(4, end + 1)
  const afterFence = normalized.indexOf('\n', end + 1)
  const body = afterFence === -1 ? '' : normalized.slice(afterFence + 1)
  return { yaml: yaml.trim() === '' ? null : yaml, body: body.trim() }
}

function enumOf<T extends string>(value: unknown, allowed: T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TaskFileError(
      `${field} must be one of ${allowed.join(' | ')}, got: ${JSON.stringify(value)}`,
    )
  }
  return value as T
}

function parseRecurrence(value: unknown): Recurrence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskFileError('recurrence must be a map')
  }
  const rec = value as Record<string, unknown>
  const frequency = enumOf(rec.frequency, FREQUENCIES, 'recurrence.frequency')

  const interval = rec.interval ?? 1
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1) {
    throw new TaskFileError(
      `recurrence.interval must be an integer >= 1, got: ${JSON.stringify(rec.interval)}`,
    )
  }

  const out: Recurrence = { frequency, interval }

  if (rec.weekdays !== undefined && rec.weekdays !== null) {
    if (!Array.isArray(rec.weekdays)) {
      throw new TaskFileError('recurrence.weekdays must be a list')
    }
    // An empty selection is stored as absent, never as []: nextWeeklyWeekday
    // returns null on an empty set, so a literal empty list would silently stop
    // the recurrence rather than mean "no weekday constraint".
    const days = rec.weekdays.map((d) => enumOf(d, WEEKDAYS, 'recurrence.weekdays[]'))
    if (days.length) out.weekdays = days
  }
  if (rec.endDate !== undefined && rec.endDate !== null) {
    if (typeof rec.endDate !== 'string' || !DATE_RE.test(rec.endDate)) {
      throw new TaskFileError(
        `recurrence.endDate must be YYYY-MM-DD, got: ${JSON.stringify(rec.endDate)}`,
      )
    }
    out.endDate = rec.endDate
  }
  return out
}

/** Always spell out `interval`, and drop empty optionals, so a recurrence
 * serializes the same bytes whether or not the writer stated the default. (The
 * inherited comment here claimed it *dropped* a defaulted interval; it never
 * did — normalising by always writing it is what makes the output stable.) */
function compactRecurrence(rec: Recurrence): Record<string, unknown> {
  const out: Record<string, unknown> = { frequency: rec.frequency, interval: rec.interval }
  if (rec.weekdays?.length) out.weekdays = rec.weekdays
  if (rec.endDate !== undefined) out.endDate = rec.endDate
  return out
}
