/**
 * Custom range: a task made from a stretch of the meeting that is not one
 * topic. The dialog's two-thumb timeline, the presets that set it (the last
 * few minutes, the whole meeting, a closed topic), the preview of the lines
 * in range, and Create, which calls `meeting.task.create` with those lines
 * and opens the new task in the task panel. From the live rail and from the
 * review.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import type { Card, MeetingState } from '../shared/meeting'
import { MeetingsSurface } from '../renderer/meetings-surface'
import { meetingStatesAtom, profilesAtom, shownMeetingIdAtom } from '../renderer/state'
import { meeting, profile } from './meeting-fixture'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))

const calls = (name: string): unknown[] =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => (c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson)))

/** The clock every test reads, held still so a slow machine cannot add a second. */
const NOW = Date.now()
/** Recording for 200 s: its lines run 0:00 to 1:58. */
const live: MeetingState = { ...meeting, startedAt: NOW - 200_000 }

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  run.mockReset()
  localStorage.clear()
  run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
    const params = paramsJson === undefined ? {} : JSON.parse(paramsJson)
    switch (name) {
      case 'meeting.get':
        return state
      case 'meeting.task.create': {
        if (params.prompt === 'fail') throw new Error('nothing was said in that range')
        const card: Card = {
          id: 'c9',
          kind: params.kind,
          title: params.prompt.split('\n')[0],
          why: params.prompt,
          segments: params.lines,
          acceptance: [],
          openQuestions: [],
          quotes: [{ i: 8, speaker: 'Me', start: 80, text: 'Line 8 of the call' }],
          status: 'accepted',
          origin: 'person',
          range: { start: 80, end: 118, lines: params.lines.length },
          createdAt: 5,
          updatedAt: 5,
        }
        return card
      }
      default:
        return { ok: true }
    }
  })
})

let state: MeetingState = live

function show(m: MeetingState) {
  state = m
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingStatesAtom, { m1: m })
  store.set(shownMeetingIdAtom, 'm1')
  render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  return store
}

const thumbs = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('slider')
    .map((t) => Number(t.getAttribute('aria-valuenow')))

async function openDialog(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Custom range' }))
  return screen.findByRole('dialog', { name: 'A task from a custom range' })
}

test('presets set the slider, the preview counts the lines, and Create makes the task and opens it', async () => {
  show(live)
  const dialog = await openDialog()
  // The last five minutes to begin with: the whole of a 200 s meeting.
  expect(thumbs(dialog)).toEqual([0, 200])
  expect(within(dialog).getByRole('radio', { name: 'Last 5 min' })).toBeChecked()
  expect(within(dialog).getByLabelText('Lines in range')).toHaveTextContent('12 lines')

  await userEvent.click(within(dialog).getByRole('radio', { name: 'Last 2 min' }))
  expect(thumbs(dialog)).toEqual([80, 200])
  expect(within(dialog).getByLabelText('Range')).toHaveTextContent('1:20 – 3:20')
  const preview = within(dialog).getByLabelText('Lines in range')
  expect(preview).toHaveTextContent('4 lines')
  expect(within(preview).getByText('Line 8 of the call')).toBeInTheDocument()
  expect(within(preview).getByText('Line 11 of the call')).toBeInTheDocument()

  await userEvent.type(
    within(dialog).getByLabelText('What should be done?'),
    'Turn this into a spec{Enter}for the CI change',
  )
  await userEvent.click(within(dialog).getByRole('radio', { name: 'To-do' }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))
  expect(calls('meeting.task.create')).toEqual([
    {
      meetingId: 'm1',
      lines: [8, 9, 10, 11],
      prompt: 'Turn this into a spec\nfor the CI change',
      kind: 'action',
    },
  ])
  // It opens in the task panel, ready to send, and sits in the rail.
  const panel = await screen.findByRole('dialog', { name: 'Turn this into a spec' })
  expect(within(panel).getByText('To-do from 1:20 to 1:58, 4 lines')).toBeInTheDocument()
  expect(within(panel).getByRole('button', { name: 'Send to the agent' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'A task from a custom range' })).toBeNull()
  const rail = screen.getByRole('region', { name: 'Tasks' })
  expect(
    within(rail).getByLabelText('Turn this into a spec', { selector: '[data-card]' }),
  ).toHaveTextContent('Not sent')
}, 15_000)

test('moving a thumb leaves the preset', async () => {
  show(live)
  const dialog = await openDialog()
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Last 2 min' }))
  const [from] = within(dialog).getAllByRole('slider')
  from!.focus()
  await userEvent.keyboard('{Home}')
  expect(thumbs(dialog)).toEqual([0, 200])
  expect(within(dialog).getByRole('radio', { name: 'Last 2 min' })).not.toBeChecked()
  expect(within(dialog).getByLabelText('Lines in range')).toHaveTextContent('12 lines')
}, 15_000)

test('a range with nothing said in it cannot be made', async () => {
  // Recording for 400 s; the last line ended at 1:58.
  show({ ...live, startedAt: NOW - 400_000 })
  const dialog = await openDialog()
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Last 2 min' }))
  expect(within(dialog).getByLabelText('Lines in range')).toHaveTextContent(
    'Nothing was said in this range.',
  )
  await userEvent.type(within(dialog).getByLabelText('What should be done?'), 'Spec it')
  expect(within(dialog).getByRole('button', { name: 'Create task' })).toBeDisabled()
}, 15_000)

test('a closed topic is a preset over its lines; the open one is not', async () => {
  show(live)
  const dialog = await openDialog()
  const topics = within(dialog).getByRole('radiogroup', { name: 'Topics' })
  expect(
    within(topics)
      .getAllByRole('radio')
      .map((r) => r.textContent),
  ).toEqual(['Budget', 'Export'])
  await userEvent.click(within(topics).getByRole('radio', { name: 'Export' }))
  expect(thumbs(dialog)).toEqual([40, 78])
  expect(within(dialog).getByLabelText('Lines in range')).toHaveTextContent('4 lines')
}, 15_000)

test('on the review, Custom range covers the whole meeting, and says why main refused', async () => {
  show({
    ...meeting,
    phase: 'done',
    endedAt: meeting.startedAt + 754_000,
    scribeState: 'gone',
  })
  const tasks = screen.getByRole('region', { name: 'Tasks' })
  await userEvent.click(within(tasks).getByRole('button', { name: 'Custom range' }))
  const dialog = await screen.findByRole('dialog', { name: 'A task from a custom range' })
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Whole meeting' }))
  expect(thumbs(dialog)).toEqual([0, 754])
  await userEvent.type(within(dialog).getByLabelText('What should be done?'), 'fail')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))
  await waitFor(() =>
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'The task wasn’t made: nothing was said in that range',
    ),
  )
  expect(calls('meeting.task.create')).toEqual([
    {
      meetingId: 'm1',
      lines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      prompt: 'fail',
      kind: 'feature',
    },
  ])
}, 15_000)
