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
  agentModeAtSpawnAtom,
  agentSessionsAtom,
  askTargetsAtom,
  defaultAgentTargetAtom,
  type AgentSession,
} from '../agent'
import {
  duplicateSessionAtom,
  sendToAgentAtom,
  showAgentAtom,
  startSessionAtom,
} from '../agent-send'
import { activeTab, openSession, workspaceAtom } from '../panes'
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
const duplicate = vi.fn()

beforeEach(() => {
  start.mockReset()
  paste.mockReset()
  start.mockResolvedValue({ ok: true, id: 'spawned' })
  paste.mockResolvedValue({ ok: true })
  duplicate.mockReset()
  duplicate.mockResolvedValue({ ok: true, id: 'copy' })
  window.holi = {
    agent: {
      start: (args: unknown) => start(args),
      paste: (id: string, text: string) => paste(id, text),
      duplicate: (id: string) => duplicate(id),
    },
  } as never
})

/** A store with a vault open and whatever sessions main has pushed. */
function storeWith(sessions: AgentSession[] = [], openTabs: string[] = []) {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(agentSessionsAtom, sessions)
  for (const id of openTabs) store.set(workspaceAtom, (w) => openSession(w, id))
  return store
}

/** The session tab showing, if the showing tab is a session at all. */
const shown = (store: ReturnType<typeof createStore>): string | null => {
  const tab = activeTab(store.get(workspaceAtom))
  return tab?.kind === 'session' ? tab.id : null
}

test('going to the agent with no sessions starts one', async () => {
  const store = storeWith([])
  store.set(showAgentAtom)

  await vi.waitFor(() =>
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ vaultId: REMOTE })),
  )
})

test('going to the agent opens the current session rather than starting one', () => {
  const store = storeWith([session({ id: 'a' })])
  store.set(showAgentAtom)

  expect(start).not.toHaveBeenCalled()
  expect(shown(store)).toBe('a')
})

test('going to the agent twice leaves you where it put you', () => {
  // A drawer was a thing to open and shut. A tab is a place to go, and the
  // second press must not undo the first.
  const store = storeWith([session({ id: 'a' })])
  store.set(showAgentAtom)
  store.set(showAgentAtom)

  expect(shown(store)).toBe('a')
  expect(store.get(workspaceAtom).panes[0]!.tabs).toHaveLength(1)
})

test('an exited session is not somewhere you can be sent to work', async () => {
  // A dead session is a record. Going to the agent should hand you something you
  // can type into.
  const store = storeWith([session({ id: 'a', exited: true })])
  store.set(showAgentAtom)
  await vi.waitFor(() => expect(start).toHaveBeenCalled())
})

test('a start shows the session it made, and makes only one', async () => {
  // A reconcile, or an ask sent to a new session, lands you in it: the tab is
  // opened for a session that exists, after it exists.
  const store = storeWith([])
  await store.set(startSessionAtom, { prompt: 'resolve the merge conflict' })

  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: 'resolve the merge conflict' }),
  )
  // And it lands you on the new tab.
  expect(store.get(activeSessionIdAtom)).toBe('spawned')
  expect(shown(store)).toBe('spawned')
})

test('a live target is pasted into, exactly once and with no submit', async () => {
  const store = storeWith([session({ id: 'a' }), session({ id: 'b' })])

  const res = await store.set(sendToAgentAtom, { text: 'what is this about?', target: 'b' })

  expect(res).toEqual({ ok: true })
  expect(paste).toHaveBeenCalledTimes(1)
  expect(paste).toHaveBeenCalledWith('b', 'what is this about?')
  // Main owns the bracketing and refuses to add an Enter; the renderer must not
  // have reached for `write` and done its own.
  expect(start).not.toHaveBeenCalled()
  // …and the tab it landed in is the one showing: an ask that arrives somewhere
  // you cannot see is an ask you will not answer.
  expect(store.get(activeSessionIdAtom)).toBe('b')
  expect(shown(store)).toBe('b')
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
  const store = storeWith([session({ id: 'a' })])

  const res = await store.set(sendToAgentAtom, { text: 'have a look', target: 'a' })

  expect(res.ok).toBe(false)
  expect(res.message).toBe('That session has ended. Pick another one.')
  // Nothing moved: the sender still has the text, and no tab opened to show a
  // failure.
  expect(shown(store)).toBeNull()
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

test('a duplicate lands you on the copy, with its own spawn-time theme', async () => {
  // Every spawn owes the app the same three things, and a fork is a spawn: main
  // makes it, the renderer shows it and remembers the mode it was born under.
  duplicate.mockResolvedValue({ ok: true, id: 'copy' })
  const store = storeWith([session({ id: 'a' })])

  const res = await store.set(duplicateSessionAtom, 'a')

  expect(res).toEqual({ ok: true })
  expect(duplicate).toHaveBeenCalledWith('a')
  expect(shown(store)).toBe('copy')
  expect(store.get(activeSessionIdAtom)).toBe('copy')
  expect(store.get(agentModeAtSpawnAtom)).toHaveProperty('copy')
})

test('a duplicate that main refuses says why, and shows nothing', async () => {
  duplicate.mockResolvedValue({ ok: false, message: 'Claude Code has not said which…' })
  const store = storeWith([session({ id: 'a' })])

  const res = await store.set(duplicateSessionAtom, 'a')

  expect(res).toEqual({ ok: false, message: 'Claude Code has not said which…' })
  expect(shown(store)).toBeNull()
})

test('a rename is the /rename command, pasted and not submitted', async () => {
  // The whole of Holi's rename: there is no shell route, so the command goes
  // into the session's box the way every other thing Holi sends does.
  const store = storeWith([session({ id: 'a', name: 'One' })])

  await store.set(sendToAgentAtom, { text: '/rename fix the merge', target: 'a' })

  expect(paste).toHaveBeenCalledWith('a', '/rename fix the merge')
  // …and the tab it went to is the one showing, because the Enter that finishes
  // the rename is one the user has to press there.
  expect(shown(store)).toBe('a')
})
