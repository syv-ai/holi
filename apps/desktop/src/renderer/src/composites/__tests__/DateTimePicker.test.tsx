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
