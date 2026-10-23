/**
 * The Agents mode's sidebar: the conversation search on top, the Inbox with
 * what needs you, the places other plugins add beside it, their sections by
 * order, then one session list of every conversation and run (the slots' rows
 * and the live sessions) as cards, what needs you pinned first; and the
 * status the mode toggle reports.
 */
import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore, type PrimitiveAtom } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, agentsSelectionAtom, type AgentsSessionItem } from '@/plugin-api'
import { AgentsSidebar } from '../renderer/agents/AgentsSidebar'
import { agentsStatusAtom, inboxCountAtom } from '../renderer/state/agents-status'
import { agentsViewAtom } from '../renderer/state/agents-view'
import { NO_FILTER, sessionFilterAtom, sessionsSeenAtom } from '../renderer/state/session-list'
import { agentSessionsAtom } from '../renderer/state/sessions'

vi.mock('../renderer/agent-cap', () => ({ agentCap: {} }))
vi.mock('@/state/agents-slots', async (orig) => {
  const real = await orig<typeof import('@/state/agents-slots')>()
  const { atom } = await import('jotai')
  const chatItems = atom<AgentsSessionItem[]>([])
  const chatStatus = atom<'loading' | 'ready' | 'error'>('ready')
  const reloads = atom(0)
  const reload = atom(null, (_get, set) => set(reloads, (n) => n + 1))
  const create = atom(null, (_get, set) =>
    set(real.agentsSelectionAtom, { owner: 'chat', id: 'new' }),
  )
  const archive = atom(null, () => {})
  return {
    ...real,
    __test: { chatItems, chatStatus, reloads },
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
        status: atom({ needsYou: 0, working: 1 }),
        sessions: { items: chatItems, status: chatStatus, reload, create, archive },
      },
    ]),
  }
})

// The mock's own atoms, reached as the mocked module (a dynamic import: a
// plugin's code imports core only through @/plugin-api).
const slots: unknown = await import('@/state/agents-slots')
const fixtures = (
  slots as {
    __test: {
      chatItems: PrimitiveAtom<AgentsSessionItem[]>
      chatStatus: PrimitiveAtom<'loading' | 'ready' | 'error'>
      reloads: PrimitiveAtom<number>
    }
  }
).__test

beforeEach(() => localStorage.clear())

const NOW = Date.now()

const chat = (id: string, over: Partial<AgentsSessionItem> = {}): AgentsSessionItem => ({
  key: `chat:${id}`,
  selection: { owner: 'chat', id },
  title: `Chat ${id}`,
  state: 'idle',
  updatedAt: NOW - 60_000,
  ...over,
})

function setup({
  sessions = true,
  chats = [
    chat('c1', { title: 'Drafting the plan', state: 'working', model: 'opus' }),
    chat('c2', { title: 'Weekly review', endedAt: NOW - 30_000, updatedAt: NOW - 30_000 }),
    chat('c3', { title: 'Old notes', archived: true }),
  ],
  status = 'ready' as 'loading' | 'ready' | 'error',
} = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/notes')
  store.set(sessionsSeenAtom, { since: 0, seen: {} })
  store.set(sessionFilterAtom, NO_FILTER)
  store.set(fixtures.chatItems, chats)
  store.set(fixtures.chatStatus, status)
  if (sessions) {
    store.set(agentSessionsAtom, [
      { id: 'abcd1234', name: 'Inbox cleanup', state: 'needs-you', waitingFor: 'Run holi?' },
      { id: 'efgh5678', name: 'Notes pass', state: 'idle', startedAt: NOW - 120_000 },
    ])
  }
  render(
    <Provider store={store}>
      <AgentsSidebar />
    </Provider>,
  )
  return store
}

const cards = () =>
  within(screen.getByRole('region', { name: 'Sessions' }))
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('data-session-card'))

const cardKeys = () => cards().map((c) => c.getAttribute('data-session-card'))

test('search first, then the Inbox, the slots in order, then the sessions', () => {
  setup()
  expect(screen.getByLabelText('Search conversations')).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Inbox( \d+)?$/ })).toBeTruthy()
  expect(screen.getByText('Automations row')).toBeTruthy()
  const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
  expect(sections).toEqual(['Holis', 'Sessions'])
})

test('one list of chats and live sessions, what needs you pinned first, archived left out', () => {
  setup()
  expect(cardKeys()).toEqual(['agent:abcd1234', 'chat:c2', 'chat:c1', 'agent:efgh5678'])
  const groups = within(screen.getByRole('region', { name: 'Sessions' }))
    .getAllByRole('group')
    .map((g) => g.getAttribute('aria-label'))
  expect(groups).toEqual(['Needs you', 'Today'])
})

test('each state reads in words, never colour alone', () => {
  setup()
  const [asks, done, working, read] = cards()
  expect(asks!.getAttribute('aria-label')).toBe('Inbox cleanup, needs you: Run holi?')
  expect(within(asks!).getByText('Needs you')).toBeTruthy()
  expect(within(working!).getByText('Working')).toBeTruthy()
  expect(within(working!).getByText('Opus')).toBeTruthy()
  expect(done!.getAttribute('aria-label')).toBe('Weekly review, done, not opened yet')
  expect(read!.getAttribute('aria-label')).toBe('Notes pass')
  // Where it runs: the vault.
  expect(within(read!).getByText('notes')).toBeTruthy()
})

test('opening a done row marks it read, and selects what it stands for', async () => {
  const store = setup()
  await userEvent.click(screen.getByRole('button', { name: /^Weekly review/ }))
  expect(store.get(agentsSelectionAtom)).toEqual({ owner: 'chat', id: 'c2' })
  expect(store.get(sessionsSeenAtom).seen['chat:c2']).toBeGreaterThan(0)
  await userEvent.click(screen.getByRole('button', { name: /^Inbox cleanup/ }))
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'session', id: 'abcd1234' })
  expect(screen.getByRole('button', { name: 'Weekly review' })).toBeTruthy()
})

test('search narrows the list by title', async () => {
  setup()
  await userEvent.type(screen.getByLabelText('Search conversations'), 'weekly')
  expect(cardKeys()).toEqual(['chat:c2'])
  await userEvent.clear(screen.getByLabelText('Search conversations'))
  await userEvent.type(screen.getByLabelText('Search conversations'), 'zzz')
  expect(screen.getByText('No conversations match.')).toBeTruthy()
})

test('the filter menu keeps a state, and shows archived on request', async () => {
  const store = setup()
  await userEvent.click(screen.getByRole('button', { name: 'Filter' }))
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Working' }))
  expect(store.get(sessionFilterAtom).states).toEqual(['working'])
  await userEvent.keyboard('{Escape}')
  expect(cardKeys()).toEqual(['chat:c1'])
  await userEvent.click(screen.getByRole('button', { name: 'Filter, on' }))
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Working' }))
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show archived' }))
  await userEvent.keyboard('{Escape}')
  expect(cardKeys()).toContain('chat:c3')
  expect(screen.getByRole('button', { name: 'Filter, on' })).toBeTruthy()
})

test('arrow keys move between cards and Enter opens', async () => {
  const store = setup()
  cards()[0]!.focus()
  await userEvent.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(cards()[1])
  await userEvent.keyboard('{End}')
  expect(document.activeElement).toBe(cards()[3])
  await userEvent.keyboard('{Enter}')
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'session', id: 'efgh5678' })
})

test('the toggle and the Inbox count sessions and slots alike', () => {
  const store = setup()
  expect(store.get(agentsStatusAtom)).toEqual({ needsYou: 2, working: 1 })
  expect(store.get(inboxCountAtom)).toBe(2)
})

test('with nothing yet, an empty state starts one in the slot that offers it', async () => {
  const store = setup({ sessions: false, chats: [] })
  expect(screen.getByText('No conversations yet')).toBeTruthy()
  const start = within(screen.getByRole('region', { name: 'Sessions' })).getAllByRole('button', {
    name: 'New session',
  })
  await userEvent.click(start.at(-1)!)
  expect(store.get(agentsSelectionAtom)).toEqual({ owner: 'chat', id: 'new' })
})

test('loading draws skeletons', () => {
  setup({ sessions: false, chats: [], status: 'loading' })
  expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeTruthy()
})

test('an error offers Retry, which asks the slots again', async () => {
  const store = setup({ sessions: false, chats: [], status: 'error' })
  expect(screen.getByRole('alert').textContent).toMatch(/Could not load/)
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(store.get(fixtures.reloads)).toBe(1)
})
