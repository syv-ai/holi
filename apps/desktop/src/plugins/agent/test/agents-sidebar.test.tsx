/**
 * The Agents mode's sidebar: the Inbox with what needs you and History, the
 * places other plugins add beside them, their sections by order, then the
 * open sessions (the slots' rows and the live sessions) as cards, what needs
 * you first; History with every one, by day, under the search; and the status
 * the mode toggle reports.
 */
import { act, render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore, type PrimitiveAtom } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, agentsSelectionAtom, type AgentsSessionItem } from '@/plugin-api'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AgentsSidebar } from '../renderer/agents/agents-sidebar'
import { agentsStatusAtom, inboxCountAtom } from '../renderer/state/agents-status'
import { agentsViewAtom, showHistoryAtom } from '../renderer/state/agents-view'
import { SessionHistory } from '../renderer/sessions/session-list'
import { SessionSearch } from '../renderer/sessions/session-filters'
import {
  NO_FILTER,
  sessionFilterAtom,
  sessionsOpenAtom,
  sessionsSeenAtom,
  type OpenRecord,
} from '../renderer/state/session-list'
import { agentSessionsAtom } from '../renderer/state/sessions'

const agentCap = vi.hoisted(() => ({
  stop: vi.fn(async () => ({ ok: true })),
  open: vi.fn(async () => ({ ok: true, terminalId: 't1' })),
  start: vi.fn(async () => ({ ok: true, sessionId: 'p0123456789ab', terminalId: 't2' })),
}))
vi.mock('../renderer/agent-cap', () => ({ agentCap }))
vi.mock('@/state/agents-slots', async (orig) => {
  const real = await orig<typeof import('@/state/agents-slots')>()
  const { atom } = await import('jotai')
  const fakeItems = atom<AgentsSessionItem[]>([])
  const fakeStatus = atom<'loading' | 'ready' | 'error'>('ready')
  const reloads = atom(0)
  const reload = atom(null, (_get, set) => set(reloads, (n) => n + 1))
  const create = atom(null, (_get, set) =>
    set(real.agentsSelectionAtom, { owner: 'fake', id: 'new' }),
  )
  const archive = atom(null, () => {})
  const close = atom(null, (_get, set, key: string) => set(calls, (c) => [...c, `close ${key}`]))
  // What the menus asked the fake slot to do, in order.
  const calls = atom<string[]>([])
  const rename = atom(null, (_get, set, key: string, title: string) =>
    set(calls, (c) => [...c, `rename ${key} ${title}`]),
  )
  const pin = atom(null, (_get, set, key: string, pinned: boolean) =>
    set(calls, (c) => [...c, `pin ${key} ${pinned}`]),
  )
  const remove = atom(null, async (_get, set, key: string) => {
    set(calls, (c) => [...c, `delete ${key}`])
    return { ok: true }
  })
  return {
    ...real,
    __test: { fakeItems, fakeStatus, reloads, calls },
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
        plugin: 'fake',
        status: atom({ needsYou: 0, working: 1 }),
        sessions: {
          items: fakeItems,
          status: fakeStatus,
          reload,
          create,
          archive,
          rename,
          pin,
          remove,
          close,
        },
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
      fakeItems: PrimitiveAtom<AgentsSessionItem[]>
      fakeStatus: PrimitiveAtom<'loading' | 'ready' | 'error'>
      reloads: PrimitiveAtom<number>
      calls: PrimitiveAtom<string[]>
    }
  }
).__test

beforeEach(() => {
  localStorage.clear()
  agentCap.stop.mockClear()
  agentCap.open.mockClear()
})

const NOW = Date.now()

const fake = (id: string, over: Partial<AgentsSessionItem> = {}): AgentsSessionItem => ({
  key: `fake:${id}`,
  selection: { owner: 'fake', id },
  title: `Fake ${id}`,
  state: 'idle',
  updatedAt: NOW - 60_000,
  ...over,
})

function setup({
  sessions = true,
  fakes = [
    fake('c1', { title: 'Drafting the plan', state: 'working', model: 'opus' }),
    fake('c2', { title: 'Weekly review', endedAt: NOW - 30_000, updatedAt: NOW - 30_000 }),
    fake('c3', { title: 'Old notes', archived: true }),
  ],
  status = 'ready' as 'loading' | 'ready' | 'error',
  // Since 0: every row the person started is open.
  open = { since: 0, opened: {}, closed: {} } as OpenRecord,
  history = false,
} = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/notes')
  store.set(sessionsSeenAtom, { since: 0, seen: {} })
  store.set(sessionFilterAtom, NO_FILTER)
  store.set(sessionsOpenAtom, open)
  store.set(fixtures.fakeItems, fakes)
  store.set(fixtures.fakeStatus, status)
  if (sessions) {
    store.set(agentSessionsAtom, [
      {
        id: 'abcd1234',
        provider: 'claude',
        name: 'Inbox cleanup',
        state: 'needs-you',
        waitingFor: 'Run holi?',
      },
      {
        id: 'efgh5678',
        provider: 'claude',
        name: 'Notes pass',
        state: 'idle',
        startedAt: NOW - 120_000,
      },
    ])
  }
  render(
    <Provider store={store}>
      <SidebarProvider>
        <AgentsSidebar />
        {history && (
          <div data-agents-history="">
            <SessionSearch />
            <SessionHistory />
          </div>
        )}
      </SidebarProvider>
    </Provider>,
  )
  return store
}

const cards = (region: 'Sessions' | 'History' = 'Sessions') =>
  within(screen.getByRole('region', { name: region }))
    .queryAllByRole('button')
    .filter((b) => b.hasAttribute('data-session-card'))

const cardKeys = (region: 'Sessions' | 'History' = 'Sessions') =>
  cards(region).map((c) => c.getAttribute('data-session-card'))

const groupsOf = (region: 'Sessions' | 'History') =>
  within(screen.getByRole('region', { name: region }))
    .queryAllByRole('group')
    .map((g) => g.getAttribute('aria-label'))

test('the Inbox and History, the slots in order, then the sessions', () => {
  setup()
  expect(screen.queryByLabelText('Search conversations, or start one')).toBeNull()
  expect(screen.getByRole('button', { name: /^Inbox(, \d+ need you)?$/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'History' })).toBeTruthy()
  expect(screen.getByText('Automations row')).toBeTruthy()
  const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
  expect(sections).toEqual(['Holis', 'Sessions'])
})

test('Sessions lists the open plugin rows and live sessions, what needs you first, without day groups', () => {
  setup()
  expect(cardKeys()).toEqual(['agent:abcd1234', 'fake:c2', 'fake:c1', 'agent:efgh5678'])
  expect(groupsOf('Sessions')).toEqual([])
})

test('History has every row by day, archived left out', () => {
  setup({ history: true })
  expect(cardKeys('History')).toEqual(['agent:abcd1234', 'fake:c2', 'fake:c1', 'agent:efgh5678'])
  expect(groupsOf('History')).toEqual(['Needs you', 'Today'])
})

test('a row started before this machine kept track waits in History until opened', async () => {
  const store = setup({
    sessions: false,
    fakes: [fake('c1', { title: 'Old plan' }), fake('c2', { title: 'New plan', updatedAt: NOW })],
    open: { since: NOW - 1000, opened: {}, closed: {} },
    history: true,
  })
  expect(cardKeys()).toEqual(['fake:c2'])
  await userEvent.click(
    within(screen.getByRole('region', { name: 'History' })).getByRole('button', {
      name: 'Old plan',
    }),
  )
  expect(store.get(sessionsOpenAtom).opened['fake:c1']).toBe(true)
  expect(cardKeys()).toEqual(['fake:c2', 'fake:c1'])
})

test("a Holi's run is in Sessions only while it needs you", () => {
  const by = { kind: 'holi' as const, name: 'Mina' }
  setup({
    sessions: false,
    fakes: [
      fake('h1', { title: 'Asks', by, state: 'needs-you', waitingFor: 'Edit a.md?' }),
      fake('h2', { title: 'Ran', by }),
    ],
  })
  expect(cardKeys()).toEqual(['fake:h1'])
})

test("a card's × closes it: it leaves Sessions for History and what it runs stops", async () => {
  const store = setup({ history: true })
  store.set(fixtures.calls, [])
  const sessions = within(screen.getByRole('region', { name: 'Sessions' }))
  await userEvent.click(sessions.getByRole('button', { name: 'Close Weekly review' }))
  expect(cardKeys()).not.toContain('fake:c2')
  expect(cardKeys('History')).toContain('fake:c2')
  expect(store.get(fixtures.calls)).toEqual(['close fake:c2'])
  expect(store.get(sessionsOpenAtom).closed['fake:c2']).toBeGreaterThan(0)

  await userEvent.click(sessions.getByRole('button', { name: 'Close Notes pass' }))
  expect(agentCap.stop).toHaveBeenCalledWith('o/notes', { id: 'efgh5678' })
  // History draws no ×: closing is the open list's.
  expect(
    within(screen.getByRole('region', { name: 'History' })).queryByRole('button', {
      name: /^Close /,
    }),
  ).toBeNull()
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
  // Every card is in the open vault, so none repeats its name.
  expect(within(read!).queryByText(/notes$/)).toBeNull()
})

test('opening a done row marks it read, and selects what it stands for', async () => {
  const store = setup()
  await userEvent.click(screen.getByRole('button', { name: /^Weekly review/ }))
  expect(store.get(agentsSelectionAtom)).toEqual({ owner: 'fake', id: 'c2' })
  expect(store.get(sessionsSeenAtom).seen['fake:c2']).toBeGreaterThan(0)
  await userEvent.click(screen.getByRole('button', { name: /^Inbox cleanup/ }))
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'session', id: 'abcd1234' })
  expect(screen.getByRole('button', { name: 'Weekly review' })).toBeTruthy()
})

test('search narrows History by title', async () => {
  setup({ history: true })
  await userEvent.type(screen.getByLabelText('Search conversations, or start one'), 'weekly')
  expect(cardKeys('History')).toEqual(['fake:c2'])
  await userEvent.clear(screen.getByLabelText('Search conversations, or start one'))
  await userEvent.type(screen.getByLabelText('Search conversations, or start one'), 'zzz')
  expect(screen.getByText('No conversations match.')).toBeTruthy()
})

test('⌘J brings History forward with its field focused', () => {
  const store = setup({ history: true })
  act(() => store.set(showHistoryAtom))
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'history' })
  expect(document.activeElement).toBe(screen.getByLabelText('Search conversations, or start one'))
})

test('Enter in the History field starts a session with what was typed', async () => {
  setup({ history: true })
  agentCap.start.mockClear()
  const field = screen.getByLabelText('Search conversations, or start one')
  await userEvent.type(field, 'tidy the inbox{Enter}')
  expect(agentCap.start).toHaveBeenCalledWith(
    'o/notes',
    expect.objectContaining({ prompt: 'tidy the inbox', name: 'tidy the inbox' }),
  )
  expect((field as HTMLInputElement).value).toBe('')
})

test('arrows go from the History field into the sessions and back', async () => {
  setup({ history: true })
  const field = screen.getByLabelText('Search conversations, or start one')
  await userEvent.click(field)
  await userEvent.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(cards('History')[0])
  await userEvent.keyboard('{ArrowUp}')
  expect(document.activeElement).toBe(field)
})

test('the filter menu keeps a state, and shows archived on request', async () => {
  const store = setup({ history: true })
  await userEvent.click(screen.getByRole('button', { name: 'Filter' }))
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Working' }))
  expect(store.get(sessionFilterAtom).states).toEqual(['working'])
  await userEvent.keyboard('{Escape}')
  expect(cardKeys('History')).toEqual(['fake:c1'])
  await userEvent.click(screen.getByRole('button', { name: 'Filter, on' }))
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Working' }))
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show archived' }))
  await userEvent.keyboard('{Escape}')
  expect(cardKeys('History')).toContain('fake:c3')
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

test('with nothing yet, an empty state starts one in the default agent', async () => {
  const store = setup({ sessions: false, fakes: [] })
  expect(screen.getByText('No active sessions')).toBeTruthy()
  const start = within(screen.getByRole('region', { name: 'Sessions' })).getAllByRole('button', {
    name: 'New session',
  })
  await userEvent.click(start.at(-1)!)
  expect(agentCap.start).toHaveBeenCalledWith(
    'o/notes',
    expect.objectContaining({ provider: 'claude' }),
  )
  expect(store.get(agentsSelectionAtom)).toEqual({ owner: 'agent', id: 'session:p0123456789ab' })
  await userEvent.click(
    within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
      name: 'History',
    }),
  )
  expect(store.get(agentsViewAtom)).toEqual({ kind: 'history' })
})

test('a native Pi session opens its terminal and can be duplicated', async () => {
  const store = setup({ sessions: false, fakes: [] })
  const id = 'p0123456789ab'
  act(() =>
    store.set(agentSessionsAtom, [
      { id, provider: 'pi', name: 'Pi plan', state: 'idle', startedAt: NOW },
    ]),
  )
  expect(await menuOf(/^Pi plan/)).toContain('Duplicate')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Open in terminal' }))
  expect(agentCap.open).toHaveBeenCalledWith('o/notes', expect.objectContaining({ attach: id }))
})

test('Open in terminal resumes a copy of the conversation by its id', async () => {
  setup({
    sessions: false,
    fakes: [fake('c2', { title: 'Weekly review', sessionId: 'conv-2' })],
  })
  await menuOf(/^Weekly review/)
  await userEvent.click(screen.getByRole('menuitem', { name: 'Open in terminal' }))
  expect(agentCap.open).toHaveBeenCalledWith('o/notes', expect.objectContaining({ fork: 'conv-2' }))
})

test('loading draws skeletons', () => {
  setup({ sessions: false, fakes: [], status: 'loading' })
  expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeTruthy()
})

test('an error offers Retry, which asks the slots again', async () => {
  const store = setup({ sessions: false, fakes: [], status: 'error' })
  expect(screen.getByRole('alert').textContent).toMatch(/Could not load/)
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(store.get(fixtures.reloads)).toBe(1)
})

/** Open a card's ⋯ menu in Sessions and list what it offers. */
async function menuOf(title: RegExp): Promise<string[]> {
  const card = within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
    name: title,
  })
  const row = card.closest('[data-session-row]') as HTMLElement
  await userEvent.click(within(row).getByRole('button', { name: /^More actions for/ }))
  const menu = await screen.findByRole('menu')
  return within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent ?? '')
}

test("a fake row's menu offers what its owner backs, and a live run its own verbs", async () => {
  const store = setup({
    fakes: [fake('c2', { title: 'Weekly review', sessionId: 'conv-2', updatedAt: NOW - 30_000 })],
  })
  store.set(fixtures.calls, [])
  expect(await menuOf(/^Weekly review/)).toEqual([
    'Open to the side',
    'Open in terminal',
    'Pin to top',
    'Rename',
    'Mark as unread',
    'Copy session ID',
    'Close session',
    'Archive',
    'Delete…',
  ])
  await userEvent.keyboard('{Escape}')
  expect(await menuOf(/^Notes pass/)).toEqual([
    'Open to the side',
    'Open in terminal',
    'Mark as unread',
    'Copy session ID',
    'Close session',
    'Review last turn',
    'Restart',
    'Duplicate',
    'Stop session',
  ])
})

test('Pin to top asks the owner, and a pinned row sits in Pinned above the days', async () => {
  const store = setup({
    history: true,
    fakes: [
      fake('c1', { title: 'Weekly review' }),
      fake('c2', { title: 'Plan the week', pinned: true, updatedAt: NOW - 3 * 86_400_000 }),
    ],
  })
  store.set(fixtures.calls, [])
  expect(groupsOf('History')).toEqual(['Needs you', 'Pinned', 'Today'])
  // Open, it sits above the others in Sessions too.
  expect(cardKeys().slice(1)).toEqual(['fake:c2', 'fake:c1', 'agent:efgh5678'])
  await menuOf(/^Weekly review/)
  await userEvent.click(screen.getByRole('menuitem', { name: 'Pin to top' }))
  expect(store.get(fixtures.calls)).toEqual(['pin fake:c1 true'])
})

test('Rename opens a field in the row: Enter saves, Escape cancels', async () => {
  const store = setup({ sessions: false, fakes: [fake('c1', { title: 'Weekly review' })] })
  store.set(fixtures.calls, [])
  await menuOf(/^Weekly review/)
  await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  const field = await screen.findByRole('textbox', { name: 'Rename Weekly review' })
  await userEvent.clear(field)
  await userEvent.type(field, 'Review the week{Enter}')
  expect(store.get(fixtures.calls)).toEqual(['rename fake:c1 Review the week'])
  expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull()

  cards()[0]!.focus()
  await userEvent.keyboard('{F2}')
  const again = await screen.findByRole('textbox', { name: 'Rename Weekly review' })
  await userEvent.type(again, 'x{Escape}')
  expect(store.get(fixtures.calls)).toEqual(['rename fake:c1 Review the week'])
})

test('Delete asks first, naming the session and what stays', async () => {
  const store = setup({
    sessions: false,
    fakes: [fake('c1', { title: 'Greeting only, no task yet' })],
  })
  store.set(fixtures.calls, [])
  await menuOf(/^Greeting only/)
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByText('Delete “Greeting only, no task yet”?')).toBeTruthy()
  expect(dialog.textContent).toMatch(/Claude Code’s own transcript stays/)
  expect(store.get(fixtures.calls)).toEqual([])
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
  expect(store.get(fixtures.calls)).toEqual(['delete fake:c1'])
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

test('Mark as unread makes a read row done until it is opened, and back', async () => {
  const store = setup({ sessions: false, fakes: [fake('c1', { title: 'Weekly review' })] })
  await menuOf(/^Weekly review/)
  await userEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }))
  expect(cards()[0]!.getAttribute('aria-label')).toBe('Weekly review, done, not opened yet')
  expect(await menuOf(/^Weekly review/)).toContain('Mark as read')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Mark as read' }))
  expect(cards()[0]!.getAttribute('aria-label')).toBe('Weekly review')
  expect(store.get(sessionsSeenAtom).unread).toEqual({})
})
