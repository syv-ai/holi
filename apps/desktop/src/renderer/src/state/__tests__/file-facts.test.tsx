/**
 * A file's facts follow its history, not just its opening.
 *
 * A task made from the file tree opens before its first autosave commit, so
 * the first answer has no history. The commit lands a moment later; the facts
 * must be asked again then, and the stale answer must hold its place meanwhile
 * rather than blank the line.
 */
import { act, render, screen, waitFor } from '@/test/render'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { useFileFacts } from '../file-facts'
import { activeRemoteAtom, bumpHistoryEpochs, historyEpochsAtom } from '../vaults'

const fileHistory = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    notes: {
      fileHistory: { query: (input: { path: string }) => fileHistory(input) },
      links: { query: () => Promise.resolve({ in: 0, out: 0 }) },
    },
  },
}))

const COMMIT = { date: '2026-09-27T22:14:51', author: 'ada-holm' }

function Probe({ path }: { path: string }): React.JSX.Element {
  const facts = useFileFacts(path)
  return (
    <span data-testid="facts">
      {facts === null ? 'pending' : facts.history === null ? 'untracked' : 'created'}
    </span>
  )
}

function setup(path: string) {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/notes')
  render(
    <Provider store={store}>
      <Probe path={path} />
    </Provider>,
  )
  return store
}

beforeEach(() => fileHistory.mockReset())

test('a commit that takes the file asks for its facts again', async () => {
  fileHistory.mockResolvedValueOnce(null)
  const store = setup('work/task.buy-milk.md')
  await waitFor(() => expect(screen.getByTestId('facts')).toHaveTextContent('untracked'))

  fileHistory.mockResolvedValueOnce({ last: COMMIT, first: COMMIT, revisions: 1 })
  act(() => store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, ['work/task.buy-milk.md'])))
  // The old answer holds its place while the new one is asked for.
  expect(screen.getByTestId('facts')).toHaveTextContent('untracked')
  await waitFor(() => expect(screen.getByTestId('facts')).toHaveTextContent('created'))
})

test('a merged pull may have moved any file, so it asks too', async () => {
  fileHistory.mockResolvedValue(null)
  const store = setup('plan.md')
  await waitFor(() => expect(fileHistory).toHaveBeenCalledTimes(1))
  act(() => store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, null)))
  await waitFor(() => expect(fileHistory).toHaveBeenCalledTimes(2))
})

test("another file's commit is not this file's business", async () => {
  fileHistory.mockResolvedValue(null)
  const store = setup('plan.md')
  await waitFor(() => expect(fileHistory).toHaveBeenCalledTimes(1))
  act(() => store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, ['other.md'])))
  await new Promise((r) => setTimeout(r, 20))
  expect(fileHistory).toHaveBeenCalledTimes(1)
})
