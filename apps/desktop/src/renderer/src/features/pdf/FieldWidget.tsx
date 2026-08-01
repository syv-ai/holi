import type { TemplateField } from '@holi/shared'
import {
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/primitives'

export interface WidgetProps {
  field: TemplateField
  value: string
  onChange: (value: string) => void
}

// Radix Select forbids an empty-string value, so a blank selection rides this
// sentinel (mapped back to '' on change) — the '—' choice means "unset". Kept
// distinctive so it can't collide with a real template option value.
const NONE = '__none__'

/**
 * The type → widget registry for the Convert block. Each control is string-valued
 * (a checkbox contributes "true"/"false"); the engine coerces to native Typst
 * values later. An unknown type can't occur (normalizeFields clamps to the six),
 * but the switch falls back to a text input for safety. Every control is a
 * primitive — no native form element survives here.
 */
export function FieldWidget({ field, value, onChange }: WidgetProps) {
  switch (field.type) {
    case 'textarea':
      return (
        <Textarea
          data-convert-field={field.key}
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'date':
      return (
        <Input
          data-convert-field={field.key}
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
      return (
        <Input
          data-convert-field={field.key}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'select':
      return (
        <Select
          value={value === '' ? NONE : value}
          onValueChange={(v) => onChange(v === NONE ? '' : v)}
        >
          <SelectTrigger className="w-full" data-convert-field={field.key}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'checkbox':
      return (
        <Checkbox
          data-convert-field={field.key}
          checked={value === 'true'}
          onCheckedChange={(c) => onChange(c === true ? 'true' : 'false')}
        />
      )
    default:
      return (
        <Input
          data-convert-field={field.key}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
