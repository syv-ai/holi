import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Dialog } from '../Dialog'

// A Header supplies the Radix accessible title; every real dialog has one.
const body = <Dialog.Header>Titled</Dialog.Header>

test('renders content only when open', () => {
  const { rerender } = render(
    <Dialog open={false} onClose={() => {}}>
      {body}
    </Dialog>,
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  rerender(
    <Dialog open onClose={() => {}}>
      {body}
    </Dialog>,
  )
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('Escape asks to close', async () => {
  const onClose = vi.fn()
  render(
    <Dialog open onClose={onClose}>
      {body}
    </Dialog>,
  )
  await userEvent.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledOnce()
})

test('size maps to the panel width class', () => {
  render(
    <Dialog open size="lg" onClose={() => {}}>
      {body}
    </Dialog>,
  )
  expect(screen.getByRole('dialog')).toHaveClass('max-w-2xl')
})

test('full size is a fixed-height workspace panel (wide, scrolls internally)', () => {
  render(
    <Dialog open size="full" onClose={() => {}}>
      {body}
    </Dialog>,
  )
  const panel = screen.getByRole('dialog')
  expect(panel).toHaveClass('max-w-6xl')
  // The panes scroll internally — the modal itself must not become a scroll box
  // (that is the form-dialog behaviour, wrong for a fixed-height workspace).
  expect(panel).toHaveClass('overflow-hidden')
  expect(panel).not.toHaveClass('overflow-y-auto')
})

test('renders through a portal (into document.body, not the mount node)', () => {
  const { container } = render(
    <Dialog open onClose={() => {}}>
      <Dialog.Header>Portaled</Dialog.Header>
    </Dialog>,
  )
  expect(container).not.toHaveTextContent('Portaled')
  expect(screen.getByRole('dialog')).toHaveTextContent('Portaled')
})
