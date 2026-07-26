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
