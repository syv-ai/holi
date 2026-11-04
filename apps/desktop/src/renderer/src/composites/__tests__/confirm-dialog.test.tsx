import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { useState } from 'react'
import { ConfirmDialog } from '../confirm-dialog'

function Harness({ onConfirm }: { onConfirm: () => void | Promise<unknown> }) {
  const [open, setOpen] = useState(true)
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Delete it?"
      description="Gone for good."
      confirmLabel="Delete"
      onConfirm={onConfirm}
    />
  )
}

test('a synchronous confirm calls back and closes', async () => {
  const onConfirm = vi.fn()
  render(<Harness onConfirm={onConfirm} />)
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(onConfirm).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.queryByText('Delete it?')).toBeNull())
})

test('an async confirm is pending, then closes on success', async () => {
  let resolve!: () => void
  const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)))
  render(<Harness onConfirm={onConfirm} />)
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(screen.getByRole('button', { name: /Delete/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(screen.getByText('Delete it?')).toBeInTheDocument()
  resolve()
  await waitFor(() => expect(screen.queryByText('Delete it?')).toBeNull())
})

test('an async failure keeps the dialog open and shows the error', async () => {
  const onConfirm = vi.fn(() => Promise.reject(new Error('Disk is locked')))
  render(<Harness onConfirm={onConfirm} />)
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Disk is locked')
  expect(screen.getByText('Delete it?')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
})
