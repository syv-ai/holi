/**
 * Recording a meeting: Record starts it in main and starts the capture, each
 * chunk goes to main as it closes, Stop hands over the last one before the
 * meeting stops; failures show without stopping the recording, and leaving
 * the tab keeps it going.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import type { CaptureOptions } from '../shared/meeting'
import { startCapture } from '../renderer/audio/capture'
import { MeetingsSurface } from '../renderer/meetings-surface'
import { RecordingStatusItem } from '../renderer/recording-status-item'
import { recorderAtom, startRecordingAtom, stopRecordingAtom } from '../renderer/recorder'
import { meetingsAtom, profilesAtom, shownMeetingIdAtom } from '../renderer/state'
import { meeting, profile } from './meeting-fixture'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))

const names = () => run.mock.calls.map(([c]) => (c as { name: string }).name)
const calls = (name: string): unknown[] =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => (c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson)))

const wav = (...bytes: number[]) => new Uint8Array(bytes).buffer
let options: CaptureOptions | null = null
const stopCapture = vi.fn(async () => {
  options?.onChunk({ n: 1, start: 6, duration: 2, wav: wav(4, 5) })
})

beforeEach(() => {
  options = null
  stopCapture.mockClear()
  run.mockReset()
  run.mockImplementation(async ({ name }: { name: string }) => {
    if (name === 'meeting.start') return { meetingId: 'm9' }
    if (name === 'meeting.get') return { ...meeting, id: 'm9', segments: [], cards: [], chunks: [] }
    return { ok: true }
  })
  vi.mocked(startCapture).mockReset()
  vi.mocked(startCapture).mockImplementation(async (o) => {
    options = o
    return { stop: stopCapture }
  })
})

afterEach(() => vi.useRealTimers())

function storeFor() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingsAtom, [])
  return store
}

test('Record starts the meeting and the capture, chunks go to main, Stop closes it', async () => {
  const store = storeFor()
  render(
    <Provider store={store}>
      <MeetingsSurface />
      <RecordingStatusItem />
    </Provider>,
  )
  await userEvent.type(screen.getByLabelText('Meeting title'), 'Planning')
  await userEvent.click(screen.getByRole('button', { name: 'Computer audio' }))
  await userEvent.click(screen.getByRole('button', { name: 'Record' }))

  await waitFor(() => expect(store.get(recorderAtom).phase).toBe('recording'))
  expect(calls('meeting.start')).toEqual([{ profileId: 'planning', title: 'Planning' }])
  expect(vi.mocked(startCapture).mock.calls[0]?.[0]).toMatchObject({
    microphone: true,
    system: false,
  })
  expect(store.get(shownMeetingIdAtom)).toBe('m9')
  expect(screen.getByRole('button', { name: 'Recording meeting' })).toBeInTheDocument()
  // The reminder that everyone is being recorded, loud, and no copying the
  // transcript while it records.
  expect(await screen.findByText('Recording · tell everyone')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copy transcript' })).toBeNull()
  // While it records, the header names the meeting instead of asking for a title.
  expect(screen.queryByLabelText('Meeting title')).toBeNull()

  act(() => options?.onChunk({ n: 0, start: 0, duration: 6, wav: wav(1, 2, 3) }))
  await waitFor(() =>
    expect(calls('meeting.chunk')).toEqual([
      { meetingId: 'm9', n: 0, start: 0, duration: 6, audio: 'AQID' },
    ]),
  )

  await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() => expect(store.get(recorderAtom).phase).toBe('idle'))
  expect(stopCapture).toHaveBeenCalledOnce()
  // The last partial chunk reaches main before the meeting stops.
  expect(names().filter((n) => n !== 'meeting.get')).toEqual([
    'meeting.start',
    'meeting.chunk',
    'meeting.chunk',
    'meeting.stop',
  ])
  expect(calls('meeting.stop')).toEqual([{ meetingId: 'm9' }])
  expect(screen.queryByRole('button', { name: 'Recording meeting' })).toBeNull()
  // Stop lands on the meeting's review.
  expect(await screen.findByRole('button', { name: 'Copy transcript' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Export minutes' })).toBeInTheDocument()
  expect(screen.queryByLabelText('Ask Hviske')).toBeNull()
  expect(screen.queryByText('Recording · tell everyone')).toBeNull()
}, 15_000)

test('the recording outlives the tab, and the status item brings it back', async () => {
  const store = storeFor()
  const surface = render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Record' }))
  await waitFor(() => expect(store.get(recorderAtom).phase).toBe('recording'))
  surface.unmount()

  act(() => options?.onChunk({ n: 0, start: 0, duration: 6, wav: wav(1) }))
  await waitFor(() => expect(calls('meeting.chunk')).toHaveLength(1))
  store.set(shownMeetingIdAtom, null)
  render(
    <Provider store={store}>
      <RecordingStatusItem />
    </Provider>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Recording meeting' }))
  expect(store.get(shownMeetingIdAtom)).toBe('m9')
  await act(() => store.set(stopRecordingAtom))
  expect(store.get(recorderAtom).phase).toBe('idle')
}, 15_000)

test('a chunk that never reaches main is shown, and the recording goes on', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const store = storeFor()
  await store.set(startRecordingAtom, {
    profileId: 'planning',
    title: '',
    microphone: true,
    system: true,
  })
  expect(calls('meeting.start')).toEqual([{ profileId: 'planning' }])
  run.mockImplementation(async ({ name }: { name: string }) => {
    if (name === 'meeting.chunk') throw new Error('main is busy')
    return { ok: true }
  })
  options?.onChunk({ n: 4, start: 24, duration: 6, wav: wav(1) })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(calls('meeting.chunk')).toHaveLength(3)
  expect(store.get(recorderAtom)).toMatchObject({
    phase: 'recording',
    failedUploads: 1,
    error: expect.stringContaining('Chunk 4 didn’t reach Holi: main is busy'),
  })
}, 15_000)

test('a retried chunk that main already has counts as delivered', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const store = storeFor()
  await store.set(startRecordingAtom, {
    profileId: 'planning',
    title: '',
    microphone: true,
    system: true,
  })
  // The first try lands in main, but its answer is lost on the way back.
  let tries = 0
  run.mockImplementation(async ({ name }: { name: string }) => {
    if (name !== 'meeting.chunk') return { ok: true }
    throw new Error(++tries === 1 ? 'the window was busy' : 'chunk 4 is already in')
  })
  options?.onChunk({ n: 4, start: 24, duration: 6, wav: wav(1) })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(calls('meeting.chunk')).toHaveLength(2)
  expect(store.get(recorderAtom)).toMatchObject({ failedUploads: 0, error: null })
}, 15_000)

test('a capture Holi may not start closes the meeting and says what to do', async () => {
  vi.mocked(startCapture).mockRejectedValue(
    Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
  )
  const store = storeFor()
  render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Record' }))
  expect(await screen.findByText(/Allow the microphone/)).toBeInTheDocument()
  expect(store.get(recorderAtom).phase).toBe('idle')
  expect(calls('meeting.stop')).toEqual([{ meetingId: 'm9' }])
  expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled()
}, 15_000)
