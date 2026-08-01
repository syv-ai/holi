import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { PanelHeader } from '../PanelHeader'

test('renders the leading region and action controls', () => {
  render(
    <PanelHeader actions={[{ icon: <i>↻</i>, label: 'Restart', onSelect: () => {} }]}>
      <span>Claude</span>
    </PanelHeader>,
  )
  expect(screen.getByText('Claude')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
})

test('an action reports clicks through onSelect', async () => {
  const onSelect = vi.fn()
  render(
    <PanelHeader actions={[{ icon: <i>↻</i>, label: 'Restart', onSelect }]}>x</PanelHeader>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
  expect(onSelect).toHaveBeenCalledOnce()
})

test('a hidden action is not rendered', () => {
  render(
    <PanelHeader actions={[{ icon: <i>↻</i>, label: 'Restart', hidden: true, onSelect: () => {} }]}>
      x
    </PanelHeader>,
  )
  expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
})

test('a hotkey is shown in the tooltip and bound while mounted', async () => {
  const onSelect = vi.fn()
  render(
    <PanelHeader close={{ icon: <i>×</i>, label: 'Hide', hotkey: '⌘J', onSelect }}>x</PanelHeader>,
  )
  // Shown.
  expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('title', 'Hide (⌘J)')
  // Bound.
  fireEvent.keyDown(window, { key: 'j', metaKey: true })
  expect(onSelect).toHaveBeenCalledOnce()
})

test('the bound hotkey ignores a non-matching chord', () => {
  const onSelect = vi.fn()
  render(
    <PanelHeader close={{ icon: <i>×</i>, label: 'Hide', hotkey: '⌘J', onSelect }}>x</PanelHeader>,
  )
  fireEvent.keyDown(window, { key: 'j' }) // no modifier
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  expect(onSelect).not.toHaveBeenCalled()
})
