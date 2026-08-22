import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { DeleteConfirm } from '../DeleteConfirm'

test('names the target and reports confirm', async () => {
  const onConfirm = vi.fn()
  render(<DeleteConfirm label="notes/a.md" refs={[]} onCancel={() => {}} onConfirm={onConfirm} />)
  expect(screen.getByText('notes/a.md')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(onConfirm).toHaveBeenCalledOnce()
})

test('cancel button reports cancel', async () => {
  const onCancel = vi.fn()
  render(<DeleteConfirm label="a.md" refs={[]} onCancel={onCancel} onConfirm={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onCancel).toHaveBeenCalledOnce()
})

test('summarizes dangling links when refs are present', () => {
  render(
    <DeleteConfirm
      label="folder/"
      refs={[
        { path: 'x.md', count: 2 },
        { path: 'y.md', count: 1 },
      ]}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  )
  expect(screen.getByText(/3 links in 2 files will be left dangling/)).toBeInTheDocument()
})

test('says nothing links to it when there are no refs', () => {
  render(<DeleteConfirm label="a.md" refs={[]} onCancel={() => {}} onConfirm={() => {}} />)
  expect(screen.getByText('Nothing links to it.')).toBeInTheDocument()
})

test('says what it is about to do, so a move does not read as a delete', () => {
  // Moving a file out of the vault removes it from the vault, so it earns the
  // same backrefs warning as a delete — but calling it "Delete" would describe
  // the wrong outcome to someone who asked for a move.
  render(
    <DeleteConfirm
      verb="Move"
      label="note.md"
      refs={[]}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  )

  expect(screen.getByRole('button', { name: 'Move' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
})
