/**
 * A card's privacy: the marker on a private task, and the menu that shares it
 * or, asking first, makes it private again.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { Dialog } from '@/primitives'
import type { PluginDialog } from '@/plugin-api'
import type { Task } from '../shared/types'
import { BoardCard } from '../renderer/BoardCard'

const setShared = vi.fn()
const opened = vi.fn<(dialog: PluginDialog) => void>()

// The dialog the card asks to open, caught rather than shown: the host that
// draws it is the app shell's.
vi.mock('@/plugin-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/plugin-api')>()
  const { atom } = await import('jotai')
  return {
    ...real,
    openDialogAtom: atom(null, (_get, _set, dialog: PluginDialog) => opened(dialog)),
  }
})

vi.mock('../renderer/state', async (importOriginal) => {
  const real = await importOriginal<typeof import('../renderer/state')>()
  const { atom } = await import('jotai')
  return {
    ...real,
    setTaskSharedAtom: atom(null, (_get, _set, path: string, shared: boolean) =>
      setShared(path, shared),
    ),
  }
})

beforeEach(() => {
  setShared.mockReset()
  opened.mockReset()
})

const task = (path: string): Task => ({
  path,
  title: 'Fix login',
  status: 'todo',
  tags: [],
  assignees: [],
  description: '',
})

function setup(path: string, store = createStore()) {
  const drag = { source: () => ({}), isFolded: () => false } as never
  render(
    <Provider store={store}>
      <BoardCard
        task={task(path)}
        shown="todo"
        drag={drag}
        parking={{ park: () => {}, release: () => {} }}
      />
    </Provider>,
  )
  return store
}

test('a private task is marked, and Share with vault shares it at once', async () => {
  setup('ops/task.fix-login.local.md')
  expect(screen.getByRole('img', { name: 'Private' })).toBeInTheDocument()
  await userEvent.click(screen.getByLabelText('Actions for Fix login'))
  expect(screen.queryByText('Make private…')).not.toBeInTheDocument()
  await userEvent.click(await screen.findByText('Share with vault'))
  await waitFor(() => expect(setShared).toHaveBeenCalledWith('ops/task.fix-login.local.md', true))
})

test('Make private asks first, and renames only once confirmed', async () => {
  const store = setup('ops/task.fix-login.md')
  expect(screen.queryByRole('img', { name: 'Private' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByLabelText('Actions for Fix login'))
  expect(screen.queryByText('Share with vault')).not.toBeInTheDocument()
  await userEvent.click(await screen.findByText('Make private…'))

  expect(opened).toHaveBeenCalledOnce()
  expect(setShared).not.toHaveBeenCalled()
  const dialog = opened.mock.calls[0]![0]
  render(
    <Provider store={store}>
      <Dialog open onClose={() => {}}>
        {dialog.render(() => {})}
      </Dialog>
    </Provider>,
  )
  expect(screen.getByText(/leaves every teammate's board/)).toBeInTheDocument()
  expect(screen.getByText(/Git history keeps the shared version/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Make private' }))
  expect(setShared).toHaveBeenCalledWith('ops/task.fix-login.md', false)
})
