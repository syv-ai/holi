import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../DropdownMenu'

function Menu({ onPick }: { onPick?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onPick}>pick me</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

test('keeps the content hidden until the trigger is clicked', () => {
  render(<Menu />)
  expect(screen.queryByText('pick me')).not.toBeInTheDocument()
})

test('reveals its items when the trigger is clicked', async () => {
  render(<Menu />)
  await userEvent.click(screen.getByText('open'))
  expect(await screen.findByRole('menuitem', { name: 'pick me' })).toBeVisible()
})

test('reports selection through the item onSelect', async () => {
  const onPick = vi.fn()
  render(<Menu onPick={onPick} />)
  await userEvent.click(screen.getByText('open'))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'pick me' }))
  expect(onPick).toHaveBeenCalledOnce()
})
