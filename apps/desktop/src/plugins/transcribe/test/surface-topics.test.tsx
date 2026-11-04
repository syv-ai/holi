/**
 * Topics in the Meetings tab, the minutes' backbone: one joined to another
 * from its menu (dragging one onto another does the same) and separated
 * again; one open at a time,
 * a bar of the strip scrolling smoothly to its topic, and a topic's own
 * transcript; a topic edited in place; a new topic started from a caption
 * line; a topic merged with the one before it; Summarise now; and Send, from a topic or a suggestion in
 * it: the panel prefilled, the related lines from elsewhere offered
 * unticked, ticked ones carried in the task's lines, the target picked, then
 * the task made and sent.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { act, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore, type PrimitiveAtom } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, agentSessionRowsAtom, type AgentSessionRow } from '@/plugin-api'
import type { Related } from '../main/related'
import type { Card, MeetingState, Topic } from '../shared/meeting'
import { MeetingsSurface } from '../renderer/meetings-surface'
import { transcriptText } from '../renderer/transcript-text'
import {
  meetingStatesAtom,
  profilesAtom,
  shownMeetingIdAtom,
  transcribeEvents,
} from '../renderer/state'
import { meeting, profile, topics } from './meeting-fixture'

/** The send button's words while main has not named the vault's agent. */
const SEND_TO_AGENT = 'Send to the agent'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))

const caps = vi.hoisted(() => new Set<string>())
vi.mock('@/plugin-api', async (original) => {
  const { atom } = await import('jotai')
  return {
    ...(await original<typeof import('@/plugin-api')>()),
    agentSessionRowsAtom: atom<readonly AgentSessionRow[]>([]),
    useHasCapability: (name: string) => caps.has(name),
  }
})

const calls = (name: string): unknown[] =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => (c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson)))

const RELATED: Related[] = [
  {
    lines: [9, 10],
    start: 90,
    end: 108,
    text: 'Line 9 of the call Line 10 of the call',
    score: 2.1,
  },
  { lines: [0, 1], start: 0, end: 18, text: 'Line 0 of the call Line 1 of the call', score: 1.2 },
]

let related: () => Promise<Related[]> = async () => RELATED

beforeEach(() => {
  run.mockReset()
  caps.clear()
  localStorage.clear()
  related = async () => RELATED
  run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
    const params = paramsJson === undefined ? {} : JSON.parse(paramsJson)
    switch (name) {
      case 'meeting.get':
        return shownState
      case 'meeting.related':
        return related()
      case 'meeting.group.edit': {
        const t = meeting.topics.find((x) => x.id === params.groupId) as Topic
        return { ...t, ...params.patch, edited: Object.keys(params.patch), editedAt: 1 }
      }
      case 'meeting.group.split':
        return [
          topics[0],
          topics[1],
          { ...topics[2], lines: [8, 9], end: 98, open: false, stale: true },
          {
            ...topics[2],
            id: 't10',
            title: '',
            keywords: [],
            lines: [10, 11],
            start: 100,
            end: 118,
          },
        ]
      case 'meeting.group.merge':
        return [
          {
            ...topics[0],
            lines: [...topics[0]!.lines, ...topics[1]!.lines],
            end: 78,
            stale: true,
          },
          topics[2],
        ]
      case 'meeting.group.join':
        return meeting.topics.map((t) =>
          t.id === params.groupId ? { ...t, joinedTo: params.into } : t,
        )
      case 'meeting.group.separate':
        return meeting.topics
      case 'meeting.task.create': {
        const card: Card = {
          id: 'c9',
          kind: params.kind,
          title: params.prompt.split('\n')[0],
          why: params.prompt,
          segments: params.lines,
          acceptance: [],
          openQuestions: [],
          quotes: [],
          status: 'accepted',
          origin: 'person',
          ...(params.from === undefined ? {} : { from: params.from }),
          createdAt: 9,
          updatedAt: 9,
        }
        return card
      }
      case 'meeting.build':
        return { sessionId: 'job-9' }
      case 'holis.list':
        return [{ id: 'proposal', name: 'Proposal', status: 'approved' }]
      default:
        return { ok: true }
    }
  })
})

/** What main has of the meeting shown, which `meeting.get` answers. */
let shownState: MeetingState = meeting

function show(state: MeetingState = meeting) {
  shownState = state
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingStatesAtom, { m1: state })
  store.set(shownMeetingIdAtom, 'm1')
  store.set(agentSessionRowsAtom as unknown as PrimitiveAtom<readonly AgentSessionRow[]>, [])
  render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  return store
}

const topicNamed = (title: string) => screen.getByLabelText(title, { selector: '[data-topic]' })
/** A topic's header, which opens and folds it. */
const headerOf = (topic: HTMLElement) =>
  topic.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement
/** Pick an action from a topic's menu. */
async function topicAction(title: string, action: string): Promise<void> {
  await userEvent.click(within(topicNamed(title)).getByRole('button', { name: 'Topic actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: action }))
}

test('a topic is edited in place: what changed goes to main, and it says it is the person’s', async () => {
  show()
  await topicAction('Budget', 'Edit topic')
  const budget = topicNamed('Budget')
  const title = within(budget).getByLabelText('Topic title')
  await userEvent.clear(title)
  await userEvent.type(title, 'Pilot budget')
  await userEvent.click(within(budget).getByRole('button', { name: 'Add bullet' }))
  await userEvent.type(within(budget).getByLabelText('Bullet 3'), 'Seats are cheap')
  await userEvent.click(within(budget).getByRole('button', { name: 'Remove question 1' }))
  await userEvent.click(within(budget).getByRole('button', { name: 'Save topic' }))
  expect(calls('meeting.group.edit')).toEqual([
    {
      meetingId: 'm1',
      groupId: 't0',
      patch: {
        title: 'Pilot budget',
        summary: [
          'The pilot costs too much as planned.',
          'Licences are the big item.',
          'Seats are cheap',
        ],
        questions: [],
      },
    },
  ])
  const saved = await screen.findByLabelText('Pilot budget', { selector: '[data-topic]' })
  expect(
    within(saved).getByText(
      /Edited by you: title, summary, questions\. The assistant keeps your words\./,
    ),
  ).toBeInTheDocument()
}, 15_000)

test('a caption line starts a new topic; a line that starts one cannot', async () => {
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Show transcript' }))
  const captions = screen.getByRole('list', { name: 'Transcript' })
  const lineOf = (i: number) => captions.querySelector(`[data-segment="${i}"]`) as HTMLElement
  expect(within(lineOf(8)).queryByRole('button', { name: 'Start a new topic here' })).toBeNull()
  await userEvent.click(within(lineOf(10)).getByRole('button', { name: 'Start a new topic here' }))
  expect(calls('meeting.group.split')).toEqual([{ meetingId: 'm1', i: 10 }])
  // Main's groups are shown at once: the split-off part is closed and to be rewritten.
  const plan = await screen.findByLabelText('Release plan', { selector: '[data-topic]' })
  expect(
    within(plan).getByText('The assistant will rewrite this topic in its next pass.'),
  ).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Now' })).toHaveTextContent('from 1:40')
}, 15_000)

test('Merge with the previous joins a topic to the one before it', async () => {
  show()
  await topicAction('Export', 'Merge with the previous')
  expect(calls('meeting.group.merge')).toEqual([{ meetingId: 'm1', groupId: 't4' }])
  await waitFor(() =>
    expect(screen.queryByLabelText('Export', { selector: '[data-topic]' })).toBeNull(),
  )
  expect(within(topicNamed('Budget')).getByText('0:00–1:18')).toBeInTheDocument()
}, 15_000)

test('Summarise now asks the assistant for its next batch, and says so until it writes', async () => {
  const store = show()
  const now = screen.getByRole('region', { name: 'Now' })
  await userEvent.click(within(now).getByRole('button', { name: 'Summarise now' }))
  expect(calls('meeting.summarise')).toEqual([{ meetingId: 'm1' }])
  expect(await within(now).findByText('The assistant is summarising…')).toBeInTheDocument()
  act(() =>
    transcribeEvents.meeting!(
      { remote: 'syv/vault', payload: { ...meeting, minutesAt: Date.now() } },
      store,
    ),
  )
  expect(
    within(screen.getByRole('region', { name: 'Now' })).queryByText(
      'The assistant is summarising…',
    ),
  ).toBeNull()
}, 15_000)

test('Summarise now waits for an assistant that can take it, saying why and what starts it', async () => {
  show({ ...meeting, scribeState: 'gone' })
  const now = screen.getByRole('region', { name: 'Now' })
  expect(within(now).getByRole('button', { name: 'Summarise now' })).toBeDisabled()
  const why = within(now).getByRole('status', { name: 'Assistant' })
  expect(why).toHaveTextContent('The assistant stopped. Recording and captions go on.')
  await userEvent.click(within(why).getByRole('button', { name: 'Start the assistant' }))
  await waitFor(() => expect(calls('meeting.scribe.restart')).toEqual([{ meetingId: 'm1' }]))
  expect(calls('meeting.summarise')).toEqual([])
}, 15_000)

test('on an agent that cannot write topics, Now says which agents can, with the setting', () => {
  show({ ...meeting, scribeState: 'off', scribeUnsupported: 'codex' })
  const why = within(screen.getByRole('region', { name: 'Now' })).getByRole('status', {
    name: 'Assistant',
  })
  expect(why).toHaveTextContent('Topics need Claude Code or Pi')
  expect(within(why).getByRole('button', { name: 'Agent settings' })).toBeInTheDocument()
  expect(within(why).getByRole('button', { name: 'Start the assistant' })).toBeInTheDocument()
}, 15_000)

test('Send on a suggestion: prefilled, related lines unticked, ticked ones carried, then sent', async () => {
  show()
  await userEvent.click(headerOf(topicNamed('Export')))
  const exportTopic = topicNamed('Export')
  const suggestion = within(exportTopic).getByRole('group', { name: 'Export the board to CSV' })
  await userEvent.click(within(suggestion).getByRole('button', { name: 'Send' }))
  const panel = await screen.findByRole('dialog', { name: 'Send: Export the board to CSV' })
  expect(within(panel).getByText('Finance wants the board as a CSV.')).toBeInTheDocument()
  expect(within(panel).getByLabelText('What should be done?')).toHaveValue(
    'Export the board to CSV\nFinance copies the board by hand every month.',
  )
  expect(within(panel).getByRole('radio', { name: 'Feature' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  // Related lines, asked with the ask, the topic's title and keywords, outside its lines.
  const nine = await within(panel).findByRole('checkbox', { name: /Line 9 of the call/ })
  expect(nine).not.toBeChecked()
  expect(within(panel).getByRole('checkbox', { name: /0:00/ })).not.toBeChecked()
  const asked = calls('meeting.related').at(-1) as { query: string; exclude: number[] }
  expect(asked.query).toContain('Export the board to CSV')
  expect(asked.query).toContain('csv finance')
  expect(asked.exclude).toEqual([4, 5, 6, 7])
  await userEvent.click(nine)
  expect(nine).toBeChecked()

  await userEvent.click(within(panel).getByRole('button', { name: SEND_TO_AGENT }))
  await waitFor(() => expect(calls('meeting.build')).toHaveLength(1))
  expect(calls('meeting.task.create')).toEqual([
    {
      meetingId: 'm1',
      lines: [4, 5, 6, 7, 9, 10],
      prompt: 'Export the board to CSV\nFinance copies the board by hand every month.',
      kind: 'feature',
      from: { topicId: 't4', suggestionId: 's2' },
    },
  ])
  expect(calls('meeting.build')).toEqual([
    { meetingId: 'm1', cardId: 'c9', target: { kind: 'agent' } },
  ])
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  // The task is in the rail, sent; the suggestion shows its run.
  const rail = screen.getByRole('region', { name: 'Tasks' })
  expect(
    within(rail).getByLabelText('Export the board to CSV', { selector: '[data-card]' }),
  ).toHaveTextContent('Sent')
  expect(
    within(topicNamed('Export')).getByRole('group', { name: 'Export the board to CSV' }),
  ).toHaveTextContent('Sent')
}, 15_000)

test('Send names the vault’s agent, and a retry after a failed send uses the form as it is now', async () => {
  const base = run.getMockImplementation()!
  let builds = 0
  run.mockImplementation(async (c: { name: string }) => {
    if (c.name === 'agent.providers') return [{ id: 'claude', label: 'Claude Code' }]
    if (c.name === 'meeting.build' && ++builds === 1) throw new Error('the agent is busy')
    return base(c)
  })
  show()
  await userEvent.click(within(topicNamed('Budget')).getByRole('button', { name: 'Send topic' }))
  const panel = await screen.findByRole('dialog', { name: /^Send: / })
  const ask = within(panel).getByLabelText('What should be done?')
  await userEvent.type(ask, 'Ask finance')
  await userEvent.click(await within(panel).findByRole('button', { name: 'Send to Claude Code' }))
  expect(
    await within(panel).findByText(/Sending didn’t work: the agent is busy/),
  ).toBeInTheDocument()

  await userEvent.type(ask, ' for the quote')
  await userEvent.click(within(panel).getByRole('button', { name: 'Send to Claude Code' }))
  await waitFor(() => expect(calls('meeting.build')).toHaveLength(2))
  const made = calls('meeting.task.create') as Array<{ prompt: string; cardId?: string }>
  expect(made).toHaveLength(2)
  expect(made[1]).toMatchObject({ prompt: 'Ask finance for the quote', cardId: 'c9' })
}, 15_000)

test('Send on a topic needs an ask, re-asks the related lines, and goes to a picked Holi', async () => {
  caps.add('holis.send')
  show()
  await userEvent.click(within(topicNamed('Budget')).getByRole('button', { name: 'Send topic' }))
  const panel = await screen.findByRole('dialog', { name: 'Send: Budget' })
  const ask = within(panel).getByLabelText('What should be done?')
  expect(ask).toHaveValue('')
  expect(within(panel).getByRole('button', { name: SEND_TO_AGENT })).toBeDisabled()
  await within(panel).findByRole('checkbox', { name: /Line 9 of the call/ })
  const before = calls('meeting.related').length
  await userEvent.type(ask, 'Draft the licence request')
  await waitFor(() => expect(calls('meeting.related').length).toBeGreaterThan(before))
  expect((calls('meeting.related').at(-1) as { query: string }).query).toContain(
    'Draft the licence request Budget budget licences',
  )
  await userEvent.click(within(panel).getByRole('radio', { name: 'To-do' }))
  await userEvent.click(await within(panel).findByRole('button', { name: 'Choose who it goes to' }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Proposal' }))
  await userEvent.click(within(panel).getByRole('button', { name: 'Send to Proposal' }))
  await waitFor(() => expect(calls('meeting.build')).toHaveLength(1))
  expect(calls('meeting.task.create')).toEqual([
    {
      meetingId: 'm1',
      lines: [0, 1, 2, 3],
      prompt: 'Draft the licence request',
      kind: 'action',
      from: { topicId: 't0' },
    },
  ])
  expect(calls('meeting.build')).toEqual([
    { meetingId: 'm1', cardId: 'c9', target: { kind: 'holi', id: 'proposal' } },
  ])
}, 15_000)

test('related lines that fail to load say so, and Retry asks again', async () => {
  let fail = true
  related = async () => {
    if (fail) throw new Error('main is busy')
    return RELATED
  }
  show()
  await userEvent.click(within(topicNamed('Budget')).getByRole('button', { name: 'Send topic' }))
  const panel = await screen.findByRole('dialog', { name: 'Send: Budget' })
  expect(
    await within(panel).findByText(/The related lines didn’t load: main is busy/),
  ).toBeInTheDocument()
  fail = false
  await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }))
  expect(
    await within(panel).findByRole('checkbox', { name: /Line 9 of the call/ }),
  ).toBeInTheDocument()
}, 15_000)

test('one topic is open at a time; Expand all still opens every one', async () => {
  show()
  const header = (title: string) => headerOf(topicNamed(title))
  await userEvent.click(header('Budget'))
  expect(header('Budget')).toHaveAttribute('aria-expanded', 'true')
  await userEvent.click(header('Export'))
  expect(header('Export')).toHaveAttribute('aria-expanded', 'true')
  expect(header('Budget')).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
  expect(header('Budget')).toHaveAttribute('aria-expanded', 'true')
  expect(header('Export')).toHaveAttribute('aria-expanded', 'true')
}, 15_000)

test('a bar of the strip opens its topic alone and scrolls to it smoothly', async () => {
  const scrolled: { topic: string | null; options: unknown }[] = []
  const original = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
    scrolled.push({ topic: this.getAttribute('data-topic'), options })
  }
  try {
    show()
    await userEvent.click(headerOf(topicNamed('Budget')))
    const strip = screen.getByRole('list', { name: 'Topics at a glance' })
    await userEvent.click(within(strip).getByRole('button', { name: /^2\. Export/ }))
    await waitFor(() =>
      expect(scrolled.at(-1)).toEqual({
        topic: 't4',
        options: { block: 'start', behavior: 'smooth' },
      }),
    )
    const header = (title: string) => headerOf(topicNamed(title))
    expect(header('Export')).toHaveAttribute('aria-expanded', 'true')
    expect(header('Budget')).toHaveAttribute('aria-expanded', 'false')
  } finally {
    Element.prototype.scrollIntoView = original
  }
}, 15_000)

test('a topic’s Transcript tab shows its own lines word for word, and copies them', async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  show()
  await userEvent.click(headerOf(topicNamed('Budget')))
  await userEvent.click(within(topicNamed('Budget')).getByRole('tab', { name: 'Transcript' }))
  const lines = within(topicNamed('Budget')).getByRole('list', { name: 'Transcript of Budget' })
  const items = within(lines).getAllByRole('listitem')
  expect(items.map((li) => li.getAttribute('data-segment'))).toEqual(['0', '1', '2', '3'])
  expect(within(lines).getByText('Line 2 of the call')).toBeInTheDocument()
  // The first line already starts the topic; the others can start a new one.
  expect(within(items[0]!).queryByRole('button', { name: 'Start a new topic here' })).toBeNull()
  expect(
    within(items[1]!).getByRole('button', { name: 'Start a new topic here' }),
  ).toBeInTheDocument()
  await userEvent.click(within(topicNamed('Budget')).getByRole('button', { name: 'Copy' }))
  expect(writeText).toHaveBeenCalledWith(transcriptText(meeting.segments.filter((s) => s.i <= 3)))
}, 15_000)

test('a topic joins another from its menu: one topic, its lists across both parts, sent whole', async () => {
  show()
  await userEvent.click(within(topicNamed('Export')).getByRole('button', { name: 'Topic actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Join with' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: '1. Budget' }))
  expect(calls('meeting.group.join')).toEqual([{ meetingId: 'm1', groupId: 't4', into: 't0' }])

  // One row for both, opened: their numbers and times, and each part's words.
  await waitFor(() =>
    expect(screen.queryByLabelText('Export', { selector: '[data-topic]' })).toBeNull(),
  )
  const joined = topicNamed('Budget')
  expect(within(joined).getByText('1 + 2')).toBeInTheDocument()
  expect(within(joined).getByText('0:00–0:38, 0:40–1:18')).toBeInTheDocument()
  expect(headerOf(joined)).toHaveAttribute('aria-expanded', 'true')
  // One list of each kind across both parts.
  expect(within(joined).getByRole('list', { name: 'Open questions' })).toHaveTextContent(
    'Who signs off the licences?Which columns go in?',
  )
  expect(
    within(within(joined).getByRole('list', { name: 'Suggestions' }))
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label')),
  ).toEqual(['Ask finance for the licence quote', 'Export the board to CSV', 'Search in notes'])
  expect(within(joined).getAllByRole('list', { name: 'Keywords' })).toHaveLength(1)
  // Each part is edited on its own, from the menu.
  await userEvent.click(within(joined).getByRole('button', { name: 'Topic actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit part' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: '2. Export' }))
  expect(within(joined).getByText('Editing Export')).toBeInTheDocument()
  expect(within(joined).getByLabelText('Topic title')).toHaveValue('Export')
  await userEvent.click(within(joined).getByRole('button', { name: 'Cancel' }))

  // Send takes every part's lines.
  await userEvent.click(within(joined).getByRole('button', { name: 'Send topic' }))
  const panel = await screen.findByRole('dialog', { name: 'Send: Budget' })
  expect(panel).toHaveTextContent('2 stretches of the meeting, 8 lines')
  await userEvent.type(within(panel).getByLabelText('What should be done?'), 'Plan it')
  await userEvent.click(within(panel).getByRole('button', { name: SEND_TO_AGENT }))
  await waitFor(() => expect(calls('meeting.task.create')).toHaveLength(1))
  expect((calls('meeting.task.create')[0] as { lines: number[] }).lines).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7,
  ])
}, 15_000)

test('Separate topics gives each group back its own row', async () => {
  const joined: MeetingState = {
    ...meeting,
    topics: meeting.topics.map((t) => (t.id === 't4' ? { ...t, joinedTo: 't0' } : t)),
  }
  const base = run.getMockImplementation()!
  run.mockImplementation(async (c: { name: string }) =>
    c.name === 'meeting.get' ? joined : base(c),
  )
  show(joined)
  expect(within(topicNamed('Budget')).getByText('1 + 2')).toBeInTheDocument()
  await userEvent.click(within(topicNamed('Budget')).getByRole('button', { name: 'Topic actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Separate topics' }))
  expect(calls('meeting.group.separate')).toEqual([{ meetingId: 'm1', groupId: 't0' }])
  expect(await screen.findByLabelText('Export', { selector: '[data-topic]' })).toBeInTheDocument()
}, 15_000)

test('dragging a topic onto another joins them', async () => {
  // jsdom lays nothing out: each topic row gets a box of its own, one under
  // the other, and the drag preview starts where the dragged row (Export) is.
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const row = this.closest('[data-topic]')
    const rows = [...document.querySelectorAll('[data-topic]')]
    const top = row === null ? 60 : rows.indexOf(row) * 60
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 400,
      bottom: top + 50,
      width: 400,
      height: 50,
      toJSON: () => ({}),
    }
  }
  try {
    show()
    const handle = within(topicNamed('Export')).getByRole('button', {
      name: 'Drag onto another topic to join them',
    })
    handle.focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}')
    // Hovering over a topic offers the join; dropping makes it.
    expect(
      within(topicNamed('Budget')).getByText('Drop to join with this topic'),
    ).toBeInTheDocument()
    await userEvent.keyboard(' ')
    await waitFor(() =>
      expect(calls('meeting.group.join')).toEqual([{ meetingId: 'm1', groupId: 't4', into: 't0' }]),
    )
  } finally {
    Element.prototype.getBoundingClientRect = original
  }
}, 15_000)
