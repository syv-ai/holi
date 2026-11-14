/**
 * A stopped meeting's review: its title, date and length; Copy transcript as
 * `[m:ss] Speaker: text` lines; Export minutes as a markdown file or, with the
 * PDF plugin on, a PDF; Open in vault; the topics with their roll-up, still
 * editable and sendable; its Tasks, sent with their runs or not sent yet;
 * the transcript under the topics' headings, searchable; and a meeting saved
 * before topics, whose scribe's minutes show as they are.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore, type PrimitiveAtom } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, agentSessionRowsAtom, type AgentSessionRow } from '@/plugin-api'
import type { MeetingState } from '../shared/meeting'
import { MeetingsSurface } from '../renderer/meetings-surface'
import { meetingStatesAtom, profilesAtom, shownMeetingIdAtom } from '../renderer/state'
import { transcriptText } from '../renderer/transcript-text'
import { meeting, profile } from './meeting-fixture'

/** The send button's words while main has not named the vault's agent. */
const SEND_TO_AGENT = 'Send to the agent'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))

const shown = vi.hoisted((): unknown[] => [])
const opened = vi.hoisted((): string[] => [])
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
    openPathAtom: atom(null, (_get, _set, path: string) => void opened.push(path)),
    useHasCapability: (name: string) => caps.has(name),
  }
})

const calls = (name: string): unknown[] =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => (c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson)))

const done: MeetingState = {
  ...meeting,
  topics: meeting.topics.map((t) => ({ ...t, open: false })),
  phase: 'done',
  endedAt: meeting.startedAt + 754_000,
  scribeState: 'gone',
}

const saveDialog = vi.fn<(input: unknown) => Promise<string | null>>()
const writeText = vi.fn(async (_text: string) => {})
let reviewStore: ReturnType<typeof createStore>
let reviewRerender: (ui: React.ReactNode) => void = () => {}

beforeEach(() => {
  run.mockReset()
  shown.length = 0
  opened.length = 0
  caps.clear()
  saveDialog.mockReset()
  writeText.mockClear()
  Object.assign(window, { holi: { showSaveDialog: saveDialog, openPath: vi.fn() } })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
    const params = paramsJson === undefined ? {} : JSON.parse(paramsJson)
    switch (name) {
      case 'meeting.get':
        return done
      case 'meeting.export':
        return { path: params.out, vaultPath: 'Meetings/minutes.md' }
      case 'meeting.segment.replace':
        return done.segments
          .filter((x) => x.text.toLowerCase().includes(params.find.toLowerCase()))
          .map((x) => ({ ...x, text: x.text.replace(/line 9/i, params.replace), edited: true }))
      case 'pdf.render':
        return { pdfPath: params.out, vaultPath: 'Meetings/minutes.pdf', warnings: [] }
      default:
        return { ok: true }
    }
  })
})

function show(rows: readonly AgentSessionRow[] = [], state: MeetingState = done) {
  const store = createStore()
  reviewStore = store
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingStatesAtom, { m1: state })
  store.set(shownMeetingIdAtom, 'm1')
  store.set(agentSessionRowsAtom as unknown as PrimitiveAtom<readonly AgentSessionRow[]>, rows)
  const view = render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  reviewRerender = (ui) => view.rerender(ui)
  return store
}

test('the transcript copies as one `[m:ss] Speaker: text` line each', () => {
  expect(transcriptText(meeting.segments.slice(0, 2))).toBe(
    '[0:00] Mic audio: Line 0 of the call\n[0:10] System audio: Line 1 of the call',
  )
})

test('a stopped meeting opens on its review: title, length, actions, topics, tasks, transcript', async () => {
  show([{ id: 'job-7', name: 'Search in notes', state: 'needs-you' }])
  expect(screen.getByRole('heading', { name: 'Planning call' })).toBeInTheDocument()
  expect(screen.getByText('· 12:34')).toBeInTheDocument()
  // Every topic closed, the last one too; the roll-up above them.
  const plan = screen.getByLabelText('Release plan', { selector: '[data-topic]' })
  expect(within(plan).getByText('1:20–1:58')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Now' })).toBeNull()
  // Folded at first; Expand all opens every topic, and Collapse all folds them again.
  expect(screen.queryByLabelText('Search in notes', { selector: '[data-suggestion]' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
  expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument()
  const rollup = screen.getByRole('region', { name: 'Decisions and open questions' })
  await userEvent.click(within(rollup).getAllByRole('button')[0]!)
  expect(rollup).toHaveTextContent('Cap the pilot at ten seats')
  // No live parts: no asking the assistant, no Summarise now, no recording reminder.
  expect(screen.queryByLabelText('Ask the assistant')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Summarise now' })).toBeNull()
  expect(screen.queryByText('Recording · tell everyone')).toBeNull()
  // A suggestion sent from it shows its run where it was suggested.
  const search = screen.getByLabelText('Search in notes', { selector: '[data-suggestion]' })
  expect(within(search).getByText('Needs you')).toBeInTheDocument()

  const from = screen.getByRole('region', { name: 'Tasks' })
  const sent = within(from).getByLabelText('Search in notes', { selector: '[data-card]' })
  expect(within(sent).getByText('Needs you')).toBeInTheDocument()
  await userEvent.click(within(sent).getByRole('button', { name: 'Open session' }))
  expect(shown).toEqual([{ session: 'job-7', live: true }])
  // Not sent yet, and still sendable from here.
  const unsent = within(from).getByLabelText('Export to CSV', { selector: '[data-card]' })
  await userEvent.click(within(unsent).getAllByRole('button')[0]!)
  const panel = await screen.findByRole('dialog', { name: 'Export to CSV' })
  await userEvent.click(within(panel).getByRole('button', { name: SEND_TO_AGENT }))
  expect(calls('meeting.build')).toEqual([
    { meetingId: 'm1', cardId: 'export', target: { kind: 'agent' } },
  ])

  await userEvent.click(screen.getByRole('button', { name: 'Open in vault' }))
  expect(opened).toEqual(['Meetings/2026-11-02 Planning call/minutes.local.md'])
}, 15_000)

test('parking a task editor retains title and context, while closing discards them', async () => {
  show()
  const card = within(screen.getByRole('region', { name: 'Tasks' })).getByLabelText(
    'Export to CSV',
    {
      selector: '[data-card]',
    },
  )
  await userEvent.click(within(card).getAllByRole('button')[0]!)
  const editor = await screen.findByRole('dialog', { name: 'Export to CSV' })
  await userEvent.clear(within(editor).getByLabelText('Title'))
  await userEvent.type(within(editor).getByLabelText('Title'), 'Revised export')
  await userEvent.type(
    within(editor).getByLabelText('How should it be done?'),
    'Use the new template',
  )
  reviewRerender(
    <Provider store={reviewStore}>
      <MeetingsSurface visible={false} />
    </Provider>,
  )
  expect(screen.queryByRole('dialog', { name: 'Export to CSV' })).toBeNull()
  reviewRerender(
    <Provider store={reviewStore}>
      <MeetingsSurface visible />
    </Provider>,
  )
  const restored = await screen.findByRole('dialog', { name: 'Export to CSV' })
  expect(within(restored).getByLabelText('Title')).toHaveValue('Revised export')
  expect(within(restored).getByLabelText('How should it be done?')).toHaveValue(
    'Use the new template',
  )
  await userEvent.click(within(restored).getByRole('button', { name: 'Close' }))
  await userEvent.click(within(card).getAllByRole('button')[0]!)
  const reopened = await screen.findByRole('dialog', { name: 'Export to CSV' })
  expect(within(reopened).getByLabelText('Title')).toHaveValue('Export to CSV')
  expect(within(reopened).getByLabelText('How should it be done?')).toHaveValue('')
}, 15_000)

test('Copy transcript copies every line, and the transcript searches', async () => {
  show()
  // In the review's actions, and beside the transcript's search.
  const transcript = screen.getByRole('region', { name: 'Transcript' })
  await userEvent.click(screen.getAllByRole('button', { name: 'Copy transcript' })[0]!)
  expect(writeText).toHaveBeenCalledWith(transcriptText(meeting.segments))
  await userEvent.click(within(transcript).getByRole('button', { name: 'Copy transcript' }))
  expect(writeText).toHaveBeenCalledTimes(2)
  expect(within(transcript).getAllByRole('listitem')).toHaveLength(12)
  await userEvent.type(within(transcript).getByLabelText('Search the transcript'), 'line 1')
  expect(
    within(transcript)
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual([
    expect.stringContaining('Line 1 of the call'),
    expect.stringContaining('Line 10 of the call'),
    expect.stringContaining('Line 11 of the call'),
  ])
}, 15_000)

test('the transcript reads under the topics’ headings, and a topic is still sent from the review', async () => {
  show()
  const transcript = screen.getByRole('region', { name: 'Transcript' })
  expect(within(transcript).getByRole('heading', { name: /Budget/ })).toBeInTheDocument()
  expect(
    within(within(transcript).getByRole('list', { name: 'Export' })).getAllByRole('listitem'),
  ).toHaveLength(4)
  await userEvent.click(
    within(screen.getByLabelText('Budget', { selector: '[data-topic]' })).getByRole('button', {
      name: 'Send topic',
    }),
  )
  expect(await screen.findByRole('dialog', { name: 'Send: Budget' })).toBeInTheDocument()
}, 15_000)

test('a meeting saved before topics shows the minutes its scribe wrote', async () => {
  show([], { ...done, topics: [], minutes: '## Decisions\n\n- Ship the export button' })
  expect(screen.getByText('Ship the export button')).toBeInTheDocument()
  expect(screen.queryByText('This meeting has no topics.')).toBeNull()
}, 15_000)

test('Export minutes saves a markdown file where the save sheet says, and no PDF without the plugin', async () => {
  saveDialog.mockResolvedValue('/vault/Meetings/minutes.md')
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Export minutes' }))
  expect(screen.queryByRole('menuitem', { name: 'PDF…' })).toBeNull()
  await userEvent.click(screen.getByRole('menuitem', { name: 'Markdown file…' }))
  await waitFor(() =>
    expect(calls('meeting.export')).toEqual([
      { meetingId: 'm1', out: '/vault/Meetings/minutes.md' },
    ]),
  )
  expect(saveDialog).toHaveBeenCalledWith({
    remote: 'syv/vault',
    path: 'Meetings/2026-11-02 Planning call/minutes.local.md',
    extension: 'md',
    filterName: 'Markdown',
  })
  expect(opened).toEqual(['Meetings/minutes.md'])
}, 15_000)

test('Export minutes as PDF goes through the PDF plugin’s render when it is on', async () => {
  caps.add('pdf.render')
  saveDialog.mockResolvedValue('/vault/Meetings/minutes.pdf')
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Export minutes' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'PDF…' }))
  await waitFor(() =>
    expect(calls('pdf.render')).toEqual([
      {
        path: 'Meetings/2026-11-02 Planning call/minutes.local.md',
        template: 'plain',
        out: '/vault/Meetings/minutes.pdf',
      },
    ]),
  )
  expect(opened).toEqual(['Meetings/minutes.pdf'])
}, 15_000)

test('a cancelled save sheet exports nothing', async () => {
  saveDialog.mockResolvedValue(null)
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Export minutes' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Markdown file…' }))
  await waitFor(() => expect(saveDialog).toHaveBeenCalled())
  expect(calls('meeting.export')).toEqual([])
}, 15_000)

test('a speaker’s run of lines reads under their name once', async () => {
  show([], {
    ...done,
    segments: done.segments.map((x) => ({ ...x, speaker: x.i < 2 ? 'Me' : 'Them' })),
  })
  const transcript = screen.getByRole('region', { name: 'Transcript' })
  const budget = within(transcript).getByRole('list', { name: 'Budget' })
  const names = within(budget)
    .getAllByRole('listitem')
    .map((li) => [li.getAttribute('data-segment'), within(li).queryByText(/audio$/)?.textContent])
  expect(names).toEqual([
    ['0', 'Mic audio'],
    ['1', undefined],
    ['2', 'System audio'],
    ['3', undefined],
  ])
}, 15_000)

test('search marks what it found, and Replace all corrects every line it is in', async () => {
  show()
  const transcript = screen.getByRole('region', { name: 'Transcript' })
  await userEvent.type(within(transcript).getByLabelText('Search the transcript'), 'LINE 9')
  expect(within(transcript).getByText('1 line')).toBeInTheDocument()
  expect(transcript.querySelector('mark')?.textContent).toBe('Line 9')
  await userEvent.click(within(transcript).getByRole('button', { name: 'Replace' }))
  await userEvent.type(within(transcript).getByLabelText('Replace with'), 'Line nine')
  await userEvent.click(within(transcript).getByRole('button', { name: 'Replace all' }))
  expect(calls('meeting.segment.replace')).toEqual([
    { meetingId: 'm1', find: 'LINE 9', replace: 'Line nine', all: true },
  ])
  expect(await within(transcript).findByText('No line says “LINE 9”.')).toBeInTheDocument()
  await userEvent.clear(within(transcript).getByLabelText('Search the transcript'))
  expect(within(transcript).getByText('Line nine of the call')).toBeInTheDocument()
}, 15_000)
