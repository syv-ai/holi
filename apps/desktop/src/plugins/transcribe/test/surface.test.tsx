/**
 * The Meetings tab with a meeting mid-call: one header row with the assistant's
 * status, its problems and the recording reminder; the minutes as topics,
 * with the decisions and open questions above them and Now last; the
 * captions folded into a strip until the transcript is shown, which reads
 * under the topics' headings; the Tasks rail, whose rows open in a wide
 * panel to edit and send, to Claude or a Holi; a quote finding its line;
 * caption lines corrected in place; and asking the assistant to change the topics.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { act, cleanup, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore, type PrimitiveAtom } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, agentSessionRowsAtom, type AgentSessionRow } from '@/plugin-api'
import type { Card, MeetingState } from '../shared/meeting'
import { MeetingsSurface } from '../renderer/meetings-surface'
import {
  meetingStatesAtom,
  profilesAtom,
  shownMeetingIdAtom,
  transcribeEvents,
} from '../renderer/state'
import { meeting, profile } from './meeting-fixture'

/** The send button's words while main has not named the vault's agent. */
const SEND_TO_AGENT = 'Send to the agent'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))

// The agent's live sessions, "show this session" and which capabilities the
// vault offers, which core answers, as plain values a test can set and read.
const shown = vi.hoisted((): unknown[] => [])
const caps = vi.hoisted(() => new Set<string>())
vi.mock('@/plugin-api', async (original) => {
  const { atom } = await import('jotai')
  return {
    ...(await original<typeof import('@/plugin-api')>()),
    agentSessionRowsAtom: atom<readonly AgentSessionRow[]>([]),
    showAgentSessionAtom: atom(null, (_get, _set, args: unknown) => {
      shown.push(args)
      return Promise.resolve({ ok: true })
    }),
    useHasCapability: (name: string) => caps.has(name),
  }
})

const calls = (name: string): unknown[] =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => (c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson)))

const HOLIS = [
  { id: 'proposal', name: 'Proposal', status: 'approved' },
  { id: 'scout', name: 'Scout', status: 'new' },
]

beforeEach(() => {
  run.mockReset()
  shown.length = 0
  caps.clear()
  localStorage.clear()
  run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
    const params = paramsJson === undefined ? {} : JSON.parse(paramsJson)
    switch (name) {
      case 'meeting.get':
        return meeting
      case 'meeting.card': {
        const card = meeting.cards.find((c) => c.id === params.cardId) as Card
        return { ...card, ...params.patch }
      }
      case 'meeting.build':
        return {
          sessionId: 'job-9',
          card: {
            ...meeting.cards.find((c) => c.id === params.cardId)!,
            status: 'building',
            buildSessionId: 'job-9',
            taskPath: 'Meetings/x.meeting/task.sent.local.md',
            updatedAt: Date.now(),
          },
        }
      case 'meeting.segment.edit': {
        const seg = meeting.segments.find((s) => s.i === params.i)!
        return { ...seg, text: params.text, edited: true }
      }
      case 'holis.list':
        return HOLIS
      default:
        return { ok: true }
    }
  })
})

function show(rows: readonly AgentSessionRow[] = [], state: MeetingState = meeting) {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingStatesAtom, { m1: state })
  store.set(shownMeetingIdAtom, 'm1')
  store.set(agentSessionRowsAtom as unknown as PrimitiveAtom<readonly AgentSessionRow[]>, rows)
  render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  return store
}

// By label rather than by role: a role query walks the whole tab, which is slow.
const cardNamed = (title: string) => screen.getByLabelText(title, { selector: '[data-card]' })
const topicNamed = (title: string) => screen.getByLabelText(title, { selector: '[data-topic]' })
/** A topic's header, which opens and folds it. */
const headerOf = (topic: HTMLElement) =>
  topic.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement
/** Open a task's row: its panel. */
async function expand(title: string): Promise<HTMLElement> {
  await userEvent.click(within(cardNamed(title)).getAllByRole('button')[0]!)
  return screen.findByRole('dialog', { name: title })
}
const header = () => screen.getByLabelText('Meeting health').parentElement!

test('a meeting shows its topics as the minutes, its last lines in a strip, and its Tasks as rows', async () => {
  show()
  // The captions fold into a strip with the last two lines.
  expect(screen.queryByRole('list', { name: 'Transcript' })).toBeNull()
  const strip = screen.getByRole('region', { name: 'Latest captions' })
  expect(within(strip).getByText('Line 11 of the call')).toBeInTheDocument()
  expect(within(strip).getByText('Line 10 of the call')).toBeInTheDocument()
  expect(within(strip).queryByText('Line 9 of the call')).toBeNull()

  // One bar per topic at a glance, the open one last.
  expect(
    within(screen.getByRole('list', { name: 'Topics at a glance' })).getAllByRole('button'),
  ).toHaveLength(3)

  // A closed topic folds to a row: number, title, gist, time.
  const budget = topicNamed('Budget')
  expect(within(budget).getByText('0:00–0:38')).toBeInTheDocument()
  expect(within(budget).getByText('The pilot costs too much as planned.')).toBeInTheDocument()
  expect(within(budget).queryByRole('list', { name: 'Keywords' })).toBeNull()

  // Opened: keywords, bullets, decisions, questions, suggestions.
  await userEvent.click(headerOf(budget))
  expect(
    within(within(budget).getByRole('list', { name: 'Keywords' })).getByText('licences'),
  ).toBeInTheDocument()
  expect(within(budget).getByText('Licences are the big item.')).toBeInTheDocument()
  expect(within(budget).getByRole('list', { name: 'Decisions' })).toHaveTextContent(
    'Cap the pilot at ten seats',
  )
  expect(within(budget).getByRole('list', { name: 'Open questions' })).toHaveTextContent(
    'Who signs off the licences?',
  )
  const ask = within(budget).getByRole('group', { name: 'Ask finance for the licence quote' })
  expect(within(ask).getByLabelText('To-do')).toBeInTheDocument()
  expect(within(ask).getByRole('button', { name: 'Send' })).toBeInTheDocument()
  // The first topic has none before it to merge with.
  await userEvent.click(within(budget).getByRole('button', { name: 'Topic actions' }))
  expect(screen.getByRole('menuitem', { name: 'Edit topic' })).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Merge with the previous' })).toBeNull()
  await userEvent.keyboard('{Escape}')
  await userEvent.click(within(topicNamed('Export')).getByRole('button', { name: 'Topic actions' }))
  expect(screen.getByRole('menuitem', { name: 'Merge with the previous' })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')

  // Every decision and open question above the topics, with its topic, folded.
  const rollup = screen.getByRole('region', { name: 'Decisions and open questions' })
  await userEvent.click(within(rollup).getByText('1 decision, 2 open questions'))
  expect(
    within(within(rollup).getByRole('list', { name: 'Open questions' })).getByText('(Export)'),
  ).toBeInTheDocument()

  // The open topic last, as Now, with what is being said.
  const now = screen.getByRole('region', { name: 'Now' })
  expect(within(now).getByText('Now: Release plan')).toBeInTheDocument()
  expect(within(now).getByText('from 1:20')).toBeInTheDocument()
  expect(
    within(within(now).getByRole('list', { name: 'Said now' })).getAllByRole('listitem'),
  ).toHaveLength(3)

  // Tasks: sent or made, not dismissed and not an old suggestion.
  const rail = screen.getByRole('region', { name: 'Tasks' })
  expect(within(rail).getByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
  const titles = [...rail.querySelectorAll('[data-card]')]
  expect(titles.map((t) => t.getAttribute('aria-label'))).toEqual([
    'Export to CSV',
    'Send the invite',
    'Search in notes',
  ])
  expect(within(cardNamed('Export to CSV')).getByText('Not sent')).toBeInTheDocument()
  expect(within(cardNamed('Send the invite')).getByLabelText('To-do')).toBeInTheDocument()
  expect(screen.queryByLabelText('Title')).toBeNull()
  await waitFor(() => expect(calls('meeting.get')).toEqual([{ meetingId: 'm1' }]))
}, 15_000)

test('with no tasks the rail says how to start one', async () => {
  show([], { ...meeting, cards: [] })
  const rail = screen.getByRole('region', { name: 'Tasks' })
  expect(within(rail).getByText('Send a topic to the agent to start.')).toBeInTheDocument()
  expect(within(rail).getByRole('button', { name: 'Custom range' })).toBeEnabled()
}, 15_000)

test('before any topic, the minutes say the assistant groups the meeting as it goes', async () => {
  show([], { ...meeting, topics: [], minutes: '' })
  expect(
    screen.getByText('The assistant groups the meeting into topics every few minutes, as it goes.'),
  ).toBeInTheDocument()
}, 15_000)

test('the header is one row: the topics’ status and the orange recording reminder, nothing to copy', async () => {
  show()
  const row = header()
  expect(within(row).getByRole('button', { name: /Topics writing/ })).toBeInTheDocument()
  const pill = within(row).getByText('Recording · tell everyone')
  // Solid warning orange, not a quiet line.
  expect(pill).toHaveClass('bg-warning')
  // One row, and nothing under it.
  expect(row.parentElement!.children).toHaveLength(1)
  expect(within(row).getByRole('toolbar', { name: 'Audio to record' })).toBeInTheDocument()
  expect(screen.queryByText(/Copy Danish|Copy English/)).toBeNull()
  expect(screen.queryByRole('note')).toBeNull()
  expect(screen.queryByText('Scribe writing')).toBeNull()
  // Nothing is wrong, so there is no row of alerts under it.
  expect(screen.queryByRole('alert')).toBeNull()
}, 15_000)

test('the topics’ chip opens how each part of the meeting is doing, and the assistant’s session', async () => {
  show()
  await userEvent.click(screen.getByRole('button', { name: /Topics writing/ }))
  const details = await screen.findByRole('dialog', { name: 'Meeting details' })
  expect(within(details).getByText('1 transcribing')).toBeInTheDocument()
  expect(within(details).getByText('2.1s behind')).toBeInTheDocument()
  expect(within(details).getByText('writing')).toBeInTheDocument()
  await userEvent.click(
    within(details).getByRole('button', { name: 'Open the assistant’s session' }),
  )
  expect(shown).toEqual([{ session: 'scribe-1', live: false }])
}, 15_000)

test('problems are loud: a badge in the header, and the fix under it', async () => {
  const store = show()
  expect(screen.queryByText('The assistant isn’t receiving the transcript.')).toBeNull()
  act(() =>
    store.set(meetingStatesAtom, {
      m1: {
        ...meeting,
        scribeUnreachable: true,
        chunks: [
          ...meeting.chunks,
          { n: 2, start: 24, duration: 12, state: 'failed', tries: 5, error: 'timeout' },
        ],
      },
    }),
  )
  const health = screen.getByLabelText('Meeting health')
  expect(within(health).getByText('1 not transcribed')).toHaveClass('bg-destructive/10')
  expect(within(health).getByText('Topics unreachable')).toHaveClass('bg-warning/10')
  expect(screen.getByText('The assistant isn’t receiving the transcript.')).toBeInTheDocument()
}, 15_000)

test('topics that stopped, or that the vault’s agent cannot write, say which part and what to do', async () => {
  // The meeting as main has it, when the view loads it again.
  let state: MeetingState = { ...meeting, scribeState: 'gone' }
  const base = run.getMockImplementation()!
  run.mockImplementation(async (c: { name: string }) =>
    c.name === 'meeting.get' ? state : base(c),
  )
  show([], state)
  await userEvent.click(screen.getByRole('button', { name: /Topics stopped/ }))
  const details = await screen.findByRole('dialog', { name: 'Meeting details' })
  expect(details).toHaveTextContent('Recording and captions go on')
  cleanup()

  state = { ...meeting, scribeState: 'off', scribeUnsupported: 'codex' }
  show([], state)
  const health = screen.getByLabelText('Meeting health')
  expect(within(health).getByText('No topics with this agent')).toBeInTheDocument()
  await userEvent.click(within(health).getByRole('button', { name: /Topics off/ }))
  expect(await screen.findByRole('dialog', { name: 'Meeting details' })).toHaveTextContent(
    'Topics need Claude Code',
  )
}, 15_000)

test('Show transcript opens the captions column, and the choice is kept on this machine', async () => {
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Show transcript' }))
  const captions = screen.getByRole('list', { name: 'Transcript' })
  expect(within(captions).getByText('Line 0 of the call')).toBeInTheDocument()
  expect(within(captions).getAllByText('Mic audio').length).toBeGreaterThan(0)
  expect(within(captions).getAllByText('System audio').length).toBeGreaterThan(0)
  // The column reads under the topics' headings.
  expect(within(captions).getByText('Export')).toBeInTheDocument()
  expect(within(captions).getByText('Release plan')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Latest captions' })).toBeNull()
  expect(localStorage.getItem('holi.meetings.show-transcript')).toBe('true')
  await userEvent.click(screen.getByRole('button', { name: 'Hide transcript' }))
  expect(screen.queryByRole('list', { name: 'Transcript' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Latest captions' })).toBeInTheDocument()
  expect(localStorage.getItem('holi.meetings.show-transcript')).toBe('false')
}, 15_000)

test('a task opens in a wide panel with every field to edit and its quotes, one at a time', async () => {
  show()
  const panel = await expand('Export to CSV')
  expect(panel.className).toContain('sm:max-w-xl')
  expect(within(screen.getByRole('region', { name: 'Tasks' })).queryByLabelText('Title')).toBeNull()
  expect(within(panel).getByLabelText('Title')).toHaveValue('Export to CSV')
  expect(within(panel).getByLabelText('Why')).toHaveValue('People asked for it.')
  expect(within(panel).getByLabelText('Criterion 1')).toHaveValue('A CSV downloads from the board')
  expect(within(panel).getByLabelText('Question 1')).toHaveValue('Which columns go in?')
  expect(within(panel).getByText('Ask now')).toBeInTheDocument()
  expect(within(panel).getByLabelText('Owner')).toHaveValue('')
  expect(within(panel).getByRole('list', { name: 'Quotes' })).toBeInTheDocument()
  expect(within(panel).getByLabelText('How should it be done?')).toBeInTheDocument()

  const invite = await expand('Send the invite')
  expect(within(invite).getByLabelText('Owner')).toHaveValue('Anna')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
}, 15_000)

test('a task’s fields are edited and saved, lists gaining and losing items', async () => {
  show()
  const card = await expand('Export to CSV')
  const title = within(card).getByLabelText('Title')
  await userEvent.clear(title)
  await userEvent.type(title, 'Export the board to CSV')
  await userEvent.click(within(card).getByRole('button', { name: 'Add criterion' }))
  await userEvent.type(within(card).getByLabelText('Criterion 2'), 'Columns match the board')
  await userEvent.click(within(card).getByRole('button', { name: 'Remove question 1' }))
  await userEvent.type(within(card).getByLabelText('Owner'), 'Peter')
  await userEvent.click(within(card).getByRole('button', { name: 'Save changes' }))
  expect(calls('meeting.card')).toEqual([
    {
      meetingId: 'm1',
      cardId: 'export',
      patch: {
        title: 'Export the board to CSV',
        acceptance: ['A CSV downloads from the board', 'Columns match the board'],
        openQuestions: [],
        owner: 'Peter',
      },
    },
  ])
}, 15_000)

test(`${SEND_TO_AGENT} saves the task’s edits, then sends it with how it should be done`, async () => {
  show()
  const card = await expand('Export to CSV')
  expect(within(card).queryByRole('button', { name: 'Choose who it goes to' })).toBeNull()
  await userEvent.type(within(card).getByLabelText('Why'), ' Finance too.')
  await userEvent.type(
    within(card).getByLabelText('How should it be done?'),
    'Reuse the export menu',
  )
  await userEvent.click(within(card).getByRole('button', { name: SEND_TO_AGENT }))
  expect(calls('meeting.card')).toEqual([
    { meetingId: 'm1', cardId: 'export', patch: { why: 'People asked for it. Finance too.' } },
  ])
  expect(calls('meeting.build')).toEqual([
    {
      meetingId: 'm1',
      cardId: 'export',
      context: 'Reuse the export menu',
      target: { kind: 'agent' },
    },
  ])
  await waitFor(() => expect(within(cardNamed('Export to CSV')).getByText('Sent')).toBeVisible())
}, 15_000)

test('with Holis, the picker sends to an approved one, and lists one not approved as not pickable', async () => {
  caps.add('holis.send')
  show()
  const card = await expand('Send the invite')
  await waitFor(() => expect(calls('holis.list')).toHaveLength(1))
  await userEvent.click(await within(card).findByRole('button', { name: 'Choose who it goes to' }))
  expect(screen.getByRole('menuitemradio', { name: /Scout/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Proposal' }))
  await userEvent.click(within(card).getByRole('button', { name: 'Send to Proposal' }))
  expect(calls('meeting.build')).toEqual([
    { meetingId: 'm1', cardId: 'invite', target: { kind: 'holi', id: 'proposal' } },
  ])
}, 15_000)

test('Dismiss dismisses a task and closes the panel', async () => {
  show()
  const invite = await expand('Send the invite')
  expect(within(invite).queryByRole('button', { name: 'Accept' })).toBeNull()
  await userEvent.click(within(invite).getByRole('button', { name: 'Dismiss' }))
  expect(calls('meeting.card')).toEqual([
    { meetingId: 'm1', cardId: 'invite', patch: { status: 'dismissed' } },
  ])
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}, 15_000)

test('a quote shows the transcript, finds its line and marks it', async () => {
  show()
  const card = await expand('Export to CSV')
  await userEvent.click(within(card).getByRole('button', { name: /“Line 3 of the call”/ }))
  const transcript = await screen.findByRole('list', { name: 'Transcript' })
  const marked = transcript.querySelector('[aria-current="true"]')
  expect(marked?.getAttribute('data-segment')).toBe('3')
  // Shown for the quote, not kept.
  expect(localStorage.getItem('holi.meetings.show-transcript')).toBeNull()
}, 15_000)

test('a sent task shows its run, and its session opens from its row', async () => {
  show([{ id: 'job-7', name: 'Search in notes', state: 'working' }])
  const sent = cardNamed('Search in notes')
  expect(within(sent).getByText('Running')).toBeInTheDocument()
  await userEvent.click(within(sent).getByRole('button', { name: 'Open session' }))
  expect(shown).toEqual([{ session: 'job-7', live: true }])
  const panel = await expand('Search in notes')
  expect(within(panel).getByText('Sent to the agent to build.')).toBeInTheDocument()
  expect(within(panel).queryByRole('button', { name: SEND_TO_AGENT })).toBeNull()
}, 15_000)

test('a caption line is corrected in place: Enter saves, Escape puts it back', async () => {
  const store = show()
  await userEvent.click(screen.getByRole('button', { name: 'Show transcript' }))
  const captions = screen.getByRole('list', { name: 'Transcript' })
  await userEvent.click(within(captions).getByRole('button', { name: 'Line 4 of the call' }))
  const field = within(captions).getByLabelText('Line 4')
  await userEvent.clear(field)
  await userEvent.type(field, 'Line four, as said{Escape}')
  expect(within(captions).getByRole('button', { name: 'Line 4 of the call' })).toBeInTheDocument()
  expect(calls('meeting.segment.edit')).toEqual([])

  await userEvent.click(within(captions).getByRole('button', { name: 'Line 3 of the call' }))
  const three = within(captions).getByLabelText('Line 3')
  await userEvent.clear(three)
  await userEvent.type(three, 'Export, as said{Enter}')
  expect(calls('meeting.segment.edit')).toEqual([
    { meetingId: 'm1', i: 3, text: 'Export, as said' },
  ])
  const words = within(captions).getByRole('button', { name: 'Export, as said' })
  // `edited` follows the words, not the row's far edge.
  expect(words.nextElementSibling).toHaveTextContent('edited')
  // Main's next state has the task quoting the correction (its own rule).
  act(() =>
    store.set(meetingStatesAtom, (all) => ({
      m1: {
        ...all['m1']!,
        cards: all['m1']!.cards.map((c) => ({
          ...c,
          quotes: c.quotes.map((q) => (q.i === 3 ? { ...q, text: 'Export, as said' } : q)),
        })),
      },
    })),
  )
  const card = await expand('Export to CSV')
  expect(within(card).getByRole('button', { name: /“Export, as said”/ })).toBeInTheDocument()
}, 15_000)

test('Ask the assistant asks for a change to the topics and waits for its next write', async () => {
  const store = show()
  const minutes = screen.getByRole('region', { name: 'Minutes' })
  await userEvent.type(
    within(minutes).getByLabelText('Ask the assistant'),
    'drop the budget talk{Enter}',
  )
  expect(calls('meeting.tell')).toEqual([
    { meetingId: 'm1', text: 'drop the budget talk', kind: 'minutes' },
  ])
  expect(
    await within(minutes).findByText('The assistant is updating the topics…'),
  ).toBeInTheDocument()
  expect(within(minutes).getByLabelText('Ask the assistant')).toHaveValue('')
  // The assistant writing a topic ends the wait.
  act(() =>
    transcribeEvents.meeting!(
      { remote: 'syv/vault', payload: { ...meeting, minutesAt: Date.now() } },
      store,
    ),
  )
  expect(within(minutes).queryByText('The assistant is updating the topics…')).toBeNull()
}, 15_000)

test('a meeting event about the open vault updates what is shown', async () => {
  const store = show()
  await waitFor(() => expect(calls('meeting.get')).toHaveLength(1))
  await act(async () => {})
  const renamed = (title: string): MeetingState => ({
    ...meeting,
    topics: meeting.topics.map((t) => (t.id === 't0' ? { ...t, title } : t)),
  })
  act(() => transcribeEvents.meeting!({ remote: 'syv/vault', payload: renamed('Money') }, store))
  expect(await screen.findByLabelText('Money', { selector: '[data-topic]' })).toBeInTheDocument()
  act(() =>
    transcribeEvents.meeting!({ remote: 'other/vault', payload: renamed('Not ours') }, store),
  )
  expect(screen.queryByText('Not ours')).toBeNull()
}, 15_000)
