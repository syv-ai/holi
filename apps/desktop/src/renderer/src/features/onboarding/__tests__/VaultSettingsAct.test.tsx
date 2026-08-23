import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { VAULT_SETTING_DESCRIPTORS } from '@holi/shared'
import { VaultSettingsAct } from '../VaultSettingsAct'

function setup(over: Record<string, unknown> = {}) {
  const onChange = vi.fn()
  const settings = Object.fromEntries(VAULT_SETTING_DESCRIPTORS.map((d) => [d.key, d.default]))
  render(<VaultSettingsAct settings={{ ...settings, ...over }} onChange={onChange} />)
  return { onChange }
}

test('renders one row per descriptor, in the list’s own order', () => {
  setup()
  // Asserted against the list, never a hardcoded 4: the whole point of the
  // descriptor list is that adding a setting is adding a row and nothing else.
  const rows = screen.getAllByRole('group')
  expect(rows).toHaveLength(VAULT_SETTING_DESCRIPTORS.length)
  expect(rows.map((r) => r.getAttribute('data-setting'))).toEqual(
    VAULT_SETTING_DESCRIPTORS.map((d) => d.key),
  )
})

test('every row says what it is and where to change it later', () => {
  setup()
  for (const d of VAULT_SETTING_DESCRIPTORS) {
    const row = screen.getByRole('group', { name: d.label })
    expect(within(row).getByText(d.explanation)).toBeInTheDocument()
    // A step that changes something and does not say where to change it later
    // is a dead end for anyone who wants to change their mind.
    expect(within(row).getByText(d.whereToChange)).toBeInTheDocument()
  }
})

test('a toggle reports its key and its new value', async () => {
  const { onChange } = setup()
  const row = screen.getByRole('group', { name: 'Keep a daily note' })
  await userEvent.click(within(row).getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith('dailyNotes', false)
})

test('a choice reports the option’s value, not its label', async () => {
  const { onChange } = setup()
  const row = screen.getByRole('group', { name: 'Open on' })
  await userEvent.click(within(row).getByRole('radio', { name: 'The board' }))
  expect(onChange).toHaveBeenCalledWith('landing', { kind: 'board' })
})

test('a choice shows which option is currently selected', () => {
  setup({ landing: { kind: 'agenda' } })
  const row = screen.getByRole('group', { name: 'Open on' })
  expect(within(row).getByRole('radio', { name: 'Your agenda' })).toBeChecked()
  expect(within(row).getByRole('radio', { name: 'Today’s note' })).not.toBeChecked()
})

test('appearance is a choice too, and reports a plain string', async () => {
  const { onChange } = setup()
  const row = screen.getByRole('group', { name: 'Appearance' })
  await userEvent.click(within(row).getByRole('radio', { name: 'Dark' }))
  expect(onChange).toHaveBeenCalledWith('colorScheme', 'dark')
})

test('the transforms are one row of several switches', async () => {
  const { onChange } = setup()
  const row = screen.getByRole('group', { name: 'Tidy up on every commit' })
  expect(within(row).getAllByRole('checkbox')).toHaveLength(3)

  await userEvent.click(within(row).getByRole('checkbox', { name: /File finished tasks away/ }))
  // The whole block comes back, not just the switch that moved — a patch naming
  // one transform must not read as an answer about the other two.
  expect(onChange).toHaveBeenCalledWith('hooks', {
    relink: true,
    'archive-done': true,
    'normalize-md': true,
  })
})

test('a transform switch shows the vault’s current answer', () => {
  setup({ hooks: { relink: false, 'archive-done': true, 'normalize-md': true } })
  const row = screen.getByRole('group', { name: 'Tidy up on every commit' })
  expect(
    within(row).getByRole('checkbox', { name: /Fix links when a file moves/ }),
  ).not.toBeChecked()
  expect(within(row).getByRole('checkbox', { name: /File finished tasks away/ })).toBeChecked()
})

test('warns about the shared-vault collision on the daily-note row', () => {
  // This sentence is the reason the row exists: Holi used to guess the answer
  // from the GitHub collaborator count instead of saying this out loud.
  setup()
  const row = screen.getByRole('group', { name: 'Keep a daily note' })
  expect(within(row).getByText(/everyone writes the same file/i)).toBeInTheDocument()
})

test('falls back to the descriptor default when an answer is missing', () => {
  // A vault whose settings file predates a row still renders it.
  setup({ landing: undefined })
  const row = screen.getByRole('group', { name: 'Open on' })
  expect(within(row).getByRole('radio', { name: 'Today’s note' })).toBeChecked()
})
