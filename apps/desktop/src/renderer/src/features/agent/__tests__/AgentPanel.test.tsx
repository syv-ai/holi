/**
 * The drawer's tab strip (D100).
 *
 * The strip renders main's list and nothing else, so what is worth pinning is
 * the places the panel could be tempted to have an opinion of its own: which tab
 * is showing when the active one goes away, what happens when you close the last
 * one, and whether ending a session that is mid-turn asks first.
 *
 * The terminals are stubbed. xterm needs measured geometry that jsdom does not
 * have, and what a terminal does with its own bytes is `SessionTerminal`'s
 * business rather than the strip's.
 */
import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { AgentPanel } from '../AgentPanel'
import {
  activeSessionIdAtom,
  agentModeAtSpawnAtom,
  agentPanelOpenAtom,
  agentSeedPromptAtom,
  agentSessionsAtom,
  type AgentSession,
} from '@/state/agent'
import { activeRemoteAtom } from '@/state/vaults'
import { reviewTurnAtom, turnReviewOpenAtom, type Turn } from '@/state/turns'
import { ResizablePanelGroup } from '@/primitives'
import { StrictMode } from 'react'

vi.mock('../SessionTerminal', () => ({
  SessionTerminal: ({ sessionId, visible }: { sessionId: string; visible: boolean }) => (
    <div data-terminal={sessionId} data-visible={visible} />
  ),
}))

const REMOTE = 'owner/repo'

const session = (over: Partial<AgentSession> & { id: string }): AgentSession => ({
  name: 'New session',
  state: 'idle',
  configStale: false,
  exited: false,
  ...over,
})

const start = vi.fn()
const kill = vi.fn()
let pushSessions: ((list: AgentSession[]) => void) | null = null
/** What main would answer the panel's one mount-time `sessions()` with. Kept in
 *  step with the seed, or that answer lands and wipes it. */
let current: AgentSession[] = []

beforeEach(() => {
  start.mockReset()
  kill.mockReset()
  start.mockResolvedValue({ ok: true, id: 'new-session' })
  kill.mockResolvedValue({ ok: true })
  pushSessions = null
  current = []
  window.holi = {
    agent: {
      onSessions: (cb: (list: AgentSession[]) => void) => {
        pushSessions = cb
        return () => {
          pushSessions = null
        }
      },
      sessions: () => Promise.resolve(current),
      start: (args: unknown) => start(args),
      kill: (id: string) => kill(id),
      attach: () => Promise.resolve(''),
      write: () => {},
      resize: () => {},
      onData: () => () => {},
      onExit: () => () => {},
    },
  } as never
})

function setup(
  seed: { sessions?: AgentSession[]; open?: boolean; activeId?: string; strict?: boolean } = {},
) {
  const store = createStore()
  current = seed.sessions ?? []
  store.set(activeRemoteAtom, REMOTE)
  store.set(agentSessionsAtom, current)
  store.set(agentPanelOpenAtom, seed.open ?? true)
  if (seed.activeId !== undefined) store.set(activeSessionIdAtom, seed.activeId)
  return {
    store,
    // `ResizablePanel` throws outside a group, exactly as it would in the app.
    ...render(
      seed.strict === true ? (
        <StrictMode>
          <Provider store={store}>
            <ResizablePanelGroup orientation="horizontal">
              <AgentPanel />
            </ResizablePanelGroup>
          </Provider>
        </StrictMode>
      ) : (
        <Provider store={store}>
          <ResizablePanelGroup orientation="horizontal">
            <AgentPanel />
          </ResizablePanelGroup>
        </Provider>
      ),
    ),
  }
}

const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent)

test('renders one tab per session, in the order main gives them', async () => {
  setup({
    sessions: [
      session({ id: 'a', name: 'Fix the merge' }),
      session({ id: 'b', name: 'New session' }),
    ],
  })
  await waitFor(() => expect(tabs()).toEqual(['Fix the merge', 'New session']))
})

test('follows the pushed list', async () => {
  const { store } = setup({ sessions: [session({ id: 'a', name: 'One' })] })
  await waitFor(() => expect(pushSessions).not.toBeNull())

  await act(async () => {
    pushSessions!([session({ id: 'a', name: 'One' }), session({ id: 'b', name: 'Two' })])
  })
  expect(tabs()).toEqual(['One', 'Two'])
  expect(store.get(agentSessionsAtom)).toHaveLength(2)
})

test('shows only the active session’s terminal', async () => {
  setup({
    sessions: [session({ id: 'a', name: 'One' }), session({ id: 'b', name: 'Two' })],
    activeId: 'b',
  })
  await waitFor(() =>
    expect(document.querySelector('[data-terminal="b"]')?.getAttribute('data-visible')).toBe(
      'true',
    ),
  )
  // Mounted, not unmounted: its scrollback is in there.
  expect(document.querySelector('[data-terminal="a"]')?.getAttribute('data-visible')).toBe('false')
})

test('falls back to a live session when the active tab is closed out from under it', async () => {
  setup({
    sessions: [session({ id: 'a', name: 'One' }), session({ id: 'b', name: 'Two' })],
    activeId: 'b',
  })
  await waitFor(() => expect(pushSessions).not.toBeNull())

  await act(async () => {
    pushSessions!([session({ id: 'a', name: 'One' })])
  })
  expect(document.querySelector('[data-terminal="a"]')?.getAttribute('data-visible')).toBe('true')
})

test('the + starts another session at the measured geometry', async () => {
  setup({ sessions: [session({ id: 'a' })] })
  await userEvent.click(await screen.findByLabelText('start another session'))
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ vaultId: REMOTE })),
  )
})

test('ends an idle session without asking', async () => {
  setup({ sessions: [session({ id: 'a', name: 'One', state: 'idle' })] })
  await userEvent.click(await screen.findByLabelText('end One'))
  await waitFor(() => expect(kill).toHaveBeenCalledWith('a'))
})

test('asks before ending a session that is working', async () => {
  setup({ sessions: [session({ id: 'a', name: 'One', state: 'working' })] })
  await userEvent.click(await screen.findByLabelText('end One'))

  expect(kill).not.toHaveBeenCalled()
  expect(await screen.findByText('End One?')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'End session' }))
  await waitFor(() => expect(kill).toHaveBeenCalledWith('a'))
})

test('a cancelled confirm leaves the session alone', async () => {
  setup({ sessions: [session({ id: 'a', name: 'One', state: 'needs-you' })] })
  await userEvent.click(await screen.findByLabelText('end One'))
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

  expect(kill).not.toHaveBeenCalled()
})

test('an exited session keeps its tab, and ends without a question', async () => {
  // An exit is something to read, not a tab that vanishes from under the reader.
  setup({ sessions: [session({ id: 'a', name: 'One', exited: true, state: 'working' })] })
  expect(tabs()).toEqual(['One'])
  // And it reads as ended rather than as whatever it was doing when it died.
  const dot = document.querySelector('[data-session-tab="a"] span[aria-hidden="true"]')
  expect(dot?.className).toContain('bg-muted-foreground')

  await userEvent.click(await screen.findByLabelText('end One'))
  await waitFor(() => expect(kill).toHaveBeenCalledWith('a'))
})

test('opening the drawer with no sessions starts one', async () => {
  const { store } = setup({ sessions: [], open: false })
  await act(async () => {
    store.set(agentPanelOpenAtom, true)
  })
  await waitFor(() => expect(start).toHaveBeenCalled())
})

test('closing the last tab does not instantly start another', async () => {
  // Keyed to the drawer OPENING, not to "the list is empty while it is open" —
  // the second reading respawns on the close and makes the button look broken.
  setup({ sessions: [session({ id: 'a', name: 'One' })], open: true })
  await waitFor(() => expect(pushSessions).not.toBeNull())
  start.mockClear()

  await userEvent.click(await screen.findByLabelText('end One'))
  await act(async () => {
    pushSessions!([])
  })

  expect(start).not.toHaveBeenCalled()
})

test('opening the drawer with a session already running starts nothing', async () => {
  const { store } = setup({ sessions: [session({ id: 'a' })], open: false })
  await act(async () => {
    store.set(agentPanelOpenAtom, true)
  })
  expect(start).not.toHaveBeenCalled()
})

test('opening the drawer with only an exited session starts one', async () => {
  // A dead tab is a record, not a session. Opening the drawer should hand you
  // something you can type into.
  const { store } = setup({ sessions: [session({ id: 'a', exited: true })], open: false })
  await act(async () => {
    store.set(agentPanelOpenAtom, true)
  })
  await waitFor(() => expect(start).toHaveBeenCalled())
})

test('Resume opens a new tab and kills nothing', async () => {
  // It used to kill first because there was one slot to resume into. There is
  // not any more, and ending a live conversation to go and look at an old one
  // is a cost the design does not ask anybody to pay.
  setup({ sessions: [session({ id: 'a', name: 'One' })] })
  await userEvent.click(await screen.findByLabelText(/Resume a past session/))

  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ resume: true })))
  expect(kill).not.toHaveBeenCalled()
})

test('Restart ends the tab you are looking at, and only that one', async () => {
  setup({
    sessions: [session({ id: 'a', name: 'One' }), session({ id: 'b', name: 'Two' })],
    activeId: 'b',
  })
  await userEvent.click(await screen.findByLabelText('Restart this session'))

  await waitFor(() => expect(kill).toHaveBeenCalledWith('b'))
  expect(kill).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(start).toHaveBeenCalled())
})

test('a reconcile seed spawns ONE session, even under StrictMode', async () => {
  // StrictMode invokes effects twice in development, and clearing the seed is a
  // round trip through state — so an unguarded effect spawns two sessions for
  // one reconcile, which is two tabs both told to resolve the same merge.
  const store = createStore()
  current = []
  store.set(activeRemoteAtom, REMOTE)
  store.set(agentSessionsAtom, [])
  store.set(agentPanelOpenAtom, true)
  store.set(agentSeedPromptAtom, 'resolve the merge conflict')
  render(
    <StrictMode>
      <Provider store={store}>
        <ResizablePanelGroup orientation="horizontal">
          <AgentPanel />
        </ResizablePanelGroup>
      </Provider>
    </StrictMode>,
  )

  await waitFor(() => expect(store.get(agentSeedPromptAtom)).toBeNull())
  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: 'resolve the merge conflict' }),
  )
})

test('a vault switch clears the turn review', async () => {
  // The record is per vault and this panel outlives the switch. Left alone, the
  // review stays open on the last vault's turn and asks the new vault's git for
  // a range it has never heard of.
  const turn: Turn = { base: 'aaa', end: 'bbb', at: '2026-09-09T10:00:00Z', sessionId: 'a' }
  const { store } = setup({ sessions: [session({ id: 'a' })] })
  store.set(reviewTurnAtom, turn)
  store.set(turnReviewOpenAtom, true)

  await act(async () => {
    store.set(activeRemoteAtom, 'someone/else')
  })

  expect(store.get(reviewTurnAtom)).toBeNull()
  expect(store.get(turnReviewOpenAtom)).toBe(false)
})

test('forgets a session’s spawn-time theme when it leaves the list', async () => {
  // The map is keyed by session id and nothing else prunes it, so entries would
  // pile up for the life of the window.
  const { store } = setup({ sessions: [session({ id: 'a' }), session({ id: 'b' })] })
  store.set(agentModeAtSpawnAtom, { a: 'dark', b: 'light' })
  await waitFor(() => expect(pushSessions).not.toBeNull())

  await act(async () => {
    pushSessions!([session({ id: 'b' })])
  })

  expect(store.get(agentModeAtSpawnAtom)).toEqual({ b: 'light' })
})
