/**
 * The speech service in the Meetings tab: the notice while meetings cannot
 * be transcribed, Record opening the setup instead of recording, Save sending
 * the key to main through a password field, another service set by its
 * address and model, the fix beside a meeting that waits on its key, and the
 * header's control, which shows where the key comes from and never the key.
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

const SYV = { url: null, model: null }

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
let status: SpeechKeyStatus = {
  set: false,
  source: null,
  service: SYV,
  ready: false,
  elsewhere: false,
}

beforeEach(() => {
  status = { set: false, source: null, service: SYV, ready: false, elsewhere: false }
  run.mockReset()
  run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
    switch (name) {
      case 'meeting.key.status':
        return status
      case 'meeting.service.set': {
        const { url, model } = JSON.parse(paramsJson ?? '{}') as SpeechKeyStatus['service']
        const service = { url, model }
        status = { ...status, service, ready: status.set || service.url !== null }
        return status
      }
      case 'meeting.key.set':
        status = { set: true, source: 'app', service: SYV, ready: true, elsewhere: false }
        return { ok: true }
      case 'meeting.key.clear':
        status = { set: false, source: null, service: SYV, ready: false, elsewhere: false }
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

test('without a key, Record opens the speech service, where the key is saved', async () => {
  show({ key: { set: false, source: null, service: SYV, ready: false, elsewhere: false } })
  const notice = screen.getByRole('alert', { name: 'Speech service' })
  expect(within(notice).getByText('Set up transcription before you record')).toBeInTheDocument()

  // Record sets up first: nothing starts recording without transcription.
  await userEvent.click(screen.getByRole('button', { name: 'Record' }))
  const dialog = await screen.findByRole('dialog', { name: 'Speech service' })
  expect(calls('meeting.start')).toEqual([])
  expect(
    within(dialog).getByText('Stored encrypted on this Mac, never in the vault or git.'),
  ).toBeInTheDocument()
  const field = within(dialog).getByLabelText('syv.ai speech key')
  expect(field).toHaveAttribute('type', 'password')
  await userEvent.click(field)
  await userEvent.paste(KEY)
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

  await waitFor(() => expect(calls('meeting.key.set')).toEqual([{ key: KEY }]))
  await waitFor(() => expect(screen.queryByRole('alert', { name: 'Speech service' })).toBeNull())
}, 15_000)

test('another speech service is set by its address and model, and needs no key', async () => {
  show({ key: { set: false, source: null, service: SYV, ready: false, elsewhere: false } })
  await userEvent.click(screen.getByRole('button', { name: 'Set up…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Speech service' })
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Another service' }))
  await userEvent.type(within(dialog).getByLabelText('Address'), 'http://localhost:8000/v1')
  await userEvent.type(within(dialog).getByLabelText('Model'), 'whisper-large-v3')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save service' }))
  await waitFor(() =>
    expect(calls('meeting.service.set')).toEqual([
      { url: 'http://localhost:8000/v1', model: 'whisper-large-v3', moveKey: false },
    ]),
  )
  expect(await within(dialog).findByText('Service saved.')).toBeInTheDocument()
  expect(
    within(dialog).getByText('No key is set: the service is asked without one.'),
  ).toBeInTheDocument()
  expect(within(dialog).getByLabelText('API key')).toHaveAttribute('type', 'password')
  await waitFor(() => expect(screen.queryByRole('alert', { name: 'Speech service' })).toBeNull())
}, 15_000)

test('a key saved for syv.ai goes to another service only when the box is ticked', async () => {
  show({ key: { set: true, source: 'app', service: SYV, ready: true, elsewhere: false } })
  await userEvent.click(screen.getByRole('button', { name: 'Profiles and speech service' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Speech service…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Speech service' })
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Another service' }))
  const move = within(dialog).getByRole('checkbox', {
    name: 'Move this Mac’s saved key to the new service',
  })
  expect(move).not.toBeChecked()
  await userEvent.click(move)
  await userEvent.type(within(dialog).getByLabelText('Address'), 'https://api.example.com/v1')
  await userEvent.type(within(dialog).getByLabelText('Model'), 'whisper-1')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save service' }))
  await waitFor(() =>
    expect(calls('meeting.service.set')).toEqual([
      { url: 'https://api.example.com/v1', model: 'whisper-1', moveKey: true },
    ]),
  )
}, 15_000)

test('with a key, there is no notice', () => {
  show({ key: { set: true, source: 'vault', service: SYV, ready: true, elsewhere: false } })
  expect(screen.queryByRole('alert', { name: 'Speech service' })).toBeNull()
}, 15_000)

test('a meeting waiting on a refused key says so, with the fix beside it, once', async () => {
  show({
    key: { set: true, source: 'app', service: SYV, ready: true, elsewhere: false },
    blocked: 'bad-key',
  })
  expect(screen.getByLabelText('Meeting health')).toHaveTextContent('Transcription key refused')
  const fixes = screen.getAllByRole('alert', { name: 'Speech key' })
  expect(fixes).toHaveLength(1)
  expect(within(fixes[0]!).getByText('The speech service refused the key')).toBeInTheDocument()
  expect(within(fixes[0]!).getByLabelText('syv.ai speech key')).toHaveAttribute('type', 'password')
}, 15_000)

test('a meeting waiting for a key shows its own fix instead of the notice', () => {
  show({
    key: { set: false, source: null, service: SYV, ready: false, elsewhere: false },
    blocked: 'no-key',
  })
  expect(screen.getByLabelText('Meeting health')).toHaveTextContent('Transcription needs a key')
  const fixes = screen.getAllByRole('alert', { name: 'Speech key' })
  expect(fixes).toHaveLength(1)
  expect(
    within(fixes[0]!).getByText('Transcription is waiting for a speech key'),
  ).toBeInTheDocument()
}, 15_000)

test('the header’s control says where the key comes from, and removes this Mac’s', async () => {
  show({ key: { set: true, source: 'app', service: SYV, ready: true, elsewhere: false } })
  await userEvent.click(screen.getByRole('button', { name: 'Profiles and speech service' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Speech service…' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('A key is set on this Mac.')).toBeInTheDocument()
  expect(dialog.textContent).not.toContain('hv_')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(calls('meeting.key.clear')).toHaveLength(1))
  await waitFor(() => expect(within(dialog).getByText('No key is set.')).toBeInTheDocument())
}, 15_000)
