import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../ContextMenu'

function Menu({ onDelete }: { onDelete?: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>a row</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

test('stays closed until the trigger is right-clicked', () => {
  render(<Menu />)
  expect(screen.queryByText('Delete')).not.toBeInTheDocument()
})

test('opens on contextmenu and shows its items', async () => {
  render(<Menu />)
  fireEvent.contextMenu(screen.getByText('a row'))
  expect(await screen.findByRole('menuitem', { name: /Delete/ })).toBeVisible()
})

test('reports selection through the item onSelect', async () => {
  const onDelete = vi.fn()
  render(<Menu onDelete={onDelete} />)
  fireEvent.contextMenu(screen.getByText('a row'))
  await userEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }))
  expect(onDelete).toHaveBeenCalledOnce()
})
