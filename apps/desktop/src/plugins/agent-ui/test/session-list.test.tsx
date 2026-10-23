/**
 * Where this machine lists the sessions (`sessionList`): the stack of bubbles
 * over every tab by default, or rows in the sidebar, never both. The notices
 * float in the corner either way.
 */
import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, surfaceActiveAtom } from '@/plugin-api'
import { pluginSettingValue } from '@holi/shared'
import { agentSessionsAtom, type AgentSession } from '../../agent/renderer/public'
import { AGENT_UI_INFO } from '../info'
import { AgentBubbles } from '../renderer/AgentBubbles'
import { SessionRows } from '../renderer/SessionRows'
import { overviewSelectionAtom } from '../renderer/state/page'

const mode = vi.hoisted(() => ({ value: 'bubbles' as 'bubbles' | 'sidebar' }))
vi.mock('../renderer/state/session-list', () => ({ useSessionList: () => mode.value }))

beforeEach(() => {
  mode.value = 'bubbles'
})

const SESSIONS: AgentSession[] = [
  { id: 'a', name: 'Travel agent', state: 'working', startedAt: 2 },
  { id: 'b', name: 'Tidy up', state: 'idle', phase: 'done', startedAt: 1 },
]

function draw() {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(agentSessionsAtom, SESSIONS)
  const { container } = render(
    <Provider store={store}>
      <AgentBubbles />
      <SessionRows />
    </Provider>,
  )
  return { store, container, user: userEvent.setup() }
}

test('a machine that chose nothing gets the bubbles, on its own machine only', () => {
  const setting = AGENT_UI_INFO.settings?.find((s) => s.key === 'sessionList')
  expect(setting).toMatchObject({ default: 'bubbles', target: 'local' })
  expect(pluginSettingValue({}, AGENT_UI_INFO, 'sessionList')).toBe('bubbles')
})

test('with the bubbles, the stack floats and the sidebar has no rows', () => {
  const { container } = draw()
  expect(container.querySelector('[data-agent-stack]')).not.toBeNull()
  expect(container.querySelector('[data-session-rows]')).toBeNull()
})

test('with the sidebar, the sessions are rows there and no stack floats', async () => {
  mode.value = 'sidebar'
  const { container, store, user } = draw()
  expect(container.querySelector('[data-agent-stack]')).toBeNull()
  const rows = container.querySelector<HTMLElement>('[data-session-rows]')
  expect(rows).not.toBeNull()
  expect(within(rows!).getByText('Travel agent')).toBeInTheDocument()
  // The notices still have their corner.
  expect(container.querySelector('[data-agent-notices]')).not.toBeNull()

  // A row opens the full chat on the agents page.
  await user.click(screen.getByText('Tidy up'))
  expect(store.get(overviewSelectionAtom)).toBe('b')
  expect(store.get(surfaceActiveAtom('agent'))).toBe(true)
})
