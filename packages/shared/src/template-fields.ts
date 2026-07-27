/** The data type a template metadata field declares. Drives the Convert-dialog
 * widget, the native Typst value the template receives, and how it is presented.
 * A curated, closed set — adding a seventh type is one entry per unit. */
export type TemplateFieldType = 'text' | 'textarea' | 'date' | 'select' | 'number' | 'checkbox'

/** A template's metadata field, as it travels from the manifest to the dialog.
 * `type` defaults to `text` when a manifest omits or misuses it (see
 * `normalizeFields`), so every legacy untyped field keeps working. */
export interface TemplateField {
  /** Identifier; becomes `meta.<key>` in the template. */
  key: string
  /** Shown beside the widget; defaults to `key`. */
  label: string
  type: TemplateFieldType
  required: boolean
  /** Initial widget value. `"today"` resolves to the current date for a `date`
   *  field; `""` forces a blank prefill; any other literal is used as-is. */
  default?: string
  /** Dropdown choices; only meaningful for `type: 'select'`. */
  options?: string[]
}

/**
 * The initial string value a widget shows before the user edits it. Every value
 * is a string (HTML controls are string-valued; a checkbox is `"true"`/`"false"`).
 * `today` (local `YYYY-MM-DD`) is passed in so the resolver stays pure and
 * deterministic under test.
 */
export function initialValue(field: TemplateField, today: string): string {
  if (field.default !== undefined) {
    return field.default === 'today' && field.type === 'date' ? today : field.default
  }
  if (field.type === 'date') return today
  if (field.type === 'checkbox') return 'false'
  return ''
}

export interface ParsedFields {
  fields: TemplateField[]
  /** One short, human-readable line per degradation. Empty = a clean manifest. */
  warnings: string[]
}

const FIELD_TYPES: readonly TemplateFieldType[] = [
  'text',
  'textarea',
  'date',
  'select',
  'number',
  'checkbox',
]

/** A real calendar date in `YYYY-MM-DD` — rejects e.g. `2026-13-40` (which would
 *  otherwise throw when the template coerces it to a Typst `datetime`). */
function isRealISODate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m === null) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * Normalize a manifest's `fields` array into usable `TemplateField[]`, and report
 * every degradation it had to make. Same resilience as before (a bad manifest
 * never breaks Convert — it degrades), but no longer silent: the Convert dialog
 * shows the warnings so a hand-authored `template.json` says what it got wrong.
 *
 * An **absent** `type` becomes `text` with NO warning (the legacy untyped-field
 * path); a `type` that is present but not one of the six DOES warn.
 */
export function parseFields(raw: unknown): ParsedFields {
  const fields: TemplateField[] = []
  const warnings: string[] = []
  if (!Array.isArray(raw)) return { fields, warnings }

  raw.forEach((f, i) => {
    if (typeof f !== 'object' || f === null) {
      warnings.push(`field #${i} is not an object and was ignored`)
      return
    }
    const g = f as Record<string, unknown>
    if (typeof g.key !== 'string') {
      warnings.push(`field #${i} has no "key" and was ignored`)
      return
    }
    const key = g.key

    let type: TemplateFieldType = 'text'
    if (typeof g.type === 'string') {
      if ((FIELD_TYPES as readonly string[]).includes(g.type)) {
        type = g.type as TemplateFieldType
      } else {
        warnings.push(`field "${key}": unknown type "${g.type}", using text`)
      }
    }

    const options =
      Array.isArray(g.options) && g.options.every((o) => typeof o === 'string')
        ? (g.options as string[])
        : undefined
    // A select needs options to render a dropdown; without them, degrade to text.
    if (type === 'select' && (options === undefined || options.length === 0)) {
      warnings.push(`field "${key}": select has no options, using text`)
      type = 'text'
    }

    // A string default is kept as-is, except a `date` default that is not
    // "today"/""/a real YYYY-MM-DD — that would throw at render, so drop + warn.
    let def: string | undefined = typeof g.default === 'string' ? g.default : undefined
    if (type === 'date' && def !== undefined && def !== 'today' && def !== '' && !isRealISODate(def)) {
      warnings.push(
        `field "${key}": default "${def}" is not a valid date (use YYYY-MM-DD or "today"), ignoring it`,
      )
      def = undefined
    }

    fields.push({
      key,
      label: typeof g.label === 'string' ? g.label : key,
      type,
      required: g.required === true,
      ...(def !== undefined ? { default: def } : {}),
      ...(type === 'select' && options !== undefined ? { options } : {}),
    })
  })

  return { fields, warnings }
}
