/**
 * The rail's session orbs, while the nav is hidden: one per running session,
 * drawn with the chats section's own status rule, and a press opens it.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { agentSessionsAtom, type AgentSession } from '@/state/agent'
import { activeTab, workspaceAtom } from '@/state/panes'
import { SessionOrbs } from '../SessionOrbs'

const session = (over: Partial<AgentSession> & { id: string; name: string }): AgentSession => ({
  state: 'idle',
  ...over,
})

const open = vi.fn()
beforeEach(() => {
  open.mockReset()
  open.mockResolvedValue({ ok: true, terminalId: 't-a' })
  window.holi = { agent: { open: (args: unknown) => open(args) } } as never
})

function setup(sessions: AgentSession[]) {
  const store = createStore()
  store.set(agentSessionsAtom, sessions)
  render(
    <Provider store={store}>
      <SessionOrbs />
    </Provider>,
  )
  return store
}

test('one orb per live session', () => {
  setup([
    session({ id: 'a', name: 'Refactor' }),
    session({ id: 'b', name: 'Research', state: 'needs-you' }),
  ])
  expect(document.querySelectorAll('[data-session-orb]')).toHaveLength(2)
})

test('the orb says the state, in the colour the chats section uses', () => {
  setup([session({ id: 'b', name: 'Research', state: 'needs-you' })])
  const orb = screen.getByRole('button', { name: 'Research, needs you' })
  expect(orb.querySelector('span')).toHaveClass('bg-orange-500')
})

test('a press opens the session', async () => {
  const store = setup([session({ id: 'a', name: 'Refactor' })])
  await userEvent.setup().click(screen.getByRole('button', { name: /Refactor/ }))
  expect(open).toHaveBeenCalledWith({ attach: 'a', cols: 80, rows: 24 })
  await vi.waitFor(() =>
    expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'agent', id: 't-a' }),
  )
})
