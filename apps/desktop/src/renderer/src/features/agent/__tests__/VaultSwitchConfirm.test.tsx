/**
 * The question a vault switch asks when sessions are running in the vault being
 * left (D100).
 *
 * What it owes the user is an accurate sentence about what they are about to
 * lose, so the cases are what it says for one session against several, and that
 * both answers reach the caller — Shell holds the switch itself, and a cancel
 * that silently switched anyway would be worse than never asking.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { VaultSwitchConfirm } from '../VaultSwitchConfirm'
import { agentSessionsAtom, type AgentSession } from '@/state/agent'

const session = (over: Partial<AgentSession> & { id: string }): AgentSession => ({
  name: 'New session',
  state: 'working',
  configStale: false,
  exited: false,
  ...over,
})

function setup(sessions: AgentSession[]) {
  const store = createStore()
  store.set(agentSessionsAtom, sessions)
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <Provider store={store}>
      <VaultSwitchConfirm onConfirm={onConfirm} onCancel={onCancel} />
    </Provider>,
  )
  return { onConfirm, onCancel }
}

test('names the one session that is in the way', async () => {
  setup([session({ id: 'a', name: 'Fix the merge' })])
  expect(await screen.findByText(/Fix the merge is part way through a turn/)).toBeInTheDocument()
})

test('says what a session waiting on you is waiting for you to do', async () => {
  setup([session({ id: 'a', name: 'Fix the merge', state: 'needs-you' })])
  expect(await screen.findByText(/waiting for you to answer something/)).toBeInTheDocument()
})

test('counts rather than lists when there are several', async () => {
  // Three names in a sentence is a list to read, and the sidebar is already
  // showing them.
  setup([
    session({ id: 'a', name: 'Fix the merge' }),
    session({ id: 'b', name: 'Notes', state: 'needs-you' }),
  ])
  expect(await screen.findByText(/2 sessions are still running/)).toBeInTheDocument()
})

test('leaves an idle session out of the count', async () => {
  setup([session({ id: 'a', name: 'Fix the merge' }), session({ id: 'b', state: 'idle' })])
  expect(await screen.findByText(/Fix the merge is part way through a turn/)).toBeInTheDocument()
})

test('says every session ends, not only the busy one', async () => {
  setup([session({ id: 'a', name: 'Fix the merge' })])
  expect(await screen.findByText(/ends every session in this vault/)).toBeInTheDocument()
})

test('confirming hands the switch back to the caller', async () => {
  const { onConfirm, onCancel } = setup([session({ id: 'a' })])
  await userEvent.click(await screen.findByRole('button', { name: 'Switch anyway' }))
  expect(onConfirm).toHaveBeenCalled()
  expect(onCancel).not.toHaveBeenCalled()
})

test('cancelling switches nothing', async () => {
  const { onConfirm, onCancel } = setup([session({ id: 'a' })])
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  expect(onCancel).toHaveBeenCalled()
  expect(onConfirm).not.toHaveBeenCalled()
})
