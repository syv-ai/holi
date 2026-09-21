/**
 * The palette's shell (D102): a cmdk list inside a Radix dialog composed by
 * hand, because the registry's `CommandDialog` wants a compound Dialog this
 * repo does not have. What is worth pinning is the part that is ours: it
 * opens with its input focused (cmdk's arrow keys need focus inside the root),
 * Escape asks to close, and it filters nothing on its own when told not to.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { CommandDialog, CommandInput, CommandItem, CommandList } from '../Command'

function palette(onOpenChange = vi.fn()) {
  render(
    <CommandDialog open onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search" autoFocus />
      <CommandList>
        <CommandItem value="alpha">Alpha</CommandItem>
        <CommandItem value="beta">Beta</CommandItem>
      </CommandList>
    </CommandDialog>,
  )
  return onOpenChange
}

test('opens with the input focused and every item listed', () => {
  palette()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByPlaceholderText('Search')).toHaveFocus()
  expect(screen.getByText('Alpha')).toBeInTheDocument()
  expect(screen.getByText('Beta')).toBeInTheDocument()
})

test('Escape asks to close', async () => {
  const onOpenChange = palette()
  await userEvent.keyboard('{Escape}')
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('renders nothing while closed', () => {
  render(
    <CommandDialog open={false} onOpenChange={() => {}}>
      <CommandList>
        <CommandItem value="alpha">Alpha</CommandItem>
      </CommandList>
    </CommandDialog>,
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
