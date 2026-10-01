/**
 * A recipient field: committed addresses as chips, plus somewhere to type.
 *
 * A primitive because it needs a native `<input>`, which the lint gate allows
 * only in `primitives/`, not because it is generic.
 *
 * A typo is refused where it was made: an unmailable address never becomes a
 * chip, so the send path checks recipients for presence, never shape.
 */
import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IconButton } from './IconButton'

/** One address: a name, `''` when there is none, and the address itself. */
export interface ChipAddress {
  name: string
  email: string
}

export interface ChipInputProps {
  value: ChipAddress[]
  onChange: (next: ChipAddress[]) => void
  /** Already ranked by the caller: filtered here, never re-sorted. */
  suggestions?: ChipAddress[]
  placeholder?: string
  label: string
}

/**
 * Deliberately loose: a typo check (`ada@`, `ada syv.ai`), not RFC 5322. The
 * mail server is the authority, and stricter would refuse legal addresses.
 */
const PLAUSIBLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `Ada Holm <ada@syv.ai>` or a bare address. `null` when neither. */
function parseOne(text: string): ChipAddress | null {
  const trimmed = text.trim().replace(/,$/, '')
  if (trimmed === '') return null

  const angled = /^(.*)<([^>]+)>$/.exec(trimmed)
  if (angled !== null) {
    const email = angled[2]!.trim()
    if (!PLAUSIBLE.test(email)) return null
    const name = angled[1]!.trim().replace(/^"|"$/g, '')
    return { name: name === '' ? email : name, email: email.toLowerCase() }
  }

  if (!PLAUSIBLE.test(trimmed)) return null
  // No display name, so the address is the name.
  return { name: trimmed, email: trimmed.toLowerCase() }
}

function has(value: ChipAddress[], email: string): boolean {
  return value.some((address) => address.email === email.toLowerCase())
}

export function ChipInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  label,
}: ChipInputProps): React.JSX.Element {
  const [text, setText] = React.useState('')
  const [invalid, setInvalid] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const inputId = React.useId()

  const query = text.trim().toLowerCase()
  const matches =
    query === ''
      ? []
      : suggestions.filter(
          (person) =>
            !has(value, person.email) &&
            (person.email.includes(query) || person.name.toLowerCase().includes(query)),
        )

  const add = (address: ChipAddress): void => {
    if (!has(value, address.email)) onChange([...value, address])
    setText('')
    setInvalid(false)
    setActive(0)
  }

  /** Returns whether anything was committed, so callers can decide whether to
   *  swallow the key that asked for it. */
  const commit = (raw: string): boolean => {
    if (raw.trim() === '') {
      setInvalid(false)
      return false
    }
    const parsed = parseOne(raw)
    if (parsed === null) {
      // Left in the field so the user can fix it.
      setInvalid(true)
      return false
    }
    add(parsed)
    return true
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, matches.length - 1))
      return
    }
    if (event.key === 'ArrowUp' && matches.length > 0) {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault()
      const chosen = matches[active]
      if (chosen !== undefined) add(chosen)
      else commit(text)
      return
    }
    if (event.key === 'Tab') {
      // Not prevented: Tab still moves on, after committing.
      commit(text)
      return
    }
    if (event.key === 'Backspace' && text === '' && value.length > 0) {
      event.preventDefault()
      onChange(value.slice(0, -1))
    }
  }

  const onPaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData('text')
    if (!/[,;]/.test(pasted)) return
    event.preventDefault()

    const parts = pasted.split(/[,;]/)
    const added: ChipAddress[] = []
    const leftover: string[] = []
    for (const part of parts) {
      if (part.trim() === '') continue
      const parsed = parseOne(part)
      // An unparseable fragment stays as text rather than being lost.
      if (parsed === null) leftover.push(part.trim())
      else if (!has(value, parsed.email) && !has(added, parsed.email)) added.push(parsed)
    }

    if (added.length > 0) onChange([...value, ...added])
    setText(leftover.join(', '))
    setInvalid(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((address) => (
        <span
          key={address.email}
          data-testid="chip"
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
        >
          <span data-testid="chip-name">{address.name}</span>
          {/* The address for screen readers. Not `title=` (banned), nor the
              Tooltip primitive, which would force every consumer to supply a
              TooltipProvider. */}
          {address.name !== address.email && <span className="sr-only">{address.email}</span>}
          {/* No tooltip, for the same reason; boxed to the chip's line
              height so it never makes the chip taller than its name. */}
          <IconButton
            icon={X}
            label={`Remove ${address.name}`}
            tooltip={false}
            shape="round"
            className="size-4"
            onClick={() => onChange(value.filter((a) => a.email !== address.email))}
          />
        </span>
      ))}

      <div className="relative min-w-40 flex-1">
        <input
          id={inputId}
          aria-label={label}
          aria-invalid={invalid}
          // Not an ARIA combobox: without `aria-activedescendant` wiring the
          // role would describe navigation that does not exist.
          placeholder={placeholder}
          value={text}
          className={cn(
            'w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground',
            invalid && 'text-destructive',
          )}
          onChange={(event) => {
            setText(event.target.value)
            setInvalid(false)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(text)}
        />

        {matches.length > 0 && (
          <ul
            role="listbox"
            aria-label={`${label} suggestions`}
            className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-popover shadow-md"
          >
            {matches.map((person, index) => (
              <li key={person.email}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    'flex w-full flex-col items-start px-2 py-1 text-left text-sm',
                    index === active && 'bg-accent',
                  )}
                  // `onMouseDown`: with `onClick` the input's blur commits and
                  // closes the list before the click lands.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    add(person)
                  }}
                >
                  <span>{person.name}</span>
                  <span className="text-xs text-muted-foreground">{person.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
