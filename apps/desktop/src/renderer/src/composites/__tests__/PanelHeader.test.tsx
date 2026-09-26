import { fireEvent, render, screen } from '@/test/render'
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
  // Shown — the custom Tooltip (never a native title), with the hotkey as a kbd.
  expect(screen.getByRole('button', { name: 'Hide' })).not.toHaveAttribute('title')
  await userEvent.tab()
  const tip = await screen.findByRole('tooltip')
  expect(tip).toHaveTextContent('Hide')
  expect(tip).toHaveTextContent('⌘J')
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

test('a hotkey the command table owns is shown, not bound twice', () => {
  // The nav's ⌥⌘S: bound here as well, one press would toggle it twice.
  const onSelect = vi.fn()
  render(
    <PanelHeader
      actions={[
        { icon: <i>«</i>, label: 'Hide sidebar', hotkey: '⌥⌘S', boundByCommand: true, onSelect },
      ]}
    >
      x
    </PanelHeader>,
  )
  fireEvent.keyDown(window, { key: 'ß', code: 'KeyS', metaKey: true, altKey: true })
  expect(onSelect).not.toHaveBeenCalled()
})
