/**
 * The footer's word on what the agent's last turn changed (D88, #4).
 *
 * This is the only thing that tells you a turn happened at all once the drawer
 * is closed, so the two states worth pinning are when it appears and what it
 * reloads on: a turn ENDING is the event, and `agent:status` already pushes
 * `working` on every bracket, so the chip watches that go true → false rather
 * than polling for a record.
 */
import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { TurnChip } from '../TurnChip'
import { agentSessionsAtom, type AgentSession } from '@/state/agent'
import { latestTurnAtom, turnFilesAtom, turnReviewOpenAtom, type Turn } from '@/state/turns'
import { activeRemoteAtom } from '@/state/vaults'

const list = vi.fn()
const files = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    turns: {
      list: { query: () => list() },
      files: { query: (i: unknown) => files(i) },
      fileDiff: { query: () => Promise.resolve({ before: '', after: '' }) },
      revert: { mutate: () => Promise.resolve({ ok: true }) },
    },
  },
}))

const TURN: Turn = { base: 'aaa', end: 'bbb', at: '2026-09-09T10:00:00Z' }
const session = (state: 'working' | 'idle'): AgentSession => ({
  id: 'sess-a',
  name: 'New session',
  state,
  configStale: false,
  exited: false,
})
const file = (path: string) => ({ path, status: 'M', added: 1, removed: 0 })

beforeEach(() => {
  list.mockReset()
  files.mockReset()
  list.mockResolvedValue([TURN])
  files.mockResolvedValue([file('a.md'), file('b.md')])
})

function setup(seed: { turn?: Turn | null; files?: ReturnType<typeof file>[] } = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'git@github.com:syv-ai/vault.git')
  store.set(latestTurnAtom, seed.turn === undefined ? TURN : seed.turn)
  store.set(turnFilesAtom, seed.files ?? [file('a.md'), file('b.md')])
  return {
    store,
    ...render(
      <Provider store={store}>
        <TurnChip />
      </Provider>,
    ),
  }
}

test('says how many files the turn changed', async () => {
  setup()
  expect(await screen.findByRole('button', { name: /Claude changed 2 files/ })).toBeInTheDocument()
})

test('counts one file as a file', async () => {
  // Both readings have to be right; "1 files" is the giveaway that nobody looked.
  setup({ files: [file('only.md')] })
  expect(await screen.findByRole('button', { name: /Claude changed 1 file$/ })).toBeInTheDocument()
})

test('shows nothing when no turn has been recorded', () => {
  const { container } = setup({ turn: null })
  expect(container).toBeEmptyDOMElement()
})

test('shows nothing for a turn with no reachable files', () => {
  // The panel has something to say about this state; the footer does not. A chip
  // that opened onto "this turn's history is gone" is a chip that wasted a click.
  const { container } = setup({ files: [] })
  expect(container).toBeEmptyDOMElement()
})

test('opens the review', async () => {
  const { store } = setup()
  await userEvent.click(await screen.findByRole('button', { name: /Claude changed/ }))
  expect(store.get(turnReviewOpenAtom)).toBe(true)
})

test('re-asks when a turn ends, not while one is running', async () => {
  // `working` going true → false IS the end of a turn, and the record is written
  // in that same handler. Reloading while it is still true would read the
  // previous turn and show a stale count for the whole of this one.
  const { store } = setup()
  // Seeded with a turn already, so nothing is asked for on mount: the edge is
  // what this listens to, not the level.
  await waitFor(() => expect(files).toHaveBeenCalled())
  expect(list).not.toHaveBeenCalled()

  // Each flip has to reach React before the next one, or the component never
  // observes `working` as true and there is no edge left to detect.
  await act(async () => {
    store.set(agentSessionsAtom, [session('working')])
  })
  expect(list).not.toHaveBeenCalled()

  await act(async () => {
    store.set(agentSessionsAtom, [session('idle')])
  })
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
})

test('asks for a record on mount when it has none', async () => {
  // A vault opened with the drawer closed: the last turn may have been minutes
  // ago and nothing has pushed a status since.
  setup({ turn: null })
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
})

test('a vault switch clears the last vault’s turn and closes the review', async () => {
  // The record is per vault and this component outlives the switch. Left alone,
  // the footer would offer the previous vault's turn, and opening it would ask
  // the new vault's git for a range it has never heard of.
  const { store } = setup()
  store.set(turnReviewOpenAtom, true)
  // The new vault has never run a turn, so nothing refills what the switch clears.
  list.mockResolvedValue([])
  await act(async () => {
    store.set(activeRemoteAtom, 'git@github.com:syv-ai/other.git')
  })
  await waitFor(() => expect(store.get(latestTurnAtom)).toBeNull())
  expect(store.get(turnFilesAtom)).toEqual([])
  // Closed, because the panel it was showing belongs to a vault that is no
  // longer open.
  expect(store.get(turnReviewOpenAtom)).toBe(false)
  expect(screen.queryByRole('button', { name: /Claude changed/ })).toBeNull()
})
