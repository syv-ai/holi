/**
 * What you do to the vault's assistant: the agents page, a session's chat,
 * starting one, sending an ask. Store-level: nothing here renders,
 * because none of it belongs to a component.
 */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  agentHistoryAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  askTargetsAtom,
  chatDraftsAtom,
  defaultAgentTargetAtom,
  overviewSelectionAtom,
  type AgentSession,
  type AgentTerminal,
} from '../renderer/state/sessions'
import {
  duplicateSessionAtom,
  openSessionAtom,
  sendToAgentAtom,
  showAgentsAtom,
  startSessionAtom,
  stopSessionAtom,
} from '../renderer/state/send'
import { activeRemoteAtom, surfaceTabIdsAtom } from '@/plugin-api'

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

vi.mock('../renderer/agent-cap', () => ({
  agentCap: {
    open: (_remote: string, args: unknown) => open(args),
    start: (_remote: string, args: unknown) => start(args),
    send: (_remote: string, args: unknown) => send(args),
    stop: (_remote: string, { id }: { id: string }) => stop(id),
    duplicate: (_remote: string, args: unknown) => duplicate(args),
  },
}))

beforeEach(() => {
  for (const fn of [open, start, send, stop, duplicate]) fn.mockReset()
  open.mockResolvedValue({ ok: true, terminalId: 'opened' })
  start.mockResolvedValue({ ok: true, sessionId: 'newnew00', terminalId: 'started' })
  send.mockResolvedValue({ ok: true, terminalId: 'sent' })
  stop.mockResolvedValue({ ok: true })
  duplicate.mockResolvedValue({ ok: true, sessionId: 'copy0000', terminalId: 'copied' })
})

/** A store with whatever sessions and terminals main has pushed. */
function storeWith(sessions: AgentSession[] = [], terminals: AgentTerminal[] = []) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(agentSessionsAtom, sessions)
  store.set(agentTerminalsAtom, terminals)
  return store
}

/** The session whose chat the page is on, if one was opened. */
const shown = (store: ReturnType<typeof createStore>): string | null =>
  store.get(overviewSelectionAtom)

test('going to the agents opens the page and nothing else', async () => {
  const store = storeWith()
  await store.set(showAgentsAtom)

  expect(open).not.toHaveBeenCalled()
  expect(store.get(surfaceTabIdsAtom('agent'))).toEqual([])
  expect(shown(store)).toBeNull()
})

test('opening a session shows its chat, and opens no terminal', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })], [terminal('t-a', 'aaaaaaaa')])
  await store.set(openSessionAtom, 'aaaaaaaa')

  expect(open).not.toHaveBeenCalled()
  expect(shown(store)).toBe('aaaaaaaa')
})

test('an ask becomes a draft in the chat, and the chat comes forward', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })])

  const res = await store.set(sendToAgentAtom, { text: 'look at this', target: 'aaaaaaaa' })

  expect(res).toEqual({ ok: true })
  expect(store.get(chatDraftsAtom)).toEqual({ aaaaaaaa: 'look at this' })
  expect(shown(store)).toBe('aaaaaaaa')
  // Unsent: nothing goes to main, and no terminal gets a paste.
  expect(send).not.toHaveBeenCalled()
})

test('an ask for a new session starts one and drafts it there', async () => {
  const store = storeWith()
  await store.set(sendToAgentAtom, { text: 'Tidy up', target: 'new' })

  expect(start).toHaveBeenCalledWith({ name: 'Tidy up', cols: 80, rows: 24 })
  expect(store.get(chatDraftsAtom)).toEqual({ newnew00: 'Tidy up' })
  expect(shown(store)).toBe('newnew00')
})

test('an ask for a session that has ended is refused, so the sender keeps the text', async () => {
  const store = storeWith()

  const res = await store.set(sendToAgentAtom, { text: 'x', target: 'aaaaaaaa' })

  expect(res).toEqual({ ok: false, message: 'That session has ended. Pick another one.' })
  expect(shown(store)).toBeNull()
})

test('starting a session shows its chat', async () => {
  const store = storeWith()
  await store.set(startSessionAtom, { name: 'Tidy' })

  expect(start).toHaveBeenCalledWith({ name: 'Tidy', cols: 80, rows: 24 })
  expect(shown(store)).toBe('newnew00')
})

test('stop goes to main and answers what it said', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })])
  expect(await store.set(stopSessionAtom, 'aaaaaaaa')).toEqual({ ok: true })
  expect(stop).toHaveBeenCalledWith('aaaaaaaa')
})

test('duplicate shows the copy', async () => {
  const store = storeWith([session({ id: 'aaaaaaaa' })])
  await store.set(duplicateSessionAtom, 'aaaaaaaa')
  expect(shown(store)).toBe('copy0000')
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

test('the default target is the session whose chat is showing', () => {
  const store = storeWith([session({ id: 'a' }), session({ id: 'b' })])
  store.set(overviewSelectionAtom, 'b')
  expect(store.get(defaultAgentTargetAtom)).toBe('b')
})

test('with none picked, the default target is the most recent session', () => {
  const store = storeWith([session({ id: 'a', startedAt: 1 }), session({ id: 'b', startedAt: 2 })])
  expect(store.get(defaultAgentTargetAtom)).toBe('b')
})

test('the default target is a new session when there is none, it needs you, or it has finished', () => {
  expect(storeWith().get(defaultAgentTargetAtom)).toBe('new')
  const waiting = storeWith([session({ id: 'a', state: 'needs-you' })])
  expect(waiting.get(defaultAgentTargetAtom)).toBe('new')
  const finished = storeWith()
  finished.set(agentHistoryAtom, [{ id: 'p', name: 'Old', phase: 'done' }])
  expect(finished.get(defaultAgentTargetAtom)).toBe('new')
})
