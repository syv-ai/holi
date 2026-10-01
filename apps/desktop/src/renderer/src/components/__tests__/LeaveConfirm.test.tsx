/**
 * The question leaving a vault asks while something running in it would be
 * lost. A test-only plugin stands in for what says so.
 *
 * What it owes the user is an accurate sentence about what they are about to
 * lose, and that both answers reach the caller: Shell holds the switch itself,
 * and a cancel that silently switched anyway would be worse than never asking.
 */
import { act, render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, atom, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { LeaveConfirm, type LeaveIntent } from '../LeaveConfirm'
import { installedPluginsAtom } from '@/state/plugins'

const reason = atom<string | null>('Fix the merge is part way through a turn.')

function setup(intent: LeaveIntent = 'switch') {
  const store = createStore()
  store.set(installedPluginsAtom, [
    { info: { id: 'busy', label: 'Busy', default: true }, leaveGuard: reason },
  ])
  store.set(reason, 'Fix the merge is part way through a turn.')
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <Provider store={store}>
      <LeaveConfirm intent={intent} onConfirm={onConfirm} onCancel={onCancel} />
    </Provider>,
  )
  return { store, onConfirm, onCancel }
}

test('says what a running plugin says leaving costs', async () => {
  setup()
  expect(await screen.findByText('Switch vaults?')).toBeInTheDocument()
  expect(await screen.findByText(/Fix the merge is part way through a turn/)).toBeInTheDocument()
})

test('adding a vault asks the same question in its own words', async () => {
  // Creating a vault opens it, so it leaves this one exactly as picking
  // another does. It is asked before the ritual rather than after it.
  setup('add')
  expect(await screen.findByText('Add a vault?')).toBeInTheDocument()
  expect(await screen.findByText(/Adding a vault opens it/)).toBeInTheDocument()
  expect(await screen.findByText(/Fix the merge is part way through a turn/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
})

test('keeps saying what was true when it interrupted you', async () => {
  // The reasons are live and a turn can land while the dialog is open. Left
  // to follow them, the body would rewrite itself under the reader.
  const { store } = setup()
  expect(await screen.findByText(/Fix the merge is part way through a turn/)).toBeInTheDocument()

  await act(async () => {
    store.set(reason, null)
  })
  expect(screen.getByText(/Fix the merge is part way through a turn/)).toBeInTheDocument()
})

test('confirming hands the switch back to the caller', async () => {
  const { onConfirm, onCancel } = setup()
  await userEvent.click(await screen.findByRole('button', { name: 'Switch anyway' }))
  expect(onConfirm).toHaveBeenCalled()
  expect(onCancel).not.toHaveBeenCalled()
})

test('cancelling switches nothing', async () => {
  const { onConfirm, onCancel } = setup()
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  expect(onCancel).toHaveBeenCalled()
  expect(onConfirm).not.toHaveBeenCalled()
})
