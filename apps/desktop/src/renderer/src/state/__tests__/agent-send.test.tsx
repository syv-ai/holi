/**
 * Starting a session, and sending one an ask (D100).
 *
 * These are store-level: nothing here renders, because none of it is about a
 * component any more. That is the change worth pinning — the drawer used to own
 * "open onto an empty list and start something", and an ask used to be a seed
 * atom the drawer noticed.
 */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  activeSessionIdAtom,
  agentPanelOpenAtom,
  agentSessionsAtom,
  askTargetsAtom,
  defaultAgentTargetAtom,
  type AgentSession,
} from '../agent'
import { sendToAgentAtom, showAgentPanelAtom, startSessionAtom } from '../agent-send'
import { activeRemoteAtom } from '../vaults'

const REMOTE = 'owner/repo'

const session = (over: Partial<AgentSession> & { id: string }): AgentSession => ({
  name: 'New session',
  state: 'idle',
  configStale: false,
  exited: false,
  ...over,
})

const start = vi.fn()
const paste = vi.fn()

beforeEach(() => {
  start.mockReset()
  paste.mockReset()
  start.mockResolvedValue({ ok: true, id: 'spawned' })
  paste.mockResolvedValue({ ok: true })
  window.holi = {
    agent: {
      start: (args: unknown) => start(args),
      paste: (id: string, text: string) => paste(id, text),
    },
  } as never
})

/** A store with a vault open and whatever sessions main has pushed. */
function storeWith(sessions: AgentSession[] = [], open = false) {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(agentSessionsAtom, sessions)
  store.set(agentPanelOpenAtom, open)
  return store
}

test('opening the drawer onto no sessions starts one', async () => {
  const store = storeWith([])
  store.set(showAgentPanelAtom, true)

  expect(store.get(agentPanelOpenAtom)).toBe(true)
  await vi.waitFor(() =>
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ vaultId: REMOTE })),
  )
})

test('opening the drawer with a session already running starts nothing', () => {
  const store = storeWith([session({ id: 'a' })])
  store.set(showAgentPanelAtom, true)
  expect(start).not.toHaveBeenCalled()
})

test('opening the drawer onto only an exited session starts one', async () => {
  // A dead tab is a record, not a session. Opening the drawer should hand you
  // something you can type into.
  const store = storeWith([session({ id: 'a', exited: true })])
  store.set(showAgentPanelAtom, true)
  await vi.waitFor(() => expect(start).toHaveBeenCalled())
})

test('closing the drawer starts nothing', () => {
  const store = storeWith([], true)
  store.set(showAgentPanelAtom, 'toggle')
  expect(store.get(agentPanelOpenAtom)).toBe(false)
  expect(start).not.toHaveBeenCalled()
})

test('a start opens the drawer BEFORE it spawns, and only makes one session', async () => {
  // The ordering is what keeps a reconcile (or an ask to a new session) from
  // becoming two tabs: it opens the drawer on its way, and the session it is
  // making is not in the pushed list yet.
  const store = storeWith([])
  const spawning = store.set(startSessionAtom, { prompt: 'resolve the merge conflict' })

  // Before the spawn has resolved, which is the half that matters.
  expect(store.get(agentPanelOpenAtom)).toBe(true)
  await spawning

  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: 'resolve the merge conflict' }),
  )
  // And it lands you on the new tab.
  expect(store.get(activeSessionIdAtom)).toBe('spawned')
})

test('a live target is pasted into, exactly once and with no submit', async () => {
  const store = storeWith([session({ id: 'a' }), session({ id: 'b' })], true)

  const res = await store.set(sendToAgentAtom, { text: 'what is this about?', target: 'b' })

  expect(res).toEqual({ ok: true })
  expect(paste).toHaveBeenCalledTimes(1)
  expect(paste).toHaveBeenCalledWith('b', 'what is this about?')
  // Main owns the bracketing and refuses to add an Enter; the renderer must not
  // have reached for `write` and done its own.
  expect(start).not.toHaveBeenCalled()
  // The drawer focuses that tab.
  expect(store.get(activeSessionIdAtom)).toBe('b')
  expect(store.get(agentPanelOpenAtom)).toBe(true)
})

test("a 'new' target spawns, named after the ask, with the ask as its paste", async () => {
  const store = storeWith([])

  await store.set(sendToAgentAtom, { text: 'Rewrite this paragraph\n\n> the quote', target: 'new' })

  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Rewrite this paragraph\n\n> the quote',
      paste: 'Rewrite this paragraph\n\n> the quote',
    }),
  )
  // The name is normalised in main (first line, collapsed, capped) and nowhere
  // else — a second copy of that rule in the renderer is a second thing to drift.
  expect(paste).not.toHaveBeenCalled()
})

test('a target that ended between picking and sending is refused, not dropped', async () => {
  paste.mockResolvedValue({ ok: false, message: 'That session has ended. Pick another one.' })
  const store = storeWith([session({ id: 'a' })], false)

  const res = await store.set(sendToAgentAtom, { text: 'have a look', target: 'a' })

  expect(res.ok).toBe(false)
  expect(res.message).toBe('That session has ended. Pick another one.')
  // Nothing moved: the sender still has the text, and the drawer did not take
  // over the screen to show a failure.
  expect(store.get(agentPanelOpenAtom)).toBe(false)
  expect(store.get(activeSessionIdAtom)).toBeNull()
})

test('a failed spawn comes back with why', async () => {
  start.mockResolvedValue({ ok: false, message: 'Claude CLI not found on PATH' })
  const store = storeWith([])

  const res = await store.set(sendToAgentAtom, { text: 'have a look', target: 'new' })

  expect(res).toEqual({ ok: false, message: 'Claude CLI not found on PATH' })
})

test('a session waiting on you is not offered as a target', () => {
  // It is blocked on a dialog of its own, so an ask sent to it waits behind that
  // dialog at best. Offering it is offering somewhere for text to disappear to.
  const store = storeWith([
    session({ id: 'a', name: 'One' }),
    session({ id: 'b', name: 'Two', state: 'needs-you' }),
    session({ id: 'c', name: 'Three', state: 'working' }),
  ])
  expect(store.get(askTargetsAtom)).toEqual([
    { id: 'a', name: 'One' },
    // Working is fine: a paste lands in the composer mid-turn (measured).
    { id: 'c', name: 'Three' },
  ])
})

test('an exited session is not offered either', () => {
  const store = storeWith([session({ id: 'a', name: 'One', exited: true })])
  expect(store.get(askTargetsAtom)).toEqual([])
})

test('the targets are in tab order', () => {
  const store = storeWith([session({ id: 'a', name: 'One' }), session({ id: 'b', name: 'Two' })])
  expect(store.get(askTargetsAtom).map((t) => t.id)).toEqual(['a', 'b'])
})

test('the default target is the tab you are looking at', () => {
  const store = storeWith([session({ id: 'a' }), session({ id: 'b' })])
  store.set(activeSessionIdAtom, 'b')
  expect(store.get(defaultAgentTargetAtom)).toBe('b')
})

test('the default target is a new session when the tab cannot read it', () => {
  // needs-you is blocked on a dialog and exited is gone; text sent to either
  // sits unread at best.
  const store = storeWith([session({ id: 'a', state: 'needs-you' })])
  store.set(activeSessionIdAtom, 'a')
  expect(store.get(defaultAgentTargetAtom)).toBe('new')

  const dead = storeWith([session({ id: 'a', exited: true })])
  expect(dead.get(defaultAgentTargetAtom)).toBe('new')
})
