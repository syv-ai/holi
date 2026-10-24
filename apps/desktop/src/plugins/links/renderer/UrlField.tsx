/**
 * A link file's `url` row: the whole address, wrapping over as many lines as
 * it takes, where a note's one-line text field would cut it off. Enter
 * commits, as in that field; the address never holds a line break.
 */
import { useState } from 'react'
import { type FieldControlProps } from '@/plugin-api'
import { useFieldControlId } from '@/composites'
import { Textarea } from '@/primitives'

export function UrlField({ field, values, write }: FieldControlProps): React.JSX.Element {
  const id = useFieldControlId()
  const raw = values[field.key]
  const shown = typeof raw === 'string' ? raw : ''
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (text: string): void => {
    setDraft(null)
    const next = text.replace(/\s+/g, '')
    if (next === shown || next === '') return
    write({ [field.key]: next })
  }
  return (
    <Textarea
      id={id}
      variant="bare"
      rows={1}
      spellCheck={false}
      aria-label={field.key}
      value={draft ?? shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.currentTarget.blur()
      }}
      className="min-h-8 w-full rounded-md px-2 py-1.5 text-xs break-all focus-visible:ring-1 focus-visible:ring-ring"
    />
  )
}
