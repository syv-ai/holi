import type { TemplateField } from '@holi/shared'

export interface WidgetProps {
  field: TemplateField
  value: string
  onChange: (value: string) => void
}

const control =
  'w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100'

/**
 * The type → widget registry for the Convert dialog. Each control is string-valued
 * (a checkbox contributes "true"/"false"); the engine coerces to native Typst
 * values later. An unknown type can't occur (normalizeFields clamps to the six),
 * but the switch falls back to a text input for safety.
 */
export function FieldWidget({ field, value, onChange }: WidgetProps) {
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          data-convert-field={field.key}
          rows={4}
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'date':
      return (
        <input
          data-convert-field={field.key}
          type="date"
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
      return (
        <input
          data-convert-field={field.key}
          type="number"
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'select':
      return (
        <select
          data-convert-field={field.key}
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case 'checkbox':
      return (
        <input
          data-convert-field={field.key}
          type="checkbox"
          className="h-4 w-4 accent-neutral-100"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
      )
    default:
      return (
        <input
          data-convert-field={field.key}
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
