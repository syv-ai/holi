/**
 * One of a fixed vocabulary, as a Select in the `field` look.
 *
 * Controlled `open`, for the row's label: a label clicks its control, and
 * Radix opens a Select on a mouse's `pointerdown`, never on its `click`. So a
 * click the trigger saw no press for came from the label, and opens it here.
 *
 * Only the vocabulary is offered. Empty is the unset field itself, cleared by
 * the row's ×, not a choice in the list that would read the same as it.
 */
import { useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/primitives'
import { useFieldControlId } from '@/composites'

export function EnumField({
  name,
  value,
  options,
  onChange,
}: {
  /** The accessible name: the key the row shows. */
  name: string
  value: unknown
  options: readonly string[]
  onChange: (next: string) => void
}): React.JSX.Element {
  const id = useFieldControlId()
  const [open, setOpen] = useState(false)
  const pressed = useRef(false)
  const chosen = typeof value === 'string' && options.includes(value) ? value : undefined
  return (
    // '' when unset, not undefined: undefined would hand Radix the value, so a
    // cleared field kept showing its last choice.
    <Select open={open} onOpenChange={setOpen} value={chosen ?? ''} onValueChange={onChange}>
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
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
