/**
 * A value the schema does not type, edited as the text it is. Numbers are
 * written back as numbers so a `1` does not become `'1'`; an emptied field
 * clears the key.
 */
import { useState } from 'react'
import { Input } from '@/primitives'
import { useFieldControlId } from '../FieldRow'

export function TextField({
  name,
  value,
  onChange,
}: {
  name: string
  value: unknown
  onChange: (next: unknown) => void
}): React.JSX.Element {
  const id = useFieldControlId()
  const shown = value === undefined || value === null ? '' : String(value)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (text: string): void => {
    setDraft(null)
    if (text === shown) return
    if (text.trim() === '') return onChange(undefined)
    if (typeof value === 'number' && Number.isFinite(Number(text))) return onChange(Number(text))
    onChange(text)
  }
  return (
    <Input
      id={id}
      variant="field"
      value={draft ?? shown}
      aria-label={name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.currentTarget.blur()
      }}
    />
  )
}
