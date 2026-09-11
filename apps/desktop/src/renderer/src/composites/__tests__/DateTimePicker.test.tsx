import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { DateTimePicker } from '../DateTimePicker'

/** Open the popover and hand back the user-event instance. */
async function open(name = 'reminder') {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: new RegExp(name, 'i') }))
  return user
}

const PRESETS = [
  { label: '1 day before', value: '2026-08-24T09:00' },
  { label: 'on the day', value: '2026-08-25T09:00' },
]

test('a preset writes its own value, verbatim', async () => {
  const onChange = vi.fn()
  render(
    <DateTimePicker value={null} onChange={onChange} presets={PRESETS} placeholder="reminder" />,
  )
  const user = await open()
  await user.click(screen.getByRole('button', { name: '1 day before' }))
  // The component resolves nothing — a preset is a label and a finished stamp.
  expect(onChange).toHaveBeenCalledWith('2026-08-24T09:00')
})

test('a preset closes the popover, a day does not', async () => {
  // A preset is a complete answer. Picking a day is not — the time row is right
  // there, and closing would make adding an hour a second trip.
  const { rerender } = render(
    <DateTimePicker value={null} onChange={() => {}} presets={PRESETS} placeholder="reminder" />,
  )
  const user = await open()
  await user.click(screen.getByRole('button', { name: '1 day before' }))
  expect(screen.queryByRole('button', { name: 'next month' })).not.toBeInTheDocument()

  rerender(<DateTimePicker value="2026-08-25" onChange={() => {}} placeholder="due" />)
  await user.click(screen.getByRole('button', { name: /due/i }))
  await user.click(screen.getByRole('button', { name: 'Wednesday, 26 August 2026' }))
  expect(screen.getByRole('button', { name: 'next month' })).toBeInTheDocument()
})

test('picking a day keeps the time the value already had', async () => {
  const onChange = vi.fn()
  render(<DateTimePicker value="2026-08-25T14:00" onChange={onChange} placeholder="due" />)
  const user = await open('due')
  await user.click(screen.getByRole('button', { name: 'Wednesday, 26 August 2026' }))
  expect(onChange).toHaveBeenCalledWith('2026-08-26T14:00')
})

test('picking a day on a timeless value leaves it timeless', async () => {
  const onChange = vi.fn()
  render(<DateTimePicker value="2026-08-25" onChange={onChange} placeholder="due" />)
  const user = await open('due')
  await user.click(screen.getByRole('button', { name: 'Wednesday, 26 August 2026' }))
  expect(onChange).toHaveBeenCalledWith('2026-08-26')
})

test('picking a day from empty produces a day, not a midnight', async () => {
  const onChange = vi.fn()
  render(<DateTimePicker value={null} onChange={onChange} placeholder="due" />)
  const user = await open('due')
  await user.click(screen.getByRole('button', { name: /26 August 2026|26 \w+ 2026/ }))
  const written = onChange.mock.calls[0]![0] as string
  expect(written).not.toContain('T')
})

test('adding a time turns a day into a moment, at the anchor hour', async () => {
  const onChange = vi.fn()
  render(<DateTimePicker value="2026-08-25" onChange={onChange} placeholder="due" />)
  const user = await open('due')
  await user.click(screen.getByRole('button', { name: /add a time/i }))
  expect(onChange).toHaveBeenCalledWith('2026-08-25T09:00')
})

test('clearing the time turns a moment back into a day', async () => {
  const onChange = vi.fn()
  render(<DateTimePicker value="2026-08-25T14:00" onChange={onChange} placeholder="due" />)
  const user = await open('due')
  await user.click(screen.getByRole('button', { name: /remove the time/i }))
  expect(onChange).toHaveBeenCalledWith('2026-08-25')
})

test('clearing the value reports null', async () => {
  const onChange = vi.fn()
  render(<DateTimePicker value="2026-08-25T14:00" onChange={onChange} placeholder="due" />)
  const user = await open('due')
  await user.click(screen.getByRole('button', { name: /^clear$/i }))
  expect(onChange).toHaveBeenCalledWith(null)
})

test('the trigger shows a time only when the value carries one', () => {
  const { rerender } = render(
    <DateTimePicker value="2026-08-25T14:00" onChange={() => {}} placeholder="due" />,
  )
  expect(screen.getByRole('button')).toHaveTextContent('14:00')
  rerender(<DateTimePicker value="2026-08-25" onChange={() => {}} placeholder="due" />)
  expect(screen.getByRole('button')).not.toHaveTextContent('14:00')
  expect(screen.getByRole('button')).toHaveTextContent(/25 Aug/)
})

test('an empty value shows the placeholder', () => {
  render(<DateTimePicker value={null} onChange={() => {}} placeholder="no reminder" />)
  expect(screen.getByRole('button')).toHaveTextContent('no reminder')
})

test('dateOnly renders no time row at all', async () => {
  render(<DateTimePicker value="2026-08-25" onChange={() => {}} dateOnly placeholder="until" />)
  await open('until')
  expect(screen.queryByRole('button', { name: /add a time/i })).not.toBeInTheDocument()
})

test('a value that is not a stamp renders verbatim rather than as Invalid Date', async () => {
  // A legacy `1d` survives in a hand-written file. The field must show what is
  // actually there — not a crash, and not a date it made up.
  render(<DateTimePicker value="1d" onChange={() => {}} placeholder="reminder" />)
  expect(screen.getByRole('button')).toHaveTextContent('1d')
  expect(screen.getByRole('button')).not.toHaveTextContent(/invalid/i)
})

test('paging from December lands in January of the next year', async () => {
  render(<DateTimePicker value="2026-12-15" onChange={() => {}} placeholder="due" />)
  const user = await open('due')
  expect(screen.getByText('December 2026')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /next month/i }))
  expect(screen.getByText('January 2027')).toBeInTheDocument()
})

test('opening again after the value changed shows the new value, not the old', async () => {
  // The detail panel is not remounted when you select another task, so a picker
  // that seeded its month once at mount would open on the PREVIOUS task's due
  // date — and would only look right while the two happened to share a month.
  const { rerender } = render(
    <DateTimePicker value="2026-03-10" onChange={() => {}} placeholder="due" />,
  )
  const user = await open('due')
  expect(screen.getByText('March 2026')).toBeInTheDocument()
  await user.keyboard('{Escape}')

  rerender(<DateTimePicker value="2026-11-04" onChange={() => {}} placeholder="due" />)
  await user.click(screen.getByRole('button', { name: /due/i }))
  expect(screen.getByText('November 2026')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Wednesday, 4 November 2026' })).toBeInTheDocument()
})

test('paging survives a re-render that does not change the value', async () => {
  // The other half of the rule: within one open popover the month is the user's
  // to move. Following the value on every render would snap the grid back to the
  // selection whenever anything above it re-rendered.
  const { rerender } = render(
    <DateTimePicker value="2026-08-25" onChange={() => {}} placeholder="due" />,
  )
  const user = await open('due')
  await user.click(screen.getByRole('button', { name: 'next month' }))
  expect(screen.getByText('September 2026')).toBeInTheDocument()

  rerender(
    <DateTimePicker value="2026-08-25" onChange={() => {}} presets={PRESETS} placeholder="due" />,
  )
  expect(screen.getByText('September 2026')).toBeInTheDocument()
})

test('arrow keys walk the grid, and the walk can leave the month', async () => {
  // Thirty tab stops to cross a month is not navigation. The grid is one tab
  // stop with a roving focus inside it, the way a date grid is supposed to
  // behave — and stepping past the last row pages the view rather than stopping.
  render(<DateTimePicker value="2026-08-27" onChange={() => {}} placeholder="due" />)
  const user = await open('due')

  const start = screen.getByRole('button', { name: 'Thursday, 27 August 2026' })
  start.focus()
  await user.keyboard('{ArrowDown}')

  expect(screen.getByRole('button', { name: 'Thursday, 3 September 2026' })).toHaveFocus()
})

test('the whole grid is one tab stop, and paging away never removes it', async () => {
  // A roving tabindex is the other half of arrow navigation: without it the
  // grid is 42 tab stops between the presets and the time row. The fallback
  // matters as much as the rule — paging with the chevrons leaves the focused
  // date in another month, and a grid with no tabbable cell drops out of the
  // tab order entirely.
  render(<DateTimePicker value="2026-08-27" onChange={() => {}} placeholder="due" />)
  const user = await open('due')

  const stops = () =>
    screen.getAllByRole('button').filter((b) => b.dataset.date && b.tabIndex === 0)
  expect(stops()).toHaveLength(1)
  expect(stops()[0]).toHaveAttribute('data-date', '2026-08-27')

  await user.click(screen.getByRole('button', { name: 'next month' }))
  expect(stops()).toHaveLength(1)
})
