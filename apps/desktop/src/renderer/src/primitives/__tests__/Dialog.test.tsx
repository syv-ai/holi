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

test('offers a corner close by default', () => {
  render(
    <Dialog open onClose={() => {}}>
      <Dialog.Header>Closable</Dialog.Header>
    </Dialog>,
  )
  expect(screen.getByText('Close')).toBeTruthy()
})

// A Cancel button beside a corner ✕ is two controls for one intent, and the ✕
// is the one with no label — so a dialog whose footer already offers a way out
// opts the ✕ off. It stays the DEFAULT because a `full` workspace modal
// (VaultHistory) carries no footer, and there it is the only visible way out.
test('closable={false} removes it, for a dialog whose footer already has Cancel', () => {
  render(
    <Dialog open closable={false} onClose={() => {}}>
      <Dialog.Header>Not closable</Dialog.Header>
    </Dialog>,
  )
  expect(screen.queryByText('Close')).toBeNull()
})
