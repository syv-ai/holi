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

test('an unedited open draft follows the asynchronously loaded default status', async () => {
  const store = createStore()
  store.set(snapshotAtom, emptyVaultSnapshot())
  const { rerender } = render(
    <Provider store={store}>
      <NewTaskDialog
        open
        onOpenChange={() => {}}
        statuses={DEFAULT_STATUSES}
        defaultStatus="todo"
        today="2026-10-25"
        onCreate={vi.fn(() => Promise.resolve())}
      />
    </Provider>,
  )

  expect(screen.getByRole('button', { name: 'Status: To do' })).toBeInTheDocument()
  // The project/status snapshot can arrive after this always-mounted dialog.
  // An untouched draft adopts its new default.
  rerender(
    <Provider store={store}>
      <NewTaskDialog
        open
        onOpenChange={() => {}}
        statuses={DEFAULT_STATUSES}
        defaultStatus="doing"
        today="2026-10-25"
        onCreate={vi.fn(() => Promise.resolve())}
      />
    </Provider>,
  )
  expect(screen.getByRole('button', { name: 'Status: In progress' })).toBeInTheDocument()
})

test('Cancel resets on reopen while temporarily hiding preserves the live draft', async () => {
  const store = createStore()
  store.set(snapshotAtom, emptyVaultSnapshot())
  const props = {
    onOpenChange: vi.fn(),
    statuses: DEFAULT_STATUSES,
    defaultStatus: 'todo',
    today: '2026-10-25',
    onCreate: vi.fn(() => Promise.resolve()),
  }
  const view = render(
    <Provider store={store}>
      <NewTaskDialog open {...props} />
    </Provider>,
  )

  await userEvent.type(screen.getByPlaceholderText('Task title'), 'Keep this draft')
  view.rerender(
    <Provider store={store}>
      <NewTaskDialog open visible={false} {...props} />
    </Provider>,
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  view.rerender(
    <Provider store={store}>
      <NewTaskDialog open {...props} />
    </Provider>,
  )
  expect(screen.getByPlaceholderText('Task title')).toHaveValue('Keep this draft')

  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  view.rerender(
    <Provider store={store}>
      <NewTaskDialog open={false} {...props} />
    </Provider>,
  )
  view.rerender(
    <Provider store={store}>
      <NewTaskDialog open {...props} />
    </Provider>,
  )
  expect(screen.getByPlaceholderText('Task title')).toHaveValue('')
})
