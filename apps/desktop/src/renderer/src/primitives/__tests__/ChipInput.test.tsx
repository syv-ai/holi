/**
 * The recipient field (D71).
 *
 * A primitive because an AST selector in `eslint.config.mjs` bans a native
 * `<input>` anywhere outside `primitives/` — not because a recipient field is a
 * general-purpose control.
 *
 * Almost everything here is behaviour people expect without being able to name,
 * and notice immediately when it is missing: commas commit, backspace deletes
 * backwards, a paste of six addresses becomes six chips. The one rule with real
 * consequences is that a typo is refused **where it was made**, which is why
 * sending never has to validate an address.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ChipInput } from '../ChipInput'
import type { MailAddress } from '@/lib/mail-types'

/** Controlled, the way the composer uses it. */
function Harness({
  initial = [],
  suggestions,
  onChange,
}: {
  initial?: MailAddress[]
  suggestions?: MailAddress[]
  onChange?: (next: MailAddress[]) => void
}) {
  const [value, setValue] = useState<MailAddress[]>(initial)
  return (
    <ChipInput
      label="To"
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      suggestions={suggestions ?? []}
    />
  )
}

const field = (): HTMLElement => screen.getByRole('textbox', { name: /to/i })

/** The chip labels alone — `chip` itself also contains the remove button. */
function chips(): string[] {
  return screen.queryAllByTestId('chip-name').map((el) => el.textContent ?? '')
}

describe('committing an address', () => {
  it('commits on Enter', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'ada@syv.ai{Enter}')

    expect(chips()).toEqual(['ada@syv.ai'])
    expect(field()).toHaveValue('')
  })

  it('commits on a comma, which is how people actually type a list', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'ada@syv.ai,bo@syv.ai,')

    expect(chips()).toEqual(['ada@syv.ai', 'bo@syv.ai'])
  })

  it('commits on Tab rather than leaving the field with the address unentered', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'ada@syv.ai')
    await user.tab()

    expect(chips()).toEqual(['ada@syv.ai'])
  })

  it('commits on blur, so a typed address is never silently dropped', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'ada@syv.ai')
    await user.click(document.body)

    expect(chips()).toEqual(['ada@syv.ai'])
  })

  it('accepts a display-name form and keeps the name', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'Ada Holm <ada@syv.ai>{Enter}')

    expect(chips()).toEqual(['Ada Holm'])
  })

  it('does not add the same address twice', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'ada@syv.ai{Enter}Ada@SYV.ai{Enter}')

    expect(chips()).toHaveLength(1)
  })
})

describe('refusing a typo where it was made', () => {
  it('keeps the text in the field instead of making an unmailable chip', async () => {
    // The whole reason Send never validates addresses: a bad one cannot get
    // past this field, so there is nothing left to check later.
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'ada@{Enter}')

    expect(chips()).toEqual([])
    expect(field()).toHaveValue('ada@')
  })

  it('says so, rather than just refusing silently', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), 'not an address{Enter}')

    expect(field()).toHaveAttribute('aria-invalid', 'true')
  })

  it('clears the complaint as soon as the text is edited', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(field(), 'ada@{Enter}')

    await user.type(field(), 'syv.ai')

    expect(field()).toHaveAttribute('aria-invalid', 'false')
  })

  it('does not commit an empty field on Enter', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(field(), '{Enter}')

    expect(chips()).toEqual([])
    expect(field()).toHaveAttribute('aria-invalid', 'false')
  })
})

describe('removing', () => {
  it('deletes the last chip on Backspace in an empty field', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Ada', email: 'ada@syv.ai' }]} />)

    await user.click(field())
    await user.keyboard('{Backspace}')

    expect(chips()).toEqual([])
  })

  it('does not delete a chip while there is text to delete', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Ada', email: 'ada@syv.ai' }]} />)

    await user.type(field(), 'x{Backspace}')

    expect(chips()).toEqual(['Ada'])
  })

  it('removes a chip through its own button', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Ada', email: 'ada@syv.ai' }]} />)

    await user.click(within(screen.getByTestId('chip')).getByRole('button'))

    expect(chips()).toEqual([])
  })
})

describe('pasting', () => {
  it('splits a pasted list on commas and semicolons', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(field())
    await user.paste('ada@syv.ai, bo@syv.ai; cec@syv.ai')

    expect(chips()).toEqual(['ada@syv.ai', 'bo@syv.ai', 'cec@syv.ai'])
  })

  it('leaves an unparseable remainder in the field to be fixed', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(field())
    await user.paste('ada@syv.ai, nonsense')

    expect(chips()).toEqual(['ada@syv.ai'])
    expect(field()).toHaveValue('nonsense')
  })
})

describe('suggestions', () => {
  const CONTACTS: MailAddress[] = [
    { name: 'Ada Holm', email: 'ada@syv.ai' },
    { name: 'Adam Berg', email: 'adam@example.com' },
    { name: 'Bo Berg', email: 'bo@example.com' },
  ]

  it('offers matches on the typed text, by name or address', async () => {
    const user = userEvent.setup()
    render(<Harness suggestions={CONTACTS} />)

    await user.type(field(), 'ada')

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Ada Holm'),
      expect.stringContaining('Adam Berg'),
    ])
  })

  it('keeps the order it was given — contacts are already ranked', async () => {
    // `google.contacts` ranks real senders ahead of address-book entries. A
    // re-sort here would throw that away and put a stranger first.
    const user = userEvent.setup()
    render(<Harness suggestions={[...CONTACTS].reverse()} />)

    // `ad`, not `a` — `a` legitimately matches `bo@ex(a)mple.com` too, and the
    // point here is the ordering, not the filter.
    await user.type(field(), 'ad')

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Adam Berg'),
      expect.stringContaining('Ada Holm'),
    ])
  })

  it('commits the chosen suggestion, not the typed fragment', async () => {
    const user = userEvent.setup()
    render(<Harness suggestions={CONTACTS} />)
    await user.type(field(), 'ada')

    await user.click(screen.getAllByRole('option')[0]!)

    expect(chips()).toEqual(['Ada Holm'])
    expect(field()).toHaveValue('')
  })

  it('takes the highlighted suggestion on Enter', async () => {
    const user = userEvent.setup()
    render(<Harness suggestions={CONTACTS} />)
    await user.type(field(), 'ada')

    await user.keyboard('{ArrowDown}{Enter}')

    expect(chips()).toEqual(['Adam Berg'])
  })

  it('offers nobody who is already a recipient', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ name: 'Ada Holm', email: 'ada@syv.ai' }]} suggestions={CONTACTS} />)

    await user.type(field(), 'ada')

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Adam Berg'),
    ])
  })

  it('offers nothing on an empty field', async () => {
    const user = userEvent.setup()
    render(<Harness suggestions={CONTACTS} />)

    await user.click(field())

    expect(screen.queryAllByRole('option')).toEqual([])
  })
})

describe('the contract with its caller', () => {
  it('reports every change through onChange', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Harness onChange={onChange} />)

    await user.type(field(), 'ada@syv.ai{Enter}')

    expect(onChange).toHaveBeenCalledWith([{ name: 'ada@syv.ai', email: 'ada@syv.ai' }])
  })

  it('is labelled, so the composer has three distinguishable fields', () => {
    render(<Harness />)

    expect(screen.getByRole('textbox', { name: /to/i })).toBeInTheDocument()
  })
})
