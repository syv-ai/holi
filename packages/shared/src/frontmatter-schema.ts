/**
 * What a frontmatter key *is*, so an editor can show a control instead of text.
 *
 * The frontmatter block in the editor renders a row per key, and a row needs to
 * know whether it is drawing a word, a moment, or a list. That knowledge is
 * here — pure, browser-safe, and shared — rather than in the widget, because
 * the renderer, main and the tests must agree about it and a second copy would
 * drift the first time a field was added.
 *
 * **A schema is per file kind, not global.** A task's frontmatter is half the
 * point of the file; a note's is metadata over prose. They carry different keys
 * and there is no reason to pretend otherwise.
 *
 * **It never decides what a file may contain.** A key the schema does not name
 * is not an error and is never dropped — it renders as text and is written back
 * verbatim, exactly as `Task.extra` already promises. The schema adds controls;
 * it does not take keys away.
 */
import { isAgentSurfacePath, isHiddenPath } from './path-safety'
import { isTaskFilePath } from './task-file'

/** How a value is edited. The renderer maps each of these to one control. */
export type FieldKind =
  /** One of a fixed vocabulary. */
  | { readonly kind: 'enum'; readonly options: readonly string[] }
  /** A stamp (D79): `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when it names a time. */
  | { readonly kind: 'stamp' }
  /** A calendar day and nothing finer. */
  | { readonly kind: 'date' }
  /** A list of short strings. */
  | { readonly kind: 'list' }
  /** The recurrence rule's nested map. */
  | { readonly kind: 'recurrence' }
  /** Anything else, including every key the schema does not name. */
  | { readonly kind: 'text' }

export interface FieldSpec {
  readonly key: string
  readonly kind: FieldKind
  /**
   * Known, editable elsewhere, and not shown as a row.
   *
   * `order` is the only one: it is a sort rank the board writes by dragging,
   * and `Task.order`'s own comment says it is the one key in a task file that
   * means nothing to a human reading it. Hiding it is not hiding data — the row
   * would be a number you must not hand-edit sitting between two you should.
   */
  readonly hidden?: boolean
}

/** `todo | doing | done`, and the rest of the task vocabulary. Duplicated from
 *  nothing: `task-file.ts` holds the same lists as runtime validators, and these
 *  are the same words in the shape a control needs. */
const TASK_FIELDS: readonly FieldSpec[] = [
  // Order is what the widget renders, and it reads top to bottom as the
  // questions you ask about a task: what state is it in, how much does it
  // matter, when is it due, when should I hear about it, does it come back, and
  // finally how is it filed. `folder` is rendered above these by the widget
  // itself, being derived rather than written. This order is DISPLAY only:
  // `serializeTaskFile` builds its own object, so changing it here rewrites no
  // task file.
  { key: 'status', kind: { kind: 'enum', options: ['todo', 'doing', 'done'] } },
  { key: 'priority', kind: { kind: 'enum', options: ['low', 'medium', 'high'] } },
  { key: 'due', kind: { kind: 'stamp' } },
  { key: 'reminder', kind: { kind: 'stamp' } },
  { key: 'recurrence', kind: { kind: 'recurrence' } },
  { key: 'tags', kind: { kind: 'list' } },
  { key: 'order', kind: { kind: 'text' }, hidden: true },
]

/** What `scaffoldNoteText` writes, and nothing more. A note has no `title`
 *  deliberately (see `scaffold-md.ts`), so there is no row for one. */
const NOTE_FIELDS: readonly FieldSpec[] = [
  { key: 'created', kind: { kind: 'date' } },
  { key: 'tags', kind: { kind: 'list' } },
]

/**
 * The schema for a file, or `null` when its frontmatter is not ours to draw as
 * fields.
 *
 * Null is not "no keys" — it means **show the YAML**. Under `.claude/` the
 * frontmatter is a typed interface with a schema of its own (a skill's `name`
 * and `description` are what the agent matches on), and `AGENTS.md` and its
 * neighbours are read verbatim as prompt text. Rendering those as rows would
 * be this app inventing a shape for someone else's contract. Hidden paths are
 * Holi's own config and the vault apps, which are not prose either.
 */
export function frontmatterSchema(path: string): readonly FieldSpec[] | null {
  if (!path.endsWith('.md')) return null
  if (isAgentSurfacePath(path)) return null
  if (isHiddenPath(path)) return null
  return isTaskFilePath(path) ? TASK_FIELDS : NOTE_FIELDS
}

/**
 * The rows to draw, in order: every visible key the schema names, then every key
 * the file has that it does not.
 *
 * Schema keys come first and come **whether or not the file has them**, so a
 * field can be filled in without knowing its name — the same instinct as the
 * settings files, which list every setting rather than only the ones somebody
 * already set. Nothing is written until a value is actually given, so six rows
 * never mean six keys on disk.
 */
export function frontmatterRows(
  schema: readonly FieldSpec[],
  keys: readonly string[],
): readonly FieldSpec[] {
  const known = new Set(schema.map((f) => f.key))
  return [
    ...schema.filter((f) => f.hidden !== true),
    ...keys.filter((k) => !known.has(k)).map((key): FieldSpec => ({ key, kind: { kind: 'text' } })),
  ]
}
