import type { TemplateField, TemplateFieldType } from '@holi/shared'

/** Escape a JS string for a Typst double-quoted string literal. Backslash first,
 * then quote, so the escape characters themselves aren't re-escaped. */
export function typstString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * A Typst dictionary literal from a template's fields and the raw string values
 * the dialog collected, coercing each value to a native Typst value per the
 * field's type. A blank optional value is omitted (the template reads
 * `meta.at(key, default: none)`); a checkbox is always present. Empty → `(:)`.
 * Keys are assumed valid Typst identifiers — they are a template's declared keys.
 */
export function coerceMeta(fields: TemplateField[], values: Record<string, string>): string {
  const entries: string[] = []
  for (const f of fields) {
    if (f.type === 'checkbox') {
      entries.push(`${f.key}: ${values[f.key] === 'true' ? 'true' : 'false'}`)
      continue
    }
    const raw = values[f.key]
    if (raw === undefined || raw === '') continue // blank optional → omit
    entries.push(`${f.key}: ${coerceValue(f.type, raw)}`)
  }
  if (entries.length === 0) return '(:)'
  return `(${entries.join(', ')})`
}

function coerceValue(type: TemplateFieldType, raw: string): string {
  switch (type) {
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error(`invalid number for template field: ${raw}`)
      return String(n)
    }
    case 'date':
      return typstDatetime(raw)
    default:
      return typstString(raw)
  }
}

/** `YYYY-MM-DD` → a Typst `datetime(...)` literal. Throws on a malformed date so
 *  a hand-authored bad `default` surfaces as a clear error, not a typst crash. */
function typstDatetime(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (m === null) throw new Error(`invalid date for template field: ${raw}`)
  return `datetime(year: ${Number(m[1])}, month: ${Number(m[2])}, day: ${Number(m[3])})`
}

export interface WrapperInput {
  /** Absolute `.holi/templates/<name>/`. */
  templateDir: string
  /** Absolute path to the note being rendered. */
  notePath: string
  /** Absolute `<templateDir>/assets`. */
  assetsDir: string
  /** The template's declared fields — drives value coercion. */
  fields: TemplateField[]
  /** Raw string values from the dialog, keyed by field key. */
  meta: Record<string, string>
}

/**
 * The tiny Typst program the engine compiles in a temp dir: import the
 * template's `doc` function and call it. Every path is absolute, so
 * `typst compile … --root /` can read the note and template even though the
 * wrapper itself lives in an unrelated temp directory.
 */
export function composeWrapper({
  templateDir,
  notePath,
  assetsDir,
  fields,
  meta,
}: WrapperInput): string {
  return (
    `#import ${typstString(`${templateDir}/template.typ`)}: doc\n` +
    `#doc(${typstString(notePath)}, meta: ${coerceMeta(fields, meta)}, assets: ${typstString(assetsDir)})\n`
  )
}
