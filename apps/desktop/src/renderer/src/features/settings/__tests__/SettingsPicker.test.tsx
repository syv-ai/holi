/**
 * The rail, for a pane too narrow to hold one.
 *
 * A pane's `minSize` is 240px, so this is not a hypothetical width. The thing
 * worth pinning is that the narrow form is the same navigation and not a
 * reduced one: it still reaches a heading, because a narrow pane makes a section
 * taller rather than shorter, so jumping into the middle of one matters more
 * here than at full width.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SettingsPicker } from '../SettingsRail'
import type { SettingsSection } from '../sections'

const noop = () => <span />

const SECTIONS: SettingsSection[] = [
  { id: 'general', label: 'General', headings: [], files: [], Component: noop },
  {
    id: 'appearance',
    label: 'Appearance',
    headings: [
      { id: 'light-and-dark', title: 'Light and dark' },
      { id: 'surfaces', title: 'Surfaces' },
    ],
    files: [],
    Component: noop,
  },
]

// Radix marks the page inert while its listbox is open, and jsdom resolves the
// `pointer-events: none` it puts on body but not the `auto` on the content —
// the same limitation `AccountSection.test.tsx` documents.
const user = userEvent.setup({ pointerEventsCheck: 0 })

function setup(activeId: string) {
  const onSelect = vi.fn()
  const onJump = vi.fn()
  render(
    <SettingsPicker
      sections={SECTIONS}
      activeId={activeId}
      onSelect={onSelect}
      onJump={onJump}
    />,
  )
  return { onSelect, onJump }
}

test('reads as the section you are in', () => {
  setup('appearance')
  expect(screen.getByRole('combobox', { name: 'Settings section' })).toHaveTextContent('Appearance')
})

test('choosing a section selects it', async () => {
  const { onSelect, onJump } = setup('general')
  await user.click(screen.getByRole('combobox', { name: 'Settings section' }))
  await user.click(await screen.findByRole('option', { name: 'Appearance' }))

  expect(onSelect).toHaveBeenCalledWith('appearance')
  expect(onJump).not.toHaveBeenCalled()
})

test('choosing a heading scrolls rather than selecting', async () => {
  // The distinction the prefixed values exist for: a heading is a place inside
  // the section already on screen, not a different section.
  const { onSelect, onJump } = setup('appearance')
  await user.click(screen.getByRole('combobox', { name: 'Settings section' }))
  await user.click(await screen.findByRole('option', { name: 'Surfaces' }))

  expect(onJump).toHaveBeenCalledWith('surfaces')
  expect(onSelect).not.toHaveBeenCalled()
})

test('offers headings only for the section you are in', async () => {
  setup('general')
  await user.click(screen.getByRole('combobox', { name: 'Settings section' }))
  expect(await screen.findByRole('option', { name: 'General' })).toBeInTheDocument()
  // Appearance is listed, its contents are not — selection is expansion here
  // exactly as it is in the rail.
  expect(screen.getByRole('option', { name: 'Appearance' })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: 'Surfaces' })).not.toBeInTheDocument()
})
