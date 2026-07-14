/**
 * The task file projection — `tasks/<slug>-<id>.md`, YAML frontmatter + a
 * markdown body that *is* the task's `description` (prd/tasks.md §Task file
 * projection).
 *
 * The record is the truth; the file is a writable view of it. This module is
 * the single implementation of the format. It is pure and browser-safe, and it
 * is called only on the two projection edges:
 *
 *   - serialize: record -> file (a full rewrite, never a patch)
 *   - parse:     file -> record (translated into a per-field patch by the caller)
 *
 * `parseTaskFile` runs ONLY on an inbound write. Nothing in the system parses
 * the `tasks/` folder to answer a question — the board, the agenda, reminders
 * and `task_list` all read Postgres. The file is a projection, not an index.
 *
 * Every malformed input throws `TaskFileError`: a write that does not parse
 * loses, and the caller rewrites the file from the record. The model *will*
 * write bad frontmatter, so this is a load-bearing guard rather than a
 * formality — it must never partially apply.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  Priority,
  Recurrence,
  RecurrenceFrequency,
  RecurrenceWeekday,
  RelatedRef,
  RelatedRefKind,
  TaskStatus,
} from './types'

export class TaskFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskFileError'
  }
}

export const TASKS_DIR = 'tasks'

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']
const FREQUENCIES: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly']
const WEEKDAYS: RecurrenceWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const REF_KINDS: RelatedRefKind[] = ['note', 'task', 'email', 'event']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const SLUG_MAX = 60
const SLUG_FALLBACK = 'task'

/**
 * A `related[]` entry as it appears *in the file*.
 *
 * Notes render as a `path` — machine references use stable IDs, human-facing
 * text uses paths, and a note rename therefore never rewrites a task record.
 * The `id` form is the tombstone for a note whose doc is gone: it round-trips
 * the docId rather than dropping the ref, because dropping it would silently
 * delete the link on the next inbound write. Non-note kinds always carry `id`.
 */
export interface TaskFileRef {
  kind: RelatedRefKind
  path?: string
  id?: string
}

/** Resolvers for the two reference seams. The record stores stable IDs; the
 * file renders paths — so a note or folder rename never rewrites a task. */
export interface TaskFileResolvers {
  notePathFor: (docId: string) => string | undefined
  folderPathFor: (folderId: string) => string | undefined
}

/** The fields the frontmatter can carry. Only keys actually present are set —
 * the inbound diff reads presence, so "absent" and "cleared" must stay
 * distinguishable.
 *
 * `area` and `related` are in their *file* form (paths). Resolve them to record
 * form with `areaFromFile` / `relatedFromFile`. */
export interface TaskFileFields {
  title?: string
  status?: TaskStatus
  /** A folder path (`projects/q2`), or the raw folder id as a tombstone when
   * the folder is gone. */
  area?: string
  due?: string
  priority?: Priority
  tags?: string[]
  reminder?: string
  recurrence?: Recurrence
  related?: TaskFileRef[]
}

export interface ParsedTaskFile {
  /** Absent = the writer created this file by hand; the caller creates a record. */
  id?: string
  /** Only ever set by a file written before D8, when the token still lived in the
   * frontmatter. Parsed so those files stay readable; nothing consumes it. The
   * concurrency token is carried out-of-band now — see `serializeTaskFile`. */
  version?: number
  fields: TaskFileFields
  /** The markdown body. This *is* the task's description. */
  description: string
}

/** What serialization needs off a record. `Task` structurally satisfies it. */
export interface TaskFileSource {
  id: string
  title: string
  status: TaskStatus
  area?: string
  due?: string
  priority?: Priority
  tags?: string[]
  reminder?: string
  recurrence?: Recurrence
  related?: RelatedRef[]
  description?: string
}

/** `Review the Q2 doc` -> `review-the-q2-doc`. Never empty, never edge-dashed. */
export function taskSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  return slug === '' ? SLUG_FALLBACK : slug
}

/** The canonical path for a task. A title edit moves the file; the `id` suffix
 * keeps identity stable, so git renders it as a rename. */
export function taskFilePath(task: Pick<TaskFileSource, 'id' | 'title'>): string {
  return `${TASKS_DIR}/${taskSlug(task.title)}-${task.id}.md`
}

/** Task files are not CRDT docs. The mirror uses this to keep them out of the
 * doc machinery entirely — no adoption, no bridge, no base, no turn, no merge. */
export function isTaskFilePath(rel: string): boolean {
  return rel.startsWith(`${TASKS_DIR}/`) && rel.endsWith('.md')
}

/**
 * The task id out of `tasks/<slug>-<id>.md`, or undefined when the name carries
 * none (a hand-written file — that is a create).
 *
 * The **filename** is the identity, not the frontmatter: a git delete has no blob
 * left to read an id out of, and a rename has to be recognised as the same task
 * before either blob is parsed. Anchored to the end so a slug that happens to
 * contain something uuid-shaped cannot shadow the real suffix.
 */
export function taskIdFromPath(rel: string): string | undefined {
  const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i.exec(rel)
  return match?.[1]
}

export function serializeTaskFile(task: TaskFileSource, resolvers: TaskFileResolvers): string {
  // Key order is fixed so an unchanged record always serializes byte-identically —
  // the projector's echo guard and the git mirror both compare on text.
  const front: Record<string, unknown> = { id: task.id, title: task.title, status: task.status }

  if (task.area !== undefined) {
    // A path when we can resolve it, the raw folder id when we cannot.
    //
    // The fallback is NOT a tombstone for a deleted folder — a deleted folder sets its
    // tasks' `area` to null (schema.ts), so a task never points at one that is gone.
    // It fires when the *resolver* is stale: the desktop snapshots the folder map, and
    // a folder created since then is unknown to it.
    //
    // Emitting the id rather than omitting the key is what makes that harmless. An
    // absent `area:` reads as "cleared" to the inbound diff, so omitting it would let a
    // stale map silently unfile the task. The id round-trips back through areaFromFile
    // untouched, so a stale render costs nothing but an ugly line the next write fixes.
    front.area = resolvers.folderPathFor(task.area) ?? task.area
  }
  if (task.due !== undefined) front.due = task.due
  if (task.priority !== undefined) front.priority = task.priority
  if (task.tags?.length) front.tags = task.tags
  if (task.reminder !== undefined) front.reminder = task.reminder
  if (task.recurrence !== undefined) front.recurrence = compactRecurrence(task.recurrence)
  if (task.related?.length) {
    front.related = task.related.map((ref) => refToFile(ref, resolvers.notePathFor))
  }
  // `version` is deliberately NOT written (D8). It bumps on every mutation, so in
  // the frontmatter a reminder firing would rewrite the file to change one integer
  // — and with the git mirror on, the bot would *commit* that, forever, on an
  // otherwise idle vault. It is also a machine token the agent must never hand-edit.
  // The desktop keeps it in the ProjectionStore, which already stores it per task;
  // git ingest diffs against the commit's own base blob and needs no token at all.

  const body = (task.description ?? '').trim()
  const yaml = stringifyYaml(front)
  return body === '' ? `---\n${yaml}---\n` : `---\n${yaml}---\n\n${body}\n`
}

export function parseTaskFile(text: string): ParsedTaskFile {
  const { yaml, body } = splitFrontmatter(text)

  let raw: unknown
  try {
    raw = parseYaml(yaml)
  } catch (err) {
    throw new TaskFileError(`frontmatter is not valid YAML: ${(err as Error).message}`)
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskFileError('frontmatter must be a YAML map')
  }
  const front = raw as Record<string, unknown>

  const parsed: ParsedTaskFile = { fields: {}, description: body }

  if (front.id !== undefined && front.id !== null) {
    if (typeof front.id !== 'string' || !UUID_RE.test(front.id)) {
      throw new TaskFileError(`id must be a uuid, got: ${JSON.stringify(front.id)}`)
    }
    parsed.id = front.id
  }

  if (front.version !== undefined && front.version !== null) {
    if (typeof front.version !== 'number' || !Number.isInteger(front.version)) {
      throw new TaskFileError(`version must be an integer, got: ${JSON.stringify(front.version)}`)
    }
    parsed.version = front.version
  }

  // title is NOT NULL on the record — a file without one cannot become a task.
  if (typeof front.title !== 'string' || front.title.trim() === '') {
    throw new TaskFileError('title is required and must be a non-empty string')
  }
  parsed.fields.title = front.title.trim()

  if (front.status !== undefined) {
    parsed.fields.status = enumOf(front.status, STATUSES, 'status')
  }
  if (front.area !== undefined) {
    // A folder path — resolved to the stable folder id by `areaFromFile`. Not
    // validated as a uuid here: the whole point is that the agent can write a
    // path it can actually see (it has no way to discover a folder id).
    if (typeof front.area !== 'string' || front.area.trim() === '') {
      throw new TaskFileError(`area must be a folder path, got: ${JSON.stringify(front.area)}`)
    }
    parsed.fields.area = front.area.trim()
  }
  if (front.due !== undefined) {
    if (typeof front.due !== 'string' || !DATE_RE.test(front.due)) {
      throw new TaskFileError(`due must be YYYY-MM-DD, got: ${JSON.stringify(front.due)}`)
    }
    parsed.fields.due = front.due
  }
  if (front.priority !== undefined) {
    parsed.fields.priority = enumOf(front.priority, PRIORITIES, 'priority')
  }
  if (front.tags !== undefined) {
    if (!Array.isArray(front.tags) || front.tags.some((t) => typeof t !== 'string')) {
      throw new TaskFileError('tags must be a list of strings')
    }
    parsed.fields.tags = front.tags as string[]
  }
  if (front.reminder !== undefined) {
    // The grammar is deliberately NOT validated here: an unparseable reminder is
    // inert (prd/tasks.md §Recurrence & reminders), never an error.
    if (typeof front.reminder !== 'string') {
      throw new TaskFileError('reminder must be a string')
    }
    parsed.fields.reminder = front.reminder
  }
  if (front.recurrence !== undefined) {
    parsed.fields.recurrence = parseRecurrence(front.recurrence)
  }
  if (front.related !== undefined) {
    parsed.fields.related = parseRelated(front.related)
  }

  return parsed
}

function splitFrontmatter(text: string): { yaml: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    throw new TaskFileError('missing YAML frontmatter: the file must start with `---`')
  }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    throw new TaskFileError('unterminated YAML frontmatter: no closing `---`')
  }
  const yaml = normalized.slice(4, end + 1)
  if (yaml.trim() === '') {
    throw new TaskFileError('frontmatter is empty')
  }
  const afterFence = normalized.indexOf('\n', end + 1)
  const body = afterFence === -1 ? '' : normalized.slice(afterFence + 1)
  return { yaml, body: body.trim() }
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

  if (rec.weekdays !== undefined) {
    if (!Array.isArray(rec.weekdays)) {
      throw new TaskFileError('recurrence.weekdays must be a list')
    }
    out.weekdays = rec.weekdays.map((d) => enumOf(d, WEEKDAYS, 'recurrence.weekdays[]'))
  }
  if (rec.endDate !== undefined) {
    if (typeof rec.endDate !== 'string' || !DATE_RE.test(rec.endDate)) {
      throw new TaskFileError(
        `recurrence.endDate must be YYYY-MM-DD, got: ${JSON.stringify(rec.endDate)}`,
      )
    }
    out.endDate = rec.endDate
  }
  return out
}

function parseRelated(value: unknown): TaskFileRef[] {
  if (!Array.isArray(value)) {
    throw new TaskFileError('related must be a list')
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TaskFileError('related[] entries must be maps')
    }
    const ref = entry as Record<string, unknown>
    const kind = enumOf(ref.kind, REF_KINDS, 'related[].kind')

    if (kind === 'note') {
      if (typeof ref.path === 'string' && ref.path !== '') return { kind, path: ref.path }
      if (typeof ref.id === 'string' && ref.id !== '') return { kind, id: ref.id }
      throw new TaskFileError('related[] note refs need a path (or an id, for a deleted note)')
    }
    if (typeof ref.id !== 'string' || ref.id === '') {
      throw new TaskFileError(`related[] ${kind} refs need an id`)
    }
    return { kind, id: ref.id }
  })
}

function refToFile(
  ref: RelatedRef,
  notePathFor: (docId: string) => string | undefined,
): TaskFileRef {
  if (ref.kind !== 'note') return { kind: ref.kind, id: ref.id }
  const path = notePathFor(ref.id)
  // No path = the note is gone. Emit the docId as a tombstone; do NOT drop the
  // ref, or the next inbound write would delete the link.
  return path === undefined ? { kind: 'note', id: ref.id } : { kind: 'note', path }
}

/**
 * The inbound half of the area seam: a folder path -> the stable folder id.
 *
 * A raw folder id passes through untouched. That is what a *stale* serializer wrote
 * when it could not resolve the folder (see `serializeTaskFile`), and re-resolving it
 * would fail for no reason — it is already the answer. An unresolvable *path* rejects
 * the write, same rule as a bogus note path.
 */
export function areaFromFile(
  area: string,
  folderIdForPath: (path: string) => string | undefined,
): string {
  if (UUID_RE.test(area)) return area
  const folderId = folderIdForPath(area)
  if (folderId === undefined) {
    throw new TaskFileError(`area references an unknown folder: ${area}`)
  }
  return folderId
}

/**
 * The inbound half of the path<->docId seam: file refs -> record refs.
 *
 * A note path that resolves to no doc **rejects the whole write** (the caller
 * discards it and rewrites the file from the record). The harsh option is the
 * right one: dropping just the bad ref and applying the rest is silent data
 * loss the user cannot see, whereas rejection is visible and self-healing — the
 * agent re-reads the corrected file on its next turn. A *legitimately* deleted
 * note is the id-tombstone case below, which resolves without a lookup, so this
 * only fires on a genuinely bogus path.
 */
export function relatedFromFile(
  refs: TaskFileRef[],
  docIdForPath: (path: string) => string | undefined,
): RelatedRef[] {
  return refs.map((ref) => {
    if (ref.kind === 'note' && ref.path !== undefined) {
      const docId = docIdForPath(ref.path)
      if (docId === undefined) {
        throw new TaskFileError(`related[] references an unknown note path: ${ref.path}`)
      }
      return { kind: 'note', id: docId }
    }
    if (ref.id === undefined) {
      throw new TaskFileError(`related[] ${ref.kind} ref has no id`)
    }
    return { kind: ref.kind, id: ref.id }
  })
}

/** Drop a defaulted `interval: 1` so an unchanged record keeps serializing the
 * same bytes whether or not the writer spelled it out. */
function compactRecurrence(rec: Recurrence): Record<string, unknown> {
  const out: Record<string, unknown> = { frequency: rec.frequency, interval: rec.interval }
  if (rec.weekdays?.length) out.weekdays = rec.weekdays
  if (rec.endDate !== undefined) out.endDate = rec.endDate
  return out
}
