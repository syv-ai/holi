/**
 * The block's last row: any key, free text.
 */
import { type FieldSpec, addableKey } from '@holi/shared'
import { Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { IconButton, Input } from '@/primitives'
import { cn } from '@/lib/cn'

/**
 * The last row: any key, free text. Open, it is two inputs in the same columns
 * as the rows above. Enter moves key to value, then writes; Escape or leaving
 * empty closes. A value is required: a bare key is a `null` in the file.
 */
export function AddFieldRow({
  existing,
  schema,
  onAdd,
}: {
  existing: readonly string[]
  schema: readonly FieldSpec[]
  onAdd: (key: string, value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const valueInput = useRef<HTMLInputElement>(null)
  const valid = addableKey(key, existing, schema)
  const bad = key.trim() !== '' && valid === null

  const close = (): void => {
    setOpen(false)
    setKey('')
    setValue('')
  }
  const submit = (): void => {
    if (valid === null || value.trim() === '') return
    onAdd(valid, value.trim())
    close()
  }

  if (!open) {
    return (
      <IconButton
        icon={Plus}
        label="add field"
        className="self-start"
        onClick={() => setOpen(true)}
      />
    )
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-1 py-0.5"
      data-fm-add-field=""
      onBlur={(e) => {
        // Leaving the row, not moving between its two inputs.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        if (valid !== null && value.trim() !== '') submit()
        else close()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        close()
      }}
    >
      <Input
        variant="bare"
        autoFocus
        value={key}
        aria-label="new field name"
        aria-invalid={bad}
        placeholder="name"
        className={cn('min-w-0 shrink-0 basis-24 text-xs md:text-xs', bad && 'text-destructive')}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (valid !== null) valueInput.current?.focus()
        }}
      />
      <Input
        ref={valueInput}
        variant="bare"
        value={value}
        aria-label="new field value"
        placeholder="value"
        className="min-w-32 flex-1 px-3 text-right text-xs md:text-xs"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          submit()
        }}
      />
    </div>
  )
}
