import { splitFrontmatter } from '@holi/shared'
import { GFM, parser } from '@lezer/markdown'
import { type TemplateField, initialValue } from './template-fields'
import { parse as parseYaml } from 'yaml'

/**
 * Which required fields the user still has to fill. A checkbox is never
 * missing (false is a value); anything else is blank when it trims to empty.
 */
export function missingRequired(
  fields: TemplateField[],
  values: Record<string, string>,
): TemplateField[] {
  return fields.filter(
    (f) => f.required && f.type !== 'checkbox' && (values[f.key] ?? '').trim() === '',
  )
}

/** Collapse the widget values into the `meta` map the render mutation expects —
 *  every declared field present, absent ones defaulted to ''. */
export function metaFromValues(
  fields: TemplateField[],
  values: Record<string, string>,
): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const f of fields) meta[f.key] = values[f.key] ?? ''
  return meta
}

/**
 * A note's YAML frontmatter as a plain map, or `{}`. Never throws: no
 * frontmatter, invalid YAML, or a non-map top level all degrade to `{}`, so a
 * broken note can never break the Convert dialog.
 * @public
 */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const { yaml } = splitFrontmatter(text)
  if (yaml === null) return {}
  let parsed: unknown
  try {
    parsed = parseYaml(yaml)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

/** The widget-string form of a frontmatter value for a field, or `null` when the
 *  value can't fill that field (array/object/null/type mismatch) — the caller
 *  then keeps the type default. Exact key match is the caller's concern. */
function coerce(field: TemplateField, value: unknown): string | null {
  if (value === null || value === undefined) return null
  switch (field.type) {
    case 'date':
      // yaml parses an unquoted ISO date to a Date; a quoted one stays a string.
      if (value instanceof Date) return value.toISOString().slice(0, 10)
      return typeof value === 'string' ? value : null
    case 'checkbox':
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return value === 'true' || value === 'false' ? value : null
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
        ? value
        : null
    default:
      // text / textarea / select — scalars only.
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : null
  }
}

/**
 * Seed field values: frontmatter wins, then an eligible derived value from the
 * note, then the field's type default (`initialValue`).
 * @public
 */
export function prefillValues(
  fields: TemplateField[],
  frontmatter: Record<string, unknown>,
  today: string,
  fromNote: Record<string, string> = {},
): Record<string, string> {
  const seed: Record<string, string> = {}
  for (const f of fields) {
    const fromFm = Object.hasOwn(frontmatter, f.key) ? coerce(f, frontmatter[f.key]) : null
    const derived =
      f.default === undefined &&
      (f.type === 'text' || f.type === 'textarea') &&
      Object.hasOwn(fromNote, f.key)
        ? fromNote[f.key]
        : null
    seed[f.key] = fromFm ?? derived ?? initialValue(f, today)
  }
  return seed
}

const markdownParser = parser.configure(GFM)

/** Return the body without changing indentation that determines Markdown blocks. */
function noteBody(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return normalized
  const afterFence = normalized.indexOf('\n', end + 1)
  return afterFence === -1 ? '' : normalized.slice(afterFence + 1)
}

/** Extract only a leading H1 using the same CommonMark grammar as the editor. */
function openingH1(body: string): string | undefined {
  const tree = markdownParser.parse(body)
  const block = tree.topNode.firstChild
  if (!block || (block.name !== 'ATXHeading1' && block.name !== 'SetextHeading1')) return

  const marks: { from: number; to: number }[] = []
  for (let child = block.firstChild; child; child = child.nextSibling) {
    if (child.name === 'HeaderMark') marks.push({ from: child.from, to: child.to })
  }
  if (marks.length === 0) return
  const from = block.name === 'SetextHeading1' ? block.from : marks[0]!.to
  const to =
    block.name === 'SetextHeading1' ? marks[0]!.from : marks.length > 1 ? marks[1]!.from : block.to
  const title = body.slice(from, to).trim()
  return title || undefined
}

/**
 * Seed fields from the note's frontmatter, opening H1 and client folder.
 * Derived values fill only text/textarea fields without their own default;
 * frontmatter wins. The path is vault-relative.
 */
export function fieldValuesFor(
  fields: TemplateField[],
  path: string,
  text: string,
  today: string,
): Record<string, string> {
  let frontmatter: Record<string, unknown> = {}
  try {
    frontmatter = parseFrontmatter(text)
  } catch {
    // A note being edited with an unterminated fence still has usable body text.
  }
  const fromNote: Record<string, string> = {}
  const title = openingH1(noteBody(text))
  if (title !== undefined) fromNote.title = title
  const segments = path.split('/')
  if (segments[0] === 'kunder' && segments.length > 2 && segments[1] !== '') {
    fromNote.client = segments[1]!
  }
  return prefillValues(fields, frontmatter, today, fromNote)
}
