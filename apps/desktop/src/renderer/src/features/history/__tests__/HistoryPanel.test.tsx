/**
 * The open note's history sidebar: its header counts the file's revisions, the
 * same uncapped count the frontmatter header's `v.N` shows.
 */
import { render, screen } from '@/test/render'
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { HistoryPanel } from '../HistoryPanel'
import { historyOpenAtom } from '@/state/history'
import { workspaceAtom } from '@/state/panes'
import { activeRemoteAtom } from '@/state/vaults'

const { fileHistory } = vi.hoisted(() => ({ fileHistory: vi.fn() }))

vi.mock('@/lib/trpc', () => ({
  trpc: {
    history: { list: { query: () => Promise.resolve([]) } },
    notes: { fileHistory: { query: () => fileHistory() } },
  },
}))

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
