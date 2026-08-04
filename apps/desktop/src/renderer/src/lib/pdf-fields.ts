import { type TemplateField, initialValue, splitFrontmatter } from '@holi/shared'
import { parse as parseYaml } from 'yaml'

/**
 * Which required fields the user still has to fill. A checkbox is never
 * "missing" — false is a legitimate value — so it's excluded even when required.
 * Everything else counts as blank when it trims to empty. Pure so the block can
 * validate without owning the rule (and so it can be unit-tested directly).
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
 * Seed the Convert dialog's field values: a note's frontmatter pre-fills any
 * field whose `key` it declares (coerced to the widget's string form), and every
 * other field keeps its type default (`initialValue`). Exact key match only.
 * The user overrides any pre-filled value in the dialog before converting.
 */
export function prefillValues(
  fields: TemplateField[],
  frontmatter: Record<string, unknown>,
  today: string,
): Record<string, string> {
  const seed: Record<string, string> = {}
  for (const f of fields) {
    const fromFm = Object.hasOwn(frontmatter, f.key) ? coerce(f, frontmatter[f.key]) : null
    seed[f.key] = fromFm ?? initialValue(f, today)
  }
  return seed
}
