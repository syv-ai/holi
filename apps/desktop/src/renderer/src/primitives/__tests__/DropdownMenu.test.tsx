import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
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

test('the trigger accepts a ref, so a Radix wrapper can anchor to it', () => {
  // VaultPicker wraps this trigger in a Tooltip with `asChild`, which means
  // Radix hands the trigger a ref and positions the tooltip against the node it
  // resolves to. The trigger is a plain function component (shadcn's React 19
  // style, where `ref` is an ordinary prop) — under React 18 the ref was
  // refused, silently dropped, and the tooltip had nothing to anchor to.
  //
  // Asserted on the ref rather than on React's console warning: that warning is
  // deduped per component type, so a test reading it passes or fails depending
  // on what rendered earlier in the file. This is the actual contract.
  const ref = createRef<HTMLButtonElement>()

  render(
    <DropdownMenu>
      <DropdownMenuTrigger ref={ref}>open</DropdownMenuTrigger>
    </DropdownMenu>,
  )

  expect(ref.current).toBeInstanceOf(HTMLElement)
})
