import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Checkbox } from '../Checkbox'

test('renders an unchecked checkbox by default', () => {
  render(<Checkbox aria-label="hide done" />)
  expect(screen.getByRole('checkbox', { name: 'hide done' })).not.toBeChecked()
})

test('reflects the checked state', () => {
  render(<Checkbox aria-label="hide done" defaultChecked />)
  expect(screen.getByRole('checkbox', { name: 'hide done' })).toBeChecked()
})

test('reports toggles through onCheckedChange', async () => {
  const onCheckedChange = vi.fn()
  render(<Checkbox aria-label="hide done" onCheckedChange={onCheckedChange} />)
  await userEvent.click(screen.getByRole('checkbox'))
  expect(onCheckedChange).toHaveBeenCalledWith(true)
})
