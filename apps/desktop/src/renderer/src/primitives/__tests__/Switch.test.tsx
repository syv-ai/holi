import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Label } from '../Label'
import { Switch } from '../Switch'

test('a click toggles it, and it reports the new state', async () => {
  const onCheckedChange = vi.fn()
  render(<Switch aria-label="Daily note" onCheckedChange={onCheckedChange} />)
  const sw = screen.getByRole('switch', { name: 'Daily note' })
  expect(sw).toHaveAttribute('aria-checked', 'false')
  await userEvent.click(sw)
  expect(sw).toHaveAttribute('aria-checked', 'true')
  expect(onCheckedChange).toHaveBeenLastCalledWith(true)
})

test('a press on the label around it toggles it once', async () => {
  // A settings row is a label: its click reaches the switch as a click only,
  // with no pointer events on the switch itself.
  const onCheckedChange = vi.fn()
  render(
    <Label>
      <span>Fix links</span>
      <Switch aria-label="Fix links" checked={false} onCheckedChange={onCheckedChange} />
    </Label>,
  )
  await userEvent.click(screen.getByText('Fix links'))
  expect(onCheckedChange).toHaveBeenCalledTimes(1)
  expect(onCheckedChange).toHaveBeenCalledWith(true)
})

test('Space toggles it from the keyboard', async () => {
  const onCheckedChange = vi.fn()
  render(<Switch aria-label="Sync" checked onCheckedChange={onCheckedChange} />)
  screen.getByRole('switch').focus()
  await userEvent.keyboard(' ')
  expect(onCheckedChange).toHaveBeenCalledWith(false)
})

test('a disabled switch does not move', async () => {
  const onCheckedChange = vi.fn()
  render(<Switch aria-label="PDF" disabled onCheckedChange={onCheckedChange} />)
  await userEvent.click(screen.getByRole('switch'))
  expect(onCheckedChange).not.toHaveBeenCalled()
})
