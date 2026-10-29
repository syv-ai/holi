/**
 * New task is private unless Sharing says otherwise, as every new task is
 * (docs/features/tasks.md), and the choice rides along with the create.
 */
import { DEFAULT_STATUSES, emptyVaultSnapshot } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/render'
import { snapshotAtom } from '@/state/vaults'
import { NewTaskDialog } from '../new-task-dialog'

function setup() {
  const store = createStore()
  store.set(snapshotAtom, emptyVaultSnapshot())
  const onCreate = vi.fn(() => Promise.resolve())
  render(
    <Provider store={store}>
      <NewTaskDialog
        open
        onOpenChange={() => {}}
        statuses={DEFAULT_STATUSES}
        defaultStatus="todo"
        today="2026-10-25"
        onCreate={onCreate}
      />
    </Provider>,
  )
  return { onCreate }
}

test('a new task is private until it is shared', async () => {
  const { onCreate } = setup()
  await userEvent.type(screen.getByPlaceholderText('Task title'), 'Write the brief')
  expect(screen.getByRole('button', { name: 'Sharing: Private' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Create task' }))
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Write the brief', shared: false }),
    ),
  )
})

test('Shared with vault makes a committed task', async () => {
  const { onCreate } = setup()
  await userEvent.type(screen.getByPlaceholderText('Task title'), 'Write the brief')
  await userEvent.click(screen.getByRole('button', { name: 'Sharing: Private' }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: /Shared with vault/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Create task' }))
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ shared: true })),
  )
})
