/**
 * Whose chat the person is looking at, as main is told it: what makes a
 * session watched (no needs-you banner while Holi has the focus), never a
 * terminal Holi keeps open behind a chat.
 */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { quickChatAtom, reportWatching, watchedSessionAtom } from '../renderer/state/notices'
import { agentSessionsAtom, type AgentSession } from '../../agent/renderer/public'
import { agentViewAtom, overviewSelectionAtom } from '../renderer/state/page'
import { activeRemoteAtom, openNoteTabAtom, openSurfaceAtom } from '@/plugin-api'

const watching = vi.fn()
vi.mock('../../agent/renderer/agent-cap', () => ({
  agentCap: {
    watching: (remote: string, args: { id: string | null }) => watching(remote, args.id),
  },
}))

beforeEach(() => {
  watching.mockReset()
  watching.mockResolvedValue(null)
})

const session = (id: string): AgentSession => ({ id, name: id, state: 'idle', startedAt: 1 })

function storeWith(...ids: string[]) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(agentSessionsAtom, ids.map(session))
  return store
}

test('a chat is watched while the agents page shows it, or its smaller chat is open', () => {
  const store = storeWith('aaaa0001', 'bbbb0002')
  expect(store.get(watchedSessionAtom)).toBeNull()

  store.set(overviewSelectionAtom, 'bbbb0002')
  store.set(openSurfaceAtom, 'agent')
  expect(store.get(watchedSessionAtom)).toBe('bbbb0002')

  // The history is not a chat.
  store.set(agentViewAtom, 'history')
  expect(store.get(watchedSessionAtom)).toBeNull()

  // Another tab: only a smaller chat is looked at there.
  store.set(agentViewAtom, 'chat')
  store.set(openNoteTabAtom, 'notes/a.md')
  expect(store.get(watchedSessionAtom)).toBeNull()
  store.set(quickChatAtom, 'aaaa0001')
  expect(store.get(watchedSessionAtom)).toBe('aaaa0001')
})

test('main is told now, on each change, and that nothing is watched on the way out', () => {
  const store = storeWith('aaaa0001')
  const stop = reportWatching('o/vault', store)
  expect(watching).toHaveBeenLastCalledWith('o/vault', null)

  store.set(quickChatAtom, 'aaaa0001')
  expect(watching).toHaveBeenLastCalledWith('o/vault', 'aaaa0001')
  const calls = watching.mock.calls.length
  // A change that leaves the same chat showing says nothing new.
  store.set(agentSessionsAtom, [session('aaaa0001'), session('bbbb0002')])
  expect(watching).toHaveBeenCalledTimes(calls)

  stop()
  expect(watching).toHaveBeenLastCalledWith('o/vault', null)
})
