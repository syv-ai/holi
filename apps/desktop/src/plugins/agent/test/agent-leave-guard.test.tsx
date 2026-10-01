/**
 * What the agent says leaving the vault costs: the sessions that are in the
 * way, in one accurate sentence.
 */
import { createStore } from 'jotai'
import { expect, test } from 'vitest'
import {
  agentLeaveGuardAtom,
  agentSessionsAtom,
  type AgentSession,
} from '../renderer/state/sessions'

const session = (over: Partial<AgentSession> & { id: string }): AgentSession => ({
  name: 'New session',
  state: 'working',
  ...over,
})

function guard(sessions: AgentSession[]): string | null {
  const store = createStore()
  store.set(agentSessionsAtom, sessions)
  return store.get(agentLeaveGuardAtom)
}

test('names the one session that is in the way', () => {
  expect(guard([session({ id: 'a', name: 'Fix the merge' })])).toMatch(
    /Fix the merge is part way through a turn/,
  )
})

test('says what a session waiting on you is waiting for you to do', () => {
  expect(guard([session({ id: 'a', name: 'Fix the merge', state: 'needs-you' })])).toMatch(
    /waiting for you to answer something/,
  )
})

test('counts rather than lists when there are several', () => {
  // Three names in a sentence is a list to read, and the sidebar is already
  // showing them.
  const said = guard([
    session({ id: 'a', name: 'Fix the merge' }),
    session({ id: 'b', name: 'Notes', state: 'needs-you' }),
  ])
  expect(said).toMatch(/2 sessions are still running/)
})

test('leaves an idle session out, and says nothing with only idle ones', () => {
  expect(
    guard([session({ id: 'a', name: 'Fix the merge' }), session({ id: 'b', state: 'idle' })]),
  ).toMatch(/Fix the merge is part way through a turn/)
  expect(guard([session({ id: 'b', state: 'idle' })])).toBeNull()
})

test('says every session ends, and where the conversations stay', () => {
  const said = guard([session({ id: 'a', name: 'Fix the merge' })])
  expect(said).toMatch(/stops every session in it/)
  expect(said).toMatch(/stays in the agents list/)
})
