/**
 * One of a fixed vocabulary, as a Select in the `field` look.
 *
 * Controlled `open`, for the row's label: a label clicks its control, and
 * Radix opens a Select on a mouse's `pointerdown`, never on its `click`. So a
 * click the trigger saw no press for came from the label, and opens it here.
 *
 * An optional field offers the empty choice too, listed as `—` and shown in
 * the field as nothing at all, the same as a field never set.
 */
import { useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/primitives'
import { useFieldControlId } from '@/composites'

/** The item VALUE for the empty choice: Radix forbids '' on an item. */
const EMPTY = '—'

export function EnumField({
  name,
  value,
  options,
  clearable = true,
  onChange,
}: {
  /** The accessible name: the key the row shows. */
  name: string
  value: unknown
  options: readonly string[]
  /** Offer the empty choice. False for a key that is never empty. */
  clearable?: boolean
  /** Undefined clears the key. */
  onChange: (next: string | undefined) => void
}): React.JSX.Element {
  const id = useFieldControlId()
  const [open, setOpen] = useState(false)
  const pressed = useRef(false)
  const chosen = typeof value === 'string' && options.includes(value) ? value : undefined
  return (
    // '' when empty, never the `—` item or undefined: either would leave the
    // field showing `—` (undefined hands Radix the value, which keeps its last).
    <Select
      open={open}
      onOpenChange={setOpen}
      value={chosen ?? ''}
      onValueChange={(v) => onChange(v === EMPTY ? undefined : v)}
    >
      <SelectTrigger
        id={id}
        variant="field"
        aria-label={name}
        data-fm-field={name}
        onPointerDown={() => (pressed.current = true)}
        onClick={() => {
          if (!pressed.current) setOpen(true)
          pressed.current = false
        }}
      >
        <SelectValue placeholder="" />
      </SelectTrigger>
      <SelectContent>
        {clearable && <SelectItem value={EMPTY}>{EMPTY}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
