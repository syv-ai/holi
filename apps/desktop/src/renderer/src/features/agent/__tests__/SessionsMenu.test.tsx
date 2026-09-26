/**
 * The sessions menu the tab strip shows while the nav is hidden: every
 * session, opened the way its row in the nav opens it, and a new one.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, atom, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { activeSessionIdAtom, agentSessionsAtom, type AgentSession } from '@/state/agent'
import { activeTab, workspaceAtom } from '@/state/panes'
import { SessionsMenu } from '../SessionsMenu'

const { started } = vi.hoisted(() => ({ started: vi.fn() }))
vi.mock('@/state/agent-send', () => ({
  startSessionAtom: atom(null, () => started()),
}))

const session = (id: string, name: string): AgentSession => ({
  id,
  name,
  state: 'idle',
  configStale: false,
  exited: false,
})

function setup(sessions: AgentSession[]) {
  const store = createStore()
  store.set(agentSessionsAtom, sessions)
  render(
    <Provider store={store}>
      <SessionsMenu />
    </Provider>,
  )
  return store
}

test('lists every session, and picking one opens its tab', async () => {
  const store = setup([session('a', 'Refactor'), session('b', 'Research')])
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'chats' }))
  await user.click(screen.getByRole('menuitem', { name: 'Research' }))

  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'session', id: 'b' })
  expect(store.get(activeSessionIdAtom)).toBe('b')
})

test('starts a new session', async () => {
  started.mockClear()
  setup([])
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'chats' }))
  await user.click(screen.getByRole('menuitem', { name: 'New session' }))
  expect(started).toHaveBeenCalledOnce()
})
