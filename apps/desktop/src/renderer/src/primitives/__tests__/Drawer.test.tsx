import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Drawer } from '../Drawer'

test('renders content only when open', () => {
  const { rerender } = render(
    <Drawer open={false} onClose={() => {}}>
      <Drawer.Title>Settings</Drawer.Title>
    </Drawer>,
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  rerender(
    <Drawer open onClose={() => {}}>
      <Drawer.Title>Settings</Drawer.Title>
    </Drawer>,
  )
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('Escape asks to close', async () => {
  const onClose = vi.fn()
  render(
    <Drawer open onClose={onClose}>
      <Drawer.Title>Settings</Drawer.Title>
    </Drawer>,
  )
  await userEvent.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledOnce()
})

test('side="right" content carries the right-edge class; renders through a portal', () => {
  const { container } = render(
    <Drawer open side="right" onClose={() => {}}>
      <Drawer.Title>Settings</Drawer.Title>
      <Drawer.Body>body-text</Drawer.Body>
    </Drawer>,
  )
  const panel = screen.getByRole('dialog')
  expect(panel).toHaveClass('right-0')
  expect(panel).toHaveClass('border-l')
  // Portaled to the body, not the mount node.
  expect(container).not.toHaveTextContent('body-text')
  expect(panel).toHaveTextContent('body-text')
})
