/**
 * One session's word on what its last turn changed (D88, #4, D100).
 *
 * The chip lives under its own tab now, so the two states worth pinning are the
 * ones a per-session chip could get wrong: whose turn it shows, and what it
 * reloads on. A turn ENDING is the event, and `agent:sessions` pushes on every
 * bracket, so the chip watches its own session leave `working` rather than
 * polling for a record.
 */
import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { TurnChip } from '../TurnChip'
import { agentSessionsAtom, type AgentSession } from '@/state/agent'
import {
  latestTurnsAtom,
  reviewTurnAtom,
  turnCountsAtom,
  turnReviewOpenAtom,
  type Turn,
} from '@/state/turns'

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

const TURN: Turn = { base: 'aaa', end: 'bbb', at: '2026-09-09T10:00:00Z', sessionId: 'sess-a' }
const OTHER: Turn = { base: 'ccc', end: 'ddd', at: '2026-09-09T11:00:00Z', sessionId: 'sess-b' }
const file = (path: string) => ({ path, status: 'M', added: 1, removed: 0 })

const session = (id: string, state: 'working' | 'idle' = 'idle'): AgentSession => ({
  id,
  name: 'New session',
  state,
  configStale: false,
  exited: false,
})

beforeEach(() => {
  list.mockReset()
  files.mockReset()
  list.mockResolvedValue([TURN])
  files.mockResolvedValue([file('a.md'), file('b.md')])
})

function setup(
  seed: {
    sessionId?: string
    turns?: Record<string, Turn>
    counts?: Record<string, number>
    sessions?: AgentSession[]
  } = {},
) {
  const store = createStore()
  store.set(agentSessionsAtom, seed.sessions ?? [session('sess-a')])
  store.set(latestTurnsAtom, seed.turns ?? { 'sess-a': TURN })
  store.set(turnCountsAtom, seed.counts ?? { 'aaa..bbb': 2 })
  return {
    store,
    ...render(
      <Provider store={store}>
        <TurnChip sessionId={seed.sessionId ?? 'sess-a'} />
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
  setup({ counts: { 'aaa..bbb': 1 } })
  expect(await screen.findByRole('button', { name: /Claude changed 1 file/ })).toBeInTheDocument()
})

test('shows its OWN session’s turn, not the newest in the vault', async () => {
  // The whole point of a chip per tab. Two sessions, two records, two counts.
  setup({
    sessionId: 'sess-b',
    sessions: [session('sess-a'), session('sess-b')],
    turns: { 'sess-a': TURN, 'sess-b': OTHER },
    counts: { 'aaa..bbb': 2, 'ccc..ddd': 5 },
  })
  expect(await screen.findByRole('button', { name: /Claude changed 5 files/ })).toBeInTheDocument()
})

test('says when the turn overlapped another session', async () => {
  // The range holds the other session's edits too — they shared one settle
  // commit — and git cannot tell them apart. Better said than inferred from two
  // identical shas.
  setup({
    turns: { 'sess-a': { ...TURN, overlapped: true } },
  })
  expect(await screen.findByText(/overlapped another session/)).toBeInTheDocument()
})

test('an old record without the field does not claim an overlap', async () => {
  setup()
  await screen.findByRole('button', { name: /Claude changed/ })
  expect(screen.queryByText(/overlapped/)).not.toBeInTheDocument()
})

test('shows nothing when this session has recorded no turn', () => {
  const { container } = setup({ turns: {} })
  expect(container).toBeEmptyDOMElement()
})

test('shows nothing for a turn with no reachable files', () => {
  // `TurnReview` has something to say about that state; a chip does not — it
  // would be a chip that wasted a click.
  const { container } = setup({ counts: { 'aaa..bbb': 0 } })
  expect(container).toBeEmptyDOMElement()
})

test('opens the review on ITS turn', async () => {
  const { store } = setup({
    sessionId: 'sess-b',
    sessions: [session('sess-a'), session('sess-b')],
    turns: { 'sess-a': TURN, 'sess-b': OTHER },
    counts: { 'aaa..bbb': 2, 'ccc..ddd': 5 },
  })
  await userEvent.click(await screen.findByRole('button', { name: /Claude changed/ }))

  expect(store.get(reviewTurnAtom)).toEqual(OTHER)
  expect(store.get(turnReviewOpenAtom)).toBe(true)
})

test('re-asks for the records when its own session’s turn ends', async () => {
  // `working` going true → false IS the end of a turn, and the record is written
  // as the bracket closes. Reloading while it is still true would read the
  // previous turn and show a stale count for the whole of this one.
  const { store } = setup()
  // Seeded with a turn and a count already, so nothing is asked for on mount:
  // the edge is what this listens to, not the level.
  await screen.findByRole('button', { name: /Claude changed/ })
  expect(list).not.toHaveBeenCalled()

  // Each flip has to reach React before the next one, or the component never
  // observes `working` as true and there is no edge left to detect.
  await act(async () => {
    store.set(agentSessionsAtom, [session('sess-a', 'working')])
  })
  expect(list).not.toHaveBeenCalled()

  await act(async () => {
    store.set(agentSessionsAtom, [session('sess-a', 'idle')])
  })
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
})

test('ignores another session’s turn ending', async () => {
  const { store } = setup({
    sessions: [session('sess-a'), session('sess-b', 'working')],
  })
  await screen.findByRole('button', { name: /Claude changed/ })
  list.mockClear()

  await act(async () => {
    store.set(agentSessionsAtom, [session('sess-a'), session('sess-b', 'idle')])
  })
  expect(list).not.toHaveBeenCalled()
})

test('asks for a record on mount when it has none', async () => {
  // A vault opened with the drawer closed: the last turn may have been minutes
  // ago and nothing has pushed a session list since.
  setup({ turns: {} })
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
})
