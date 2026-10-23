/**
 * The page slot: the agent opens a session on whichever plugin's page fills
 * `agentPageAtom`, and with none it opens nothing and says why.
 */
import { atom, createStore } from 'jotai'
import { expect, test } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { agentPageAtom, type AgentPage, type AgentResult } from '../renderer/state/sessions'
import { followPendingOpen, openSessionAtom } from '../renderer/state/send'
import { pendingOpenAtom } from '../renderer/state/questions'

/** A page that remembers what it was asked to show. */
function fakePage(): { page: AgentPage; shown: () => string[] } {
  const shown: string[] = []
  const open = atom(null, (_get, _set, id: string): Promise<AgentResult> => {
    shown.push(id)
    return Promise.resolve({ ok: true })
  })
  return { page: { open }, shown: () => shown }
}

test('a session opens on the page there is', async () => {
  const store = createStore()
  const { page, shown } = fakePage()
  store.set(agentPageAtom, page)
  expect(await store.set(openSessionAtom, 'a')).toEqual({ ok: true })
  expect(shown()).toEqual(['a'])
})

test('with no page, opening a session is refused with the reason', async () => {
  const store = createStore()
  expect(await store.set(openSessionAtom, 'a')).toEqual({
    ok: false,
    message: expect.stringContaining('interface is off'),
  })
})

test("the quick panel's request waits for a page, then opens once", () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(pendingOpenAtom, { remote: 'o/vault', id: 'a' })
  const stop = followPendingOpen('o/vault', store)
  const { page, shown } = fakePage()
  expect(store.get(pendingOpenAtom)).not.toBeNull()
  store.set(agentPageAtom, page)
  expect(shown()).toEqual(['a'])
  expect(store.get(pendingOpenAtom)).toBeNull()
  store.set(agentPageAtom, null)
  store.set(agentPageAtom, page)
  expect(shown()).toEqual(['a'])
  stop()
})

test("another vault's request is left for that vault", () => {
  const store = createStore()
  const { page, shown } = fakePage()
  store.set(agentPageAtom, page)
  store.set(pendingOpenAtom, { remote: 'o/other', id: 'a' })
  const stop = followPendingOpen('o/vault', store)
  expect(shown()).toEqual([])
  expect(store.get(pendingOpenAtom)).not.toBeNull()
  stop()
})
