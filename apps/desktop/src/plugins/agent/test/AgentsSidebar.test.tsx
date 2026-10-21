/**
 * The Agents mode's sidebar: the Inbox with what needs you, the places other
 * plugins add beside it, their sections by order, then the live sessions as
 * cards (waiting on you first) under Sessions, with search; and the status the
 * mode toggle reports.
 */
import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, atom, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { AgentsSidebar } from '../renderer/agents/AgentsSidebar'
import { agentsStatusAtom, inboxCountAtom } from '../renderer/state/agents-status'
import { agentsViewAtom } from '../renderer/state/agents-view'
import { agentSessionsAtom } from '../renderer/state/sessions'

vi.mock('../renderer/agent-cap', () => ({ agentCap: {} }))
vi.mock('@/state/agents-slots', async (orig) => {
  const real = await orig<typeof import('@/state/agents-slots')>()
  return {
    ...real,
    agentsSlotsAtom: atom(() => [
      {
        plugin: 'automations',
        order: 10,
        nav: () => <span>Automations row</span>,
      },
      {
        plugin: 'holis',
        order: 20,
        sidebar: () => <section aria-label="Holis">A Holi row</section>,
        inbox: () => null,
        status: atom({ needsYou: 1, working: 0 }),
      },
      {
        plugin: 'chat',
        sidebar: () => <section aria-label="Chats">A chat row</section>,
        status: atom({ needsYou: 0, working: 1 }),
      },
    ]),
  }
})

function setup(sessions = true) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  if (sessions) {
    store.set(agentSessionsAtom, [
      { id: 'efgh5678', name: 'Notes pass', state: 'idle', startedAt: 1 },
      { id: 'abcd1234', name: 'Inbox cleanup', state: 'needs-you', waitingFor: 'Run holi?' },
      { id: 'w1', name: 'Drafting', state: 'working', model: 'Opus 5.5' },
    ])
  }
  render(
    <Provider store={store}>
      <AgentsSidebar />
    </Provider>,
  )
  return store
}

test('Inbox first, then the slots in order, then the sessions, then what comes after', () => {
  setup()
  expect(screen.getByRole('button', { name: /^Inbox/ })).toBeTruthy()
  expect(screen.getByText('Automations row')).toBeTruthy()
  const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
  expect(sections).toEqual(['Holis', 'Sessions', 'Chats'])
})

test('sessions are cards, waiting on you first, with the model and why it waits', () => {
  setup()
  const rows = within(screen.getByRole('region', { name: 'Sessions' }))
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('data-session-row'))
  expect(rows.map((r) => r.getAttribute('data-session-row'))).toEqual([
    'abcd1234',
    'w1',
    'efgh5678',
  ])
  expect(within(rows[0]!).getByText('Run holi?')).toBeTruthy()
  expect(within(rows[1]!).getByText('Opus 5.5')).toBeTruthy()
})

test('search narrows the sessions by name', async () => {
  setup()
  await userEvent.type(screen.getByLabelText('Search sessions'), 'notes')
  expect(screen.getByText('Notes pass')).toBeTruthy()
  expect(screen.queryByText('Drafting')).toBeNull()
})

test('opens what a row stands for', async () => {
  const store = setup()
  await userEvent.click(screen.getByText('Notes pass'))
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'session', id: 'efgh5678' })
  await userEvent.click(screen.getByRole('button', { name: /^Inbox/ }))
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'inbox' })
})

test('the toggle and the Inbox count sessions and slots alike', () => {
  const store = setup()
  expect(store.get(agentsStatusAtom)).toEqual({ needsYou: 2, working: 2 })
  // The chat slot has no Inbox rows, so its count is not the Inbox's.
  expect(store.get(inboxCountAtom)).toBe(2)
})

test('with no sessions, Sessions says how to start one', () => {
  setup(false)
  expect(screen.getByText('No sessions running')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /New session/ }).length).toBeGreaterThan(0)
})
