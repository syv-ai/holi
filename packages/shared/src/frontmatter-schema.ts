/**
 * What a frontmatter key *is*, so an editor can show a control instead of text.
 *
 * Shared rather than in the widget because the renderer, main and the tests must
 * agree about it. See docs/features/frontmatter.md.
 *
 * **A schema is per file kind, not global**: tasks and notes carry different keys.
 *
 * **It never decides what a file may contain.** A key the schema does not name
 * is never dropped: it renders as text and is written back verbatim, as
 * `Task.extra` promises. The schema adds controls; it does not take keys away.
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
   * `order` is the only one: a sort rank the board writes by dragging, which
   * means nothing to a human and must not be hand-edited.
   */
  readonly hidden?: boolean
}

/** `todo | doing | done`, and the rest of the task vocabulary: the same words
 *  `task-file.ts` validates, in the shape a control needs. */
const TASK_FIELDS: readonly FieldSpec[] = [
  // DISPLAY order only: `serializeTaskFile` builds its own object, so changing
  // it here rewrites no task file. `folder` is derived and rendered above these
  // by the widget itself.
  { key: 'status', kind: { kind: 'enum', options: ['todo', 'doing', 'done'] } },
  { key: 'priority', kind: { kind: 'enum', options: ['low', 'medium', 'high'] } },
  { key: 'due', kind: { kind: 'stamp' } },
  { key: 'reminder', kind: { kind: 'stamp' } },
  { key: 'recurrence', kind: { kind: 'recurrence' } },
  { key: 'tags', kind: { kind: 'list' } },
  { key: 'order', kind: { kind: 'text' }, hidden: true },
]

/** What `scaffoldNoteText` writes, and nothing more. No `title` (see
 *  `scaffold-md.ts`) and no `created`: that is the file's first commit, shown as
 *  read-only metadata, never a date someone could edit into disagreeing with git. */
const NOTE_FIELDS: readonly FieldSpec[] = [{ key: 'tags', kind: { kind: 'list' } }]

/**
 * The schema for a file, or `null` when its frontmatter is not ours to draw as
 * fields.
 *
 * Null is not "no keys": it means **show the YAML**. Agent-surface files have
 * their own contract (a skill's `name` and `description` are what the agent
 * matches on), and hidden paths are Holi's config and vault apps, not prose.
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
 * field can be filled in without knowing its name. Nothing is written until a
 * value is given, so six rows never mean six keys on disk.
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
