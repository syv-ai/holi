import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Inbox, RotateCw } from 'lucide-react'
import { EmptyState, LoadingRows } from '../EmptyState'
import { PaneToolbar } from '../PaneToolbar'

test('an empty state says why and offers its one action', async () => {
  const onClick = vi.fn()
  render(
    <EmptyState
      icon={Inbox}
      title="Nothing unread."
      description="Gmail’s tabs only apply if your inbox uses them."
      action={{ label: 'Show all mail', onClick }}
    />,
  )
  expect(screen.getByText('Nothing unread.')).toBeInTheDocument()
  expect(screen.getByText(/tabs only apply/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Show all mail' }))
  expect(onClick).toHaveBeenCalledOnce()
})

test('an error is announced and carries Retry', () => {
  render(
    <EmptyState
      role="alert"
      title="Couldn’t load your mail"
      description="Google is rate limiting."
      action={{ label: 'Try again', icon: RotateCw, onClick: () => {} }}
    />,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load your mail')
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
})

test('with no action there is no button', () => {
  render(<EmptyState title="Pick a thread to read it." />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('loading rows are one labelled status', () => {
  render(<LoadingRows label="Loading mail" rows={3} />)
  expect(screen.getByRole('status', { name: 'Loading mail' })).toBeInTheDocument()
})

test('a pane toolbar passes its props through', () => {
  render(
    <PaneToolbar role="toolbar" aria-label="Mail">
      <span>x</span>
    </PaneToolbar>,
  )
  expect(screen.getByRole('toolbar', { name: 'Mail' })).toHaveClass('h-11', 'px-4', 'gap-1')
})
