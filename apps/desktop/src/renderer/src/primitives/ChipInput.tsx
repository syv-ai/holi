/**
 * A recipient field: committed addresses as chips, plus somewhere to type.
 *
 * **A primitive because of the boundaries gate, not because it is generic.** An
 * AST selector in `eslint.config.mjs` bans native `button|input|select|
 * textarea|dialog|form` outside `primitives/`, and this needs a real `<input>`
 * to accept typing. Nothing else in the app wants a chip field.
 *
 * The rule worth stating: **a typo is refused where it was made.** An address
 * that cannot be mailed never becomes a chip, so by the time Send is pressed
 * there is nothing left to validate — which is why the composer's send path
 * checks recipients for presence and never for shape.
 */
import * as React from 'react'
import { cn } from '@/lib/cn'
import type { MailAddress } from '@/lib/mail-types'

export interface ChipInputProps {
  value: MailAddress[]
  onChange: (next: MailAddress[]) => void
  /**
   * Already ranked by `google.contacts`, which puts real senders ahead of
   * address-book entries. **Filtered here, never re-sorted** — re-sorting would
   * throw that ranking away and put a stranger at the top.
   */
  suggestions?: MailAddress[]
  placeholder?: string
  label: string
}

/**
 * Deliberately loose. This is a typo check, not an RFC 5322 parser: the
 * authority on whether an address exists is the mail server, and a stricter
 * pattern here would refuse legal addresses that Gmail accepts. It exists to
 * catch `ada@` and `ada syv.ai`, which are mistakes rather than exotica.
 */
const PLAUSIBLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `Ada Holm <ada@syv.ai>` or a bare address. `null` when neither. */
function parseOne(text: string): MailAddress | null {
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
  // No display name was offered, so the address is the name. `MailAddress`'s
  // contract is that `name` is what a list shows, falling back to the address.
  return { name: trimmed, email: trimmed.toLowerCase() }
}

function has(value: MailAddress[], email: string): boolean {
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

  const add = (address: MailAddress): void => {
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
      // Left in the field on purpose. Clearing it would delete something the
      // user typed, on the screen where they are least able to retype it.
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
      // NOT prevented: Tab still moves on. Committing first is what stops an
      // address being lost by leaving the field the way people leave fields.
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
    const added: MailAddress[] = []
    const leftover: string[] = []
    for (const part of parts) {
      if (part.trim() === '') continue
      const parsed = parseOne(part)
      // An unparseable fragment stays as text rather than being dropped — a
      // paste of six addresses where one is malformed must not lose it.
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
          {/* The address, for a screen reader and for the accessible name. Not
              a `title=` — the house rule bans the native tooltip — and not the
              Tooltip primitive either, which needs a TooltipProvider ancestor
              and would make every consumer of this primitive supply one. */}
          {address.name !== address.email && <span className="sr-only">{address.email}</span>}
          <button
            type="button"
            aria-label={`Remove ${address.name}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(value.filter((a) => a.email !== address.email))}
          >
            ×
          </button>
        </span>
      ))}

      <div className="relative min-w-40 flex-1">
        <input
          id={inputId}
          aria-label={label}
          aria-invalid={invalid}
          // The listbox is not an ARIA combobox: it has no `aria-activedescendant`
          // wiring, and claiming the role without it describes navigation that
          // does not exist to a screen reader.
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
                  // `onMouseDown` rather than `onClick`: the input's blur fires
                  // first otherwise, committing the typed fragment and closing
                  // the list before the click can land.
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
