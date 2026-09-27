/**
 * The open note's history sidebar: its header counts the file's revisions, the
 * same uncapped count the frontmatter header's `v.N` shows.
 */
import { act, render, screen, waitFor } from '@/test/render'
import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { HistoryPanel } from '../HistoryPanel'
import { historyOpenAtom } from '@/state/history'
import { workspaceAtom } from '@/state/panes'
import { activeRemoteAtom, bumpHistoryEpochs, historyEpochsAtom } from '@/state/vaults'

const { fileHistory, list } = vi.hoisted(() => ({
  fileHistory: vi.fn(),
  list: vi.fn(() => Promise.resolve([] as unknown[])),
}))

vi.mock('@/lib/trpc', () => ({
  trpc: {
    history: { list: { query: () => list() } },
    notes: { fileHistory: { query: () => fileHistory() } },
  },
}))

afterEach(() => list.mockClear())

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/vault')
  store.set(workspaceAtom, {
    panes: [{ tabs: [{ kind: 'note', path: 'notes/plan.md' }], active: 0 }],
    active: 0,
  })
  store.set(historyOpenAtom, true)
  render(
    <Provider store={store}>
      <HistoryPanel />
    </Provider>,
  )
  return store
}

test('the header counts the revisions, beyond the list it shows', async () => {
  // Not the rows: the list is capped at 200, and a long-lived file has more.
  fileHistory.mockResolvedValue({ last: {}, first: {}, revisions: 214 })
  setup()
  expect(await screen.findByText('214 revisions')).toBeInTheDocument()
})

test('one revision is singular', async () => {
  fileHistory.mockResolvedValue({ last: {}, first: {}, revisions: 1 })
  setup()
  expect(await screen.findByText('1 revision')).toBeInTheDocument()
})

test('a file never committed has none', async () => {
  fileHistory.mockResolvedValue(null)
  setup()
  expect(await screen.findByText('0 revisions')).toBeInTheDocument()
})

test('closing slides it out rather than removing it at once', async () => {
  // It must stay rendered after closing so the drawer can play its exit.
  fileHistory.mockResolvedValue({ last: {}, first: {}, revisions: 3 })
  const store = setup()
  await screen.findByText('3 revisions')

  act(() => store.set(historyOpenAtom, false))
  const drawer = document.querySelector('[data-drawer="history"]')
  expect(drawer).toHaveAttribute('data-state', 'closed')
  // It slides out with what it showed, rather than emptying on the way.
  expect(screen.getByText('3 revisions')).toBeInTheDocument()
})

test('a commit that takes the open file refreshes the count and the list together', async () => {
  // Autosave commits while the drawer is open; the header and rows must not
  // disagree, nor lag until the drawer is reopened.
  fileHistory.mockResolvedValue({ last: {}, first: {}, revisions: 3 })
  const store = setup()
  await screen.findByText('3 revisions')
  expect(list).toHaveBeenCalledTimes(1)

  fileHistory.mockResolvedValue({ last: {}, first: {}, revisions: 4 })
  act(() => store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, ['notes/plan.md'])))
  expect(await screen.findByText('4 revisions')).toBeInTheDocument()
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
})

test('a commit to another file leaves the drawer alone', async () => {
  fileHistory.mockResolvedValue({ last: {}, first: {}, revisions: 3 })
  const store = setup()
  await screen.findByText('3 revisions')
  const lists = list.mock.calls.length

  act(() => store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, ['other.md'])))
  await Promise.resolve()
  expect(list).toHaveBeenCalledTimes(lists)
})
