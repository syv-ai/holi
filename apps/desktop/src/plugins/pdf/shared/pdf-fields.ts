import { splitFrontmatter } from '@holi/shared'
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
 */
function parseFrontmatter(text: string): Record<string, unknown> {
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

/** A leading H1 (`# Title`, up to three spaces in), its closing hashes dropped. */
const TOP_H1 = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

/** The folder whose subfolders are clients: `kunder/<client>/…`. */
const CLIENTS_FOLDER = 'kunder'

/**
 * What a note says about itself without frontmatter, by field key: `title` is
 * the H1 the note opens with, and `client` the folder directly under `kunder/`
 * when the note is anywhere inside one (`kunder/Acme/reports/a.md` is Acme's;
 * `kunder/a.md` and anything outside `kunder/` have no client). Read off the
 * note rather than written into a template, so it fills a field of that key in
 * any vault's templates, seeded or not. Never throws.
 */
function noteValues(path: string, text: string): Record<string, string> {
  const values: Record<string, string> = {}
  let body = text
  try {
    body = splitFrontmatter(text).body
  } catch {
    // An unterminated fence is a note mid-edit: read it whole.
  }
  const first = body.split('\n').find((line) => line.trim() !== '')
  const title = first === undefined ? undefined : TOP_H1.exec(first)?.[1]?.trim()
  if (title) values.title = title
  const segments = path.split('/')
  if (segments[0] === CLIENTS_FOLDER && segments.length > 2 && segments[1] !== '') {
    values.client = segments[1]!
  }
  return values
}

/**
 * Seed the Convert dialog's field values: a note's frontmatter pre-fills any
 * field whose `key` it declares (exact match); a field with a `default` of its
 * own takes it; a text field the note answers (`noteValues`) takes that; and
 * every other field keeps its type default (`initialValue`).
 */
function prefillValues(
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
        : undefined
    seed[f.key] = fromFm ?? derived ?? initialValue(f, today)
  }
  return seed
}

/**
 * The prefilled field values for a note at `path` (vault-relative) with text
 * `text`: its frontmatter, then what it says without it (`noteValues`), then
 * each field's default (`prefillValues`). The Convert dialog and
 * `holi pdf render` both seed their fields through this one function, so the
 * two fill the same. Never throws: a note whose frontmatter does not parse
 * prefills from the rest.
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
    // An unterminated fence is a note mid-edit: no frontmatter to read.
  }
  return prefillValues(fields, frontmatter, today, noteValues(path, text))
}
