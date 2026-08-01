import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { VaultPicker } from '../VaultPicker'

const VAULTS = [
  { remote: 'git@a', name: 'Alpha' },
  { remote: 'git@b', name: 'Beta' },
]

function setup(props: Partial<Parameters<typeof VaultPicker>[0]> = {}) {
  const onSelect = vi.fn()
  const onAddVault = vi.fn()
  render(
    <VaultPicker
      vaults={VAULTS}
      activeRemote="git@a"
      onSelect={onSelect}
      onAddVault={onAddVault}
      {...props}
    />,
  )
  return { onSelect, onAddVault }
}

test('shows the active vault name on the trigger', () => {
  setup()
  expect(screen.getByRole('button', { name: /Alpha/ })).toBeInTheDocument()
})

test('switching to a different vault reports its remote', async () => {
  const { onSelect } = setup()
  await userEvent.click(screen.getByRole('button', { name: /Alpha/ }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Beta' }))
  expect(onSelect).toHaveBeenCalledWith('git@b')
})

test('picking the already-active vault is a no-op', async () => {
  const { onSelect } = setup()
  await userEvent.click(screen.getByRole('button', { name: /Alpha/ }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Alpha' }))
  expect(onSelect).not.toHaveBeenCalled()
})

test('the add-vault row invokes onAddVault', async () => {
  const { onAddVault } = setup()
  await userEvent.click(screen.getByRole('button', { name: /Alpha/ }))
  await userEvent.click(await screen.findByText('Add vault…'))
  expect(onAddVault).toHaveBeenCalledOnce()
})

test('falls back to "no vaults" with an empty vault list', () => {
  setup({ vaults: [], activeRemote: null })
  expect(screen.getByRole('button', { name: /no vaults/ })).toBeInTheDocument()
})
