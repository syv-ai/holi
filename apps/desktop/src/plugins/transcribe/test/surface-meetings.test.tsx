/**
 * A meeting renamed and deleted: from the list, each row's menu renames it in
 * place (Enter saves, Escape keeps the old title) and deletes it once asked;
 * from its review, the same, and a deleted meeting goes back to the list. A
 * meeting that records cannot be deleted. And a meeting as a folder of the
 * vault's tree: the New menu makes one and opens its setup, Record starts it
 * there, and an existing one opens as itself.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { act, cleanup, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import type { MeetingState, MeetingSummary } from '../shared/meeting'
import { startCapture } from '../renderer/audio/capture'
import { MEETING_CLAIM } from '../renderer/meeting-claim'
import { MeetingsSurface } from '../renderer/meetings-surface'
import { stopRecordingAtom } from '../renderer/recorder'
import {
  meetingsAtom,
  meetingStatesAtom,
  profilesAtom,
  shownMeetingIdAtom,
} from '../renderer/state'
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

const done: MeetingState = {
  ...meeting,
  topics: meeting.topics.map((t) => ({ ...t, open: false })),
  phase: 'done',
  endedAt: meeting.startedAt + 754_000,
  scribeState: 'gone',
}

const summary = (over: Partial<MeetingSummary>): MeetingSummary => ({
  id: 'm1',
  title: 'Planning call',
  startedAt: meeting.startedAt,
  phase: 'done',
  cards: 3,
  folder: 'Meetings/2026-11-02 Planning call',
  ...over,
})

const LIST = [
  summary({}),
  summary({ id: 'm2', title: 'Live one', phase: 'recording', startedAt: meeting.startedAt + 1 }),
]

beforeEach(() => {
  run.mockReset()
  run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
    const params = paramsJson === undefined ? {} : JSON.parse(paramsJson)
    switch (name) {
      case 'meeting.get':
        return done
      case 'meeting.list':
        return LIST
      case 'meeting.rename':
        return summary({ id: params.meetingId, title: params.title })
      default:
        return { ok: true }
    }
  })
})

function show(shown: string | null = null) {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingsAtom, LIST)
  store.set(meetingStatesAtom, { m1: done })
  store.set(shownMeetingIdAtom, shown)
  render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  return store
}

const rowOf = (title: string) =>
  within(screen.getByRole('region', { name: 'Past meetings' }))
    .getByText(title)
    .closest('li') as HTMLElement

async function menu(row: HTMLElement, item: string): Promise<void> {
  await userEvent.click(within(row).getByRole('button', { name: 'Meeting actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: item }))
}

test('a meeting in the list is renamed in place; Escape keeps its title', async () => {
  show()
  await menu(rowOf('Planning call'), 'Rename')
  const title = screen.getByLabelText('Rename meeting')
  expect(title).toHaveValue('Planning call')
  await userEvent.clear(title)
  await userEvent.type(title, 'Roadmap review{Enter}')
  expect(calls('meeting.rename')).toEqual([{ meetingId: 'm1', title: 'Roadmap review' }])
  expect(await screen.findByText('Roadmap review')).toBeInTheDocument()

  await menu(rowOf('Roadmap review'), 'Rename')
  await userEvent.type(screen.getByLabelText('Rename meeting'), ' and more{Escape}')
  expect(calls('meeting.rename')).toHaveLength(1)
  expect(screen.getByText('Roadmap review')).toBeInTheDocument()
}, 15_000)

test('a meeting in the list is deleted once asked; one that records cannot be', async () => {
  show()
  await userEvent.click(within(rowOf('Live one')).getByRole('button', { name: 'Meeting actions' }))
  expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await userEvent.keyboard('{Escape}')

  await menu(rowOf('Planning call'), 'Delete')
  const ask = await screen.findByRole('alertdialog', { name: 'Delete “Planning call”?' })
  expect(ask).toHaveTextContent('Tasks made from it stay.')
  await userEvent.click(within(ask).getByRole('button', { name: 'Delete meeting' }))
  expect(calls('meeting.delete')).toEqual([{ meetingId: 'm1' }])
  await waitFor(() => expect(screen.queryByText('Planning call')).toBeNull())
  expect(screen.getByText('Live one')).toBeInTheDocument()
}, 15_000)

test('from its review a meeting is renamed, and deleted back to the list', async () => {
  const store = show('m1')
  await userEvent.click(screen.getByRole('button', { name: 'Meeting actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
  const title = screen.getByLabelText('Rename meeting')
  await userEvent.clear(title)
  await userEvent.type(title, 'Kickoff{Enter}')
  expect(await screen.findByRole('heading', { name: 'Kickoff' })).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Meeting actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
  const ask = await screen.findByRole('alertdialog')
  await userEvent.click(within(ask).getByRole('button', { name: 'Delete meeting' }))
  await waitFor(() => expect(store.get(shownMeetingIdAtom)).toBeNull())
  expect(store.get(meetingStatesAtom)).toEqual({})
  expect(screen.getByRole('region', { name: 'Past meetings' })).toBeInTheDocument()
}, 15_000)

test('a meeting folder from the New menu opens as its setup, and Record starts it there', async () => {
  const path = 'Clients/Acme/2026-11-04 Kickoff.meeting'
  run.mockImplementation(async ({ name }: { name: string }) => {
    switch (name) {
      case 'meeting.prepare':
        return { path }
      case 'meeting.key.status':
        return { set: true, source: 'app', service: { url: null, model: null }, ready: true }
      case 'meeting.start':
        return { meetingId: 'm9' }
      default:
        return { ok: true }
    }
  })
  vi.mocked(startCapture).mockResolvedValue({
    stop: async () => {},
    sources: { microphone: true, system: true },
    problems: [],
  })
  // The New menu makes the folder and opens it as the meeting.
  const opened = await MEETING_CLAIM.create!.run({
    remote: 'syv/vault',
    parent: 'Clients/Acme',
    name: 'Kickoff',
  })
  expect(calls('meeting.prepare')).toEqual([{ folder: 'Clients/Acme', title: 'Kickoff' }])
  expect(opened).toBe(`${path}/transcript.local.md`)
  expect(MEETING_CLAIM.match(path)).toBe(true)
  expect(MEETING_CLAIM.decorate!.name(path)).toBe('2026-11-04 Kickoff')

  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingsAtom, LIST)
  render(
    <Provider store={store}>
      <MeetingsSurface id={path} />
    </Provider>,
  )
  expect(screen.getByText('2026-11-04 Kickoff is not recorded yet')).toBeInTheDocument()
  expect(screen.getByLabelText('Meeting title')).toHaveValue('Kickoff')
  // No list to go back to: this tab is the meeting.
  expect(screen.queryByRole('button', { name: 'All meetings' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Record' }))
  await waitFor(() =>
    expect(calls('meeting.start')).toEqual([{ profileId: 'planning', title: 'Kickoff', path }]),
  )
  await act(() => store.set(stopRecordingAtom))
}, 15_000)

test('a meeting folder opened from the tree shows that meeting', async () => {
  const store = show()
  cleanup()
  render(
    <Provider store={store}>
      <MeetingsSurface id={LIST[0]!.folder} />
    </Provider>,
  )
  expect(await screen.findByRole('heading', { name: done.title })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Past meetings' })).toBeNull()
}, 15_000)
