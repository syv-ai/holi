/**
 * One file's history, fetched once and shared: the frontmatter header and the
 * history drawer both read `fileHistoryAtom(path)`.
 *
 * It follows the file's history epoch, holds the last answer while a refetch is
 * in flight, and never shows one vault's answer in another.
 */
import { waitFor } from '@/test/render'
import { createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { fileHistoryAtom } from '../file-history'
import { activeRemoteAtom, bumpHistoryEpochs, historyEpochsAtom } from '../vaults'

const fileHistory = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    notes: { fileHistory: { query: (input: { path: string }) => fileHistory(input) } },
  },
}))

const COMMIT = { date: '2026-09-27T22:14:51', author: 'ada-holm' }
const ONCE = { last: COMMIT, first: COMMIT, revisions: 1 }
const TWICE = { last: COMMIT, first: COMMIT, revisions: 2 }
const PATH = 'work/task.buy-milk.md'

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/notes')
  const seen: unknown[] = []
  const history = fileHistoryAtom(PATH)
  store.sub(history, () => seen.push(store.get(history)))
  return { store, history, seen }
}

afterEach(() => fileHistory.mockReset())

test('undefined until main answers, then the answer', async () => {
  fileHistory.mockResolvedValue(ONCE)
  const { store, history } = setup()
  expect(store.get(history)).toBeUndefined()
  await waitFor(() => expect(store.get(history)).toEqual(ONCE))
  expect(fileHistory).toHaveBeenCalledWith({ path: PATH })
})

test('a failed fetch answers null, as for an untracked file', async () => {
  fileHistory.mockImplementation(() => Promise.reject(new Error('git exploded')))
  const { store, history } = setup()
  await waitFor(() => expect(store.get(history)).toBeNull())
})

test('a commit that takes the file refetches, holding the last answer meanwhile', async () => {
  fileHistory.mockResolvedValueOnce(null)
  const { store, history, seen } = setup()
  await waitFor(() => expect(store.get(history)).toBeNull())
  fileHistory.mockResolvedValueOnce(ONCE)
  store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, [PATH]))
  expect(store.get(history)).toBeNull()
  await waitFor(() => expect(store.get(history)).toEqual(ONCE))
  expect(seen).not.toContain(undefined)
})

test('a merged pull refetches every file', async () => {
  fileHistory.mockResolvedValueOnce(ONCE).mockResolvedValueOnce(TWICE)
  const { store, history } = setup()
  await waitFor(() => expect(store.get(history)).toEqual(ONCE))
  store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, null))
  await waitFor(() => expect(store.get(history)).toEqual(TWICE))
})

test('a commit to another file does not refetch', async () => {
  fileHistory.mockResolvedValue(ONCE)
  const { store, history } = setup()
  await waitFor(() => expect(store.get(history)).toEqual(ONCE))
  store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, ['other.md']))
  await Promise.resolve()
  expect(fileHistory).toHaveBeenCalledTimes(1)
})

test('switching vault never shows the last vault answer for the same path', async () => {
  fileHistory.mockResolvedValueOnce(ONCE)
  const { store, history } = setup()
  await waitFor(() => expect(store.get(history)).toEqual(ONCE))
  let answer: (v: unknown) => void = () => {}
  fileHistory.mockReturnValueOnce(new Promise((r) => (answer = r)))
  store.set(activeRemoteAtom, 'syv-ai/other')
  expect(store.get(history)).toBeUndefined()
  answer(TWICE)
  await waitFor(() => expect(store.get(history)).toEqual(TWICE))
})
