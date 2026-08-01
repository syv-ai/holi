import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SidePanel } from '../SidePanel'

test('renders its title and body', () => {
  render(
    <SidePanel title="Settings">
      <p>body content</p>
    </SidePanel>,
  )
  expect(screen.getByText('Settings')).toBeInTheDocument()
  expect(screen.getByText('body content')).toBeInTheDocument()
})

test('shows the subtitle when provided', () => {
  render(
    <SidePanel title="History" subtitle="notes/today.md">
      x
    </SidePanel>,
  )
  expect(screen.getByText('notes/today.md')).toBeInTheDocument()
})

test('renders a close control that calls onClose', async () => {
  const onClose = vi.fn()
  render(
    <SidePanel title="Settings" onClose={onClose}>
      x
    </SidePanel>,
  )
  await userEvent.click(screen.getByRole('button', { name: /close/i }))
  expect(onClose).toHaveBeenCalledOnce()
})

test('no close control when onClose is absent', () => {
  render(
    <SidePanel title="History" subtitle="notes/today.md">
      x
    </SidePanel>,
  )
  expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument()
})

test('renders structured header actions when provided', () => {
  render(
    <SidePanel
      title="Claude"
      actions={[{ icon: <i>↻</i>, label: 'Restart', onSelect: () => {} }]}
    >
      x
    </SidePanel>,
  )
  expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
})
