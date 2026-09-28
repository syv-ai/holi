/**
 * What you do to the vault's assistant (D110): the agents list, a session's
 * window, starting one, sending an ask. Store-level: nothing here renders,
 * because none of it belongs to a component.
 */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  agentSessionsAtom,
  agentTerminalsAtom,
  askTargetsAtom,
  defaultAgentTargetAtom,
  type AgentSession,
  type AgentTerminal,
} from '../agent'
import {
  duplicateSessionAtom,
  openSessionAtom,
  sendToAgentAtom,
  showAgentsAtom,
  startSessionAtom,
  stopSessionAtom,
} from '../agent-send'
import { activeTab, openAgentTab, workspaceAtom } from '../panes'
import { registerSessionTerminal } from '../../lib/session-terminals'

const session = (over: Partial<AgentSession> & { id: string }): AgentSession => ({
  name: 'New session',
  state: 'idle',
  ...over,
})

const terminal = (id: string, launchedFor: string | null, title = ''): AgentTerminal => ({
  id,
  launchedFor,
  title,
})

const open = vi.fn()
const start = vi.fn()
const send = vi.fn()
const stop = vi.fn()
const duplicate = vi.fn()

beforeEach(() => {
  for (const fn of [open, start, send, stop, duplicate]) fn.mockReset()
  open.mockResolvedValue({ ok: true, terminalId: 'opened' })
  start.mockResolvedValue({ ok: true, sessionId: 'newnew00', terminalId: 'started' })
  send.mockResolvedValue({ ok: true, terminalId: 'sent' })
  stop.mockResolvedValue({ ok: true })
  duplicate.mockResolvedValue({ ok: true, sessionId: 'copy0000', terminalId: 'copied' })
  window.holi = {
    agent: {
      open: (args: unknown) => open(args),
      start: (args: unknown) => start(args),
      send: (args: unknown) => send(args),
      stop: (id: string) => stop(id),
      duplicate: (id: string, geometry: unknown) => duplicate(id, geometry),
    },
  } as never
})

/** A store with whatever sessions and terminals main has pushed. */
function storeWith(sessions: AgentSession[] = [], terminals: AgentTerminal[] = []) {
  const store = createStore()
  store.set(agentSessionsAtom, sessions)
  store.set(agentTerminalsAtom, terminals)
  return store
}

/** The agent tab showing, if the showing tab is one at all. */
const shown = (store: ReturnType<typeof createStore>): string | null => {
  const tab = activeTab(store.get(workspaceAtom))
  return tab?.kind === 'agent' ? tab.id : null
}

test('going to the agents opens the list when Holi has none open', async () => {
  const store = storeWith()
  await store.set(showAgentsAtom)

  expect(open).toHaveBeenCalledWith({ cols: 80, rows: 24 })
  expect(shown(store)).toBe('opened')
})

test('going to the agents focuses the list that is already open', async () => {
  const store = storeWith([], [terminal('t-attach', 'aaaaaaaa'), terminal('t-list', null)])
  await store.set(showAgentsAtom)

  expect(open).not.toHaveBeenCalled()
  expect(shown(store)).toBe('t-list')
})

test('going to the agents skips a list terminal that has since attached a session', async () => {
  // `←` and Enter move a terminal between the list and a session: its title,
  // not its launch, says which it shows.
  const store = storeWith(
    [],
    [
      terminal('t-was-list', null, 'check123 (copy)'),
      terminal('t-now-list', 'aaaaaaaa', '1 awaiting input · claude agents'),
    ],
  )
  await store.set(showAgentsAtom)

  expect(open).not.toHaveBeenCalled()
  expect(shown(store)).toBe('t-now-list')
})

test('going to the agents twice leaves you where it put you', async () => {
  // A tab is a place to go: the second press must not undo the first.
  const store = storeWith([], [terminal('t-list', null)])
  await store.set(showAgentsAtom)
  await store.set(showAgentsAtom)

  expect(shown(store)).toBe('t-list')
  expect(store.get(workspaceAtom).panes[0]!.tabs).toHaveLength(1)
})

test('opening a session reuses the window Holi opened for it', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })], [terminal('t-a', 'aaaaaaaa')])
  await store.set(openSessionAtom, 'aaaaaaaa')

  expect(open).not.toHaveBeenCalled()
  expect(shown(store)).toBe('t-a')
})

test('opening a session with no window attaches a new one', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })])
  await store.set(openSessionAtom, 'aaaaaaaa')

  expect(open).toHaveBeenCalledWith({ attach: 'aaaaaaaa', cols: 80, rows: 24 })
  expect(shown(store)).toBe('opened')
})

test('an ask goes to main unsent, and its window comes forward with the keyboard', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })])
  const focus = vi.fn()
  const unregister = registerSessionTerminal('sent', focus)

  const res = await store.set(sendToAgentAtom, { text: 'look at this', target: 'aaaaaaaa' })

  expect(res).toEqual({ ok: true })
  expect(send).toHaveBeenCalledWith({
    text: 'look at this',
    target: 'aaaaaaaa',
    cols: 80,
    rows: 24,
  })
  expect(shown(store)).toBe('sent')
  expect(focus).toHaveBeenCalled()
  unregister()
})

test('a refused ask says why and opens nothing, so the sender keeps the text', async () => {
  send.mockResolvedValue({ ok: false, message: 'That session has ended. Pick another one.' })
  const store = storeWith()

  const res = await store.set(sendToAgentAtom, { text: 'x', target: 'aaaaaaaa' })

  expect(res).toEqual({ ok: false, message: 'That session has ended. Pick another one.' })
  expect(shown(store)).toBeNull()
})

test('starting a session opens its window', async () => {
  const store = storeWith()
  await store.set(startSessionAtom, { name: 'Tidy' })

  expect(start).toHaveBeenCalledWith({ name: 'Tidy', cols: 80, rows: 24 })
  expect(shown(store)).toBe('started')
})

test('stop goes to main and answers what it said', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })])
  expect(await store.set(stopSessionAtom, 'aaaaaaaa')).toEqual({ ok: true })
  expect(stop).toHaveBeenCalledWith('aaaaaaaa')
})

test('duplicate opens the copy', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })])
  await store.set(duplicateSessionAtom, 'aaaaaaaa')
  expect(shown(store)).toBe('copied')
})

test('an ask may go to any live session not waiting on a question of its own', () => {
  const store = storeWith([
    session({ id: 'a', name: 'one' }),
    session({ id: 'b', name: 'two', state: 'needs-you' }),
    session({ id: 'c', name: 'three', state: 'working' }),
  ])
  expect(store.get(askTargetsAtom)).toEqual([
    { id: 'a', name: 'one' },
    { id: 'c', name: 'three' },
  ])
})

test('the default target is the session the showing tab was opened for', () => {
  const store = storeWith(
    [session({ id: 'a' }), session({ id: 'b' })],
    [terminal('t-a', 'a'), terminal('t-b', 'b')],
  )
  store.set(workspaceAtom, (w) => openAgentTab(w, 't-a'))
  expect(store.get(defaultAgentTargetAtom)).toBe('a')
})

test('the default target is a new session when there is none, or it needs you', () => {
  expect(storeWith().get(defaultAgentTargetAtom)).toBe('new')
  const waiting = storeWith([session({ id: 'a', state: 'needs-you' })], [terminal('t-a', 'a')])
  waiting.set(workspaceAtom, (w) => openAgentTab(w, 't-a'))
  expect(waiting.get(defaultAgentTargetAtom)).toBe('new')
})

test('a list tab has no session of its own, so the default falls back to the last one opened', () => {
  const store = storeWith([session({ id: 'a' })], [terminal('t-a', 'a'), terminal('t-list', null)])
  store.set(workspaceAtom, (w) => openAgentTab(w, 't-list'))
  expect(store.get(defaultAgentTargetAtom)).toBe('a')
})
