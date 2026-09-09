/**
 * The vault's history, as a tab.
 *
 * The reading it owes: a commit is one act, so picking one shows every file it
 * changed with its diff already open rather than a second list to click
 * through. What only this file can show is that each file loads its own diff,
 * that collapsing one does not throw the answer away, and that a vault switch
 * does not leave the last vault's commits on screen.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { HistoryView } from '../HistoryView'
import { activeRemoteAtom } from '@/state/vaults'

const log = vi.fn()
const changed = vi.fn()
const fileDiff = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    history: {
      log: { query: () => log() },
      changed: { query: (i: unknown) => changed(i) },
      fileDiff: { query: (i: unknown) => fileDiff(i) },
    },
  },
}))

const COMMITS = [
  { sha: 'a'.repeat(40), subject: 'Update 2 files', date: '2026-09-09T10:00:00Z', author: 'Ada Holm' },
  { sha: 'b'.repeat(40), subject: 'Update plan.md', date: '2026-09-08T10:00:00Z', author: 'Ada Holm' },
]

beforeEach(() => {
  for (const fn of [log, changed, fileDiff]) fn.mockReset()
  log.mockResolvedValue(COMMITS)
  changed.mockResolvedValue(['notes/plan.md', 'notes/other.md'])
  fileDiff.mockImplementation((i: { path: string }) =>
    Promise.resolve({ before: `old ${i.path}\n`, after: `new ${i.path}\n` }),
  )
})

function setup(remote: string | null = 'syv-ai/vault') {
  const store = createStore()
  store.set(activeRemoteAtom, remote)
  return {
    store,
    ...render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    ),
  }
}

test('lists the vault’s commits', async () => {
  setup()
  expect(await screen.findByRole('button', { name: /Update 2 files/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Update plan\.md/ })).toBeInTheDocument()
})

test('says what to do before a commit is picked', async () => {
  setup()
  expect(await screen.findByText(/Pick a commit/)).toBeInTheDocument()
})

test('a picked commit opens every file it changed, expanded', async () => {
  // The whole point of the rework: a commit is one act, read as one.
  setup()
  await userEvent.click(await screen.findByRole('button', { name: /Update 2 files/ }))
  const plan = await screen.findByRole('button', { name: /notes\/plan\.md/ })
  const other = await screen.findByRole('button', { name: /notes\/other\.md/ })
  expect(plan).toHaveAttribute('aria-expanded', 'true')
  expect(other).toHaveAttribute('aria-expanded', 'true')
  // Each asks for its own diff, so thirty files fetch in parallel rather than
  // serially through a selection.
  await waitFor(() => expect(fileDiff).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(document.querySelectorAll('.cm-editor')).toHaveLength(2))
})

test('collapsing a file hides its diff and keeps its answer', async () => {
  setup()
  await userEvent.click(await screen.findByRole('button', { name: /Update 2 files/ }))
  await waitFor(() => expect(fileDiff).toHaveBeenCalledTimes(2))

  const plan = await screen.findByRole('button', { name: /notes\/plan\.md/ })
  await userEvent.click(plan)
  expect(plan).toHaveAttribute('aria-expanded', 'false')
  await waitFor(() => expect(document.querySelectorAll('.cm-editor')).toHaveLength(1))

  // Re-opening must not re-fetch: the answer is kept per commit, not per view.
  await userEvent.click(plan)
  await waitFor(() => expect(document.querySelectorAll('.cm-editor')).toHaveLength(2))
  expect(fileDiff).toHaveBeenCalledTimes(2)
})

test('picking another commit drops the first one’s files', async () => {
  setup()
  await userEvent.click(await screen.findByRole('button', { name: /Update 2 files/ }))
  await screen.findByRole('button', { name: /notes\/plan\.md/ })

  changed.mockResolvedValue(['only.md'])
  await userEvent.click(screen.getByRole('button', { name: /Update plan\.md/ }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /notes\/plan\.md/ })).toBeNull())
  expect(await screen.findByRole('button', { name: /only\.md/ })).toBeInTheDocument()
})

test('a commit that changed no files says so', async () => {
  setup()
  changed.mockResolvedValue([])
  await userEvent.click(await screen.findByRole('button', { name: /Update 2 files/ }))
  expect(await screen.findByText(/changed no files/)).toBeInTheDocument()
})

test('a file the commit did not touch reads as that, not as an empty diff', async () => {
  // `show` answers '' for both sides when a path does not exist at either end.
  setup()
  changed.mockResolvedValue(['ghost.md'])
  fileDiff.mockResolvedValue({ before: '', after: '' })
  await userEvent.click(await screen.findByRole('button', { name: /Update 2 files/ }))
  expect(await screen.findByText(/did not change this file/)).toBeInTheDocument()
})

test('a vault switch does not leave the last vault’s commits up', async () => {
  const { store } = setup()
  await screen.findByRole('button', { name: /Update 2 files/ })
  log.mockResolvedValue([])
  await userEvent.click(await screen.findByRole('button', { name: /Update 2 files/ }))

  store.set(activeRemoteAtom, 'syv-ai/other')
  await waitFor(() => expect(screen.queryByRole('button', { name: /Update 2 files/ })).toBeNull())
  // And the previous vault's selection went with them.
  expect(await screen.findByText(/Pick a commit/)).toBeInTheDocument()
})

test('the header names the vault it is showing', async () => {
  setup()
  const header = await screen.findByText('History')
  expect(within(header.parentElement!).getByText('syv-ai/vault')).toBeInTheDocument()
})
