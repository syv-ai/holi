/**
 * A list value as chips, on shadcn's combobox: chips flow from the start of
 * the row and the input takes whatever width the last line leaves.
 *
 * A tag is any short string, so the typed text is always offered as an item
 * of its own, first, so Enter makes it (Base UI's "creatable" pattern). The
 * vault's other tags follow as suggestions. A comma commits too, as does
 * leaving the field with text in it.
 */
import { Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
} from '@/primitives'
import { useFieldControlId } from '../FieldRow'

export function TagsField({
  name,
  value,
  suggestions,
  onChange,
}: {
  name: string
  value: string[]
  /** Tags in use elsewhere in the vault, offered as you type. */
  suggestions: readonly string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const id = useFieldControlId()
  const anchor = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const typed = query.trim()
  const offered = suggestions.filter((t) => !value.includes(t))
  const items =
    typed === '' || value.includes(typed) || offered.includes(typed) ? offered : [typed, ...offered]

  const add = (tags: string[]): void => {
    const fresh = [...new Set(tags.map((t) => t.trim()))].filter(
      (t) => t !== '' && !value.includes(t),
    )
    if (fresh.length > 0) onChange([...value, ...fresh])
  }

  return (
    <Combobox
      items={items}
      multiple
      autoHighlight
      value={value}
      onValueChange={(next: string[]) => {
        onChange(next)
        setQuery('')
      }}
      inputValue={query}
      onInputValueChange={(next: string) => {
        if (!next.includes(',')) return setQuery(next)
        const parts = next.split(',')
        add(parts.slice(0, -1))
        setQuery(parts.at(-1) ?? '')
      }}
    >
      <ComboboxChips ref={anchor} variant="field" className="justify-start">
        {value.map((tag) => (
          <ComboboxChip key={tag} removeLabel={`remove ${tag}`}>
            {tag}
          </ComboboxChip>
        ))}
        <ComboboxChipsInput
          id={id}
          aria-label={`add to ${name}`}
          onBlur={() => {
            add([query])
            setQuery('')
          }}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor} className="data-empty:hidden">
        <ComboboxList>
          {(tag: string) => (
            <ComboboxItem key={tag} value={tag}>
              {tag === typed && !offered.includes(tag) && <Plus />}
              {tag}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
