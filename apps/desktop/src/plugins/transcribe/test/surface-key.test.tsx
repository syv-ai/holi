/**
 * The speech key in the Meetings tab: the notice without a key, Save sending
 * the key to main through a password field, the fix beside a meeting that
 * waits on its key, and the header's control, which shows where the key
 * comes from and never the key.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import type { SpeechKeyStatus } from '../main/speech-key'
import { MeetingsSurface } from '../renderer/meetings-surface'
import {
  meetingStatesAtom,
  meetingsAtom,
  profilesAtom,
  shownMeetingIdAtom,
  speechKeyAtom,
} from '../renderer/state'
import { meeting, profile } from './meeting-fixture'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))

const KEY = 'hv_0123456789abcdefghijklmnopqrstuv'

const calls = (name: string): unknown[] =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => (c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson)))

/** Main's answer to `meeting.key.status`, as the test moves it along. */
let status: SpeechKeyStatus = { set: false, source: null }

beforeEach(() => {
  status = { set: false, source: null }
  run.mockReset()
  run.mockImplementation(async ({ name }: { name: string }) => {
    switch (name) {
      case 'meeting.key.status':
        return status
      case 'meeting.key.set':
        status = { set: true, source: 'app' }
        return { ok: true }
      case 'meeting.key.clear':
        status = { set: false, source: null }
        return { ok: true }
      case 'meeting.get':
        return meeting
      default:
        return { ok: true }
    }
  })
})

function show(opts: { key: SpeechKeyStatus; blocked?: 'no-key' | 'bad-key' }) {
  status = opts.key
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingsAtom, [])
  store.set(speechKeyAtom, opts.key)
  if (opts.blocked !== undefined) {
    store.set(meetingStatesAtom, { m1: { ...meeting, blocked: opts.blocked } })
    store.set(shownMeetingIdAtom, 'm1')
  }
  render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  return store
}

test('without a key, a notice above Record takes one in a password field', async () => {
  show({ key: { set: false, source: null } })
  const notice = screen.getByRole('alert', { name: 'Speech key' })
  expect(within(notice).getByText('Add your syv.ai speech key to transcribe')).toBeInTheDocument()
  expect(
    within(notice).getByText('Stored encrypted on this Mac, never in the vault or git.'),
  ).toBeInTheDocument()
  // Record stays possible.
  expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled()

  const field = within(notice).getByLabelText('syv.ai speech key')
  expect(field).toHaveAttribute('type', 'password')
  await userEvent.click(field)
  await userEvent.paste(KEY)
  await userEvent.click(within(notice).getByRole('button', { name: 'Save' }))

  await waitFor(() => expect(calls('meeting.key.set')).toEqual([{ key: KEY }]))
  await waitFor(() => expect(screen.queryByRole('alert', { name: 'Speech key' })).toBeNull())
}, 15_000)

test('with a key, there is no notice', () => {
  show({ key: { set: true, source: 'vault' } })
  expect(screen.queryByRole('alert', { name: 'Speech key' })).toBeNull()
}, 15_000)

test('a meeting waiting on a refused key says so, with the fix beside it, once', async () => {
  show({ key: { set: true, source: 'app' }, blocked: 'bad-key' })
  expect(screen.getByLabelText('Meeting health')).toHaveTextContent('Speech key refused')
  const fixes = screen.getAllByRole('alert', { name: 'Speech key' })
  expect(fixes).toHaveLength(1)
  expect(within(fixes[0]!).getByText('syv.ai refused the speech key')).toBeInTheDocument()
  expect(within(fixes[0]!).getByLabelText('syv.ai speech key')).toHaveAttribute('type', 'password')
}, 15_000)

test('a meeting waiting for a key shows its own fix instead of the notice', () => {
  show({ key: { set: false, source: null }, blocked: 'no-key' })
  expect(screen.getByLabelText('Meeting health')).toHaveTextContent('No speech key')
  const fixes = screen.getAllByRole('alert', { name: 'Speech key' })
  expect(fixes).toHaveLength(1)
  expect(
    within(fixes[0]!).getByText('Transcription is waiting for a speech key'),
  ).toBeInTheDocument()
}, 15_000)

test('the header’s control says where the key comes from, and removes this Mac’s', async () => {
  show({ key: { set: true, source: 'app' } })
  await userEvent.click(screen.getByRole('button', { name: 'Profiles and speech key' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Speech key…' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('A key is set on this Mac.')).toBeInTheDocument()
  expect(dialog.textContent).not.toContain('hv_')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(calls('meeting.key.clear')).toHaveLength(1))
  await waitFor(() => expect(within(dialog).getByText('No key is set.')).toBeInTheDocument())
}, 15_000)
