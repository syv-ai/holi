/**
 * The Agents mode's sidebar: the vault's scheduled Holis and Holis with their
 * mascots, the live
 * background sessions grouped by what they need from you (a Holi's runs shown
 * under their Holi, not again), and what other plugins add through the slot;
 * and the status the mode toggle reports.
 */
import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, atom, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { activeRemoteAtom, agentsSlotsAtom } from '@/plugin-api'
import { AgentsSidebar } from '../renderer/agents/AgentsSidebar'
import { agentsStatusAtom } from '../renderer/state/agents-status'
import { agentsViewAtom } from '../renderer/state/agents-view'
import { holisAtom, holisLoadedAtom, type HoliSummary } from '../renderer/state/holis'
import { agentSessionsAtom } from '../renderer/state/sessions'

vi.mock('../renderer/agents-cap', () => ({ holiCap: { list: vi.fn() } }))
vi.mock('../renderer/agent-cap', () => ({ agentCap: {} }))
vi.mock('@/state/agents-slots', async (orig) => {
  const real = await orig<typeof import('@/state/agents-slots')>()
  return {
    ...real,
    agentsSlotsAtom: atom(() => [
      {
        plugin: 'chat',
        sidebar: () => <section aria-label="Chats">A chat row</section>,
        status: atom({ needsYou: 1, working: 0 }),
      },
    ]),
  }
})

const ada: HoliSummary = {
  id: 'ada',
  path: '.holi/holis/ada.yaml',
  local: false,
  kind: 'triggered',
  name: 'Ada',
  status: 'approved',
  mascot: 'invader',
  color: '#a5a1ff',
  description: 'Briefs a customer note',
  accepts: [],
  allow: [],
  instructions: 'Write the brief.',
  unknownKeys: [],
  fingerprint: 'f',
  runs: [{ jobId: 'run1', at: '2026-10-08T08:00:00.000Z', path: 'kunder/a.md' }],
}

const tidy: HoliSummary = {
  ...ada,
  id: 'tidy',
  path: '.holi/holis/tidy.yaml',
  kind: 'scheduled',
  name: 'Tidy',
  status: 'cloud',
  when: 'Every day at 03:00',
  runs: [],
}

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(holisLoadedAtom, 'ready')
  store.set(holisAtom, [ada, tidy])
  store.set(agentSessionsAtom, [
    { id: 'run1', name: 'Ada · 08:00', state: 'working' },
    { id: 'abcd1234', name: 'Inbox cleanup', state: 'needs-you', waitingFor: 'Run holi?' },
    { id: 'efgh5678', name: 'Notes pass', state: 'idle' },
  ])
  render(
    <Provider store={store}>
      <AgentsSidebar />
    </Provider>,
  )
  return store
}

test('lists Holis with their state, and live sessions by what they need, a run only once', () => {
  setup()
  // Scheduled Holis come first, then the Holis sent work.
  const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
  expect(sections.slice(0, 2)).toEqual(['Scheduled Holis', 'Holis'])
  expect(
    within(screen.getByRole('region', { name: 'Scheduled Holis' })).getByText('Tidy'),
  ).toBeTruthy()
  expect(screen.getByLabelText('Ada, working')).toBeTruthy()
  const needs = screen.getByRole('region', { name: 'Needs you' })
  expect(within(needs).getByText('Inbox cleanup')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Idle' })).getByText('Notes pass')).toBeTruthy()
  // Ada's run is Ada's: not a session row as well.
  expect(screen.queryByText('Ada · 08:00')).toBeNull()
  // What another plugin adds, through the slot.
  expect(screen.getByRole('region', { name: 'Chats' })).toBeTruthy()
})

test('opens what a row stands for', async () => {
  const store = setup()
  await userEvent.click(screen.getByLabelText('Ada, working'))
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'holi', id: 'ada' })
  await userEvent.click(screen.getByText('Notes pass'))
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'session', id: 'efgh5678' })
})

test('the toggle counts Holis, sessions and slots alike, each run once', () => {
  const store = setup()
  expect(store.get(agentsStatusAtom)).toEqual({ needsYou: 2, working: 1 })
})

test('an empty vault says how to start, and Holis offer to make one', () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(holisLoadedAtom, 'ready')
  render(
    <Provider store={store}>
      <AgentsSidebar />
    </Provider>,
  )
  expect(screen.getByText(/No sessions are running/)).toBeTruthy()
  expect(screen.getByText('Make a Holi for this vault')).toBeTruthy()
})
