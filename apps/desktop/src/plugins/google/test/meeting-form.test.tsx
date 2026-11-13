import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { EventSheet, type EventDraft } from '../renderer/calendar/event-sheet'
import type { MeetingInput, MeetingOperation } from '../main/meeting-creation'

const cap = vi.hoisted(() => ({
  meetingState: vi.fn(),
  createMeeting: vi.fn(),
  checkMeeting: vi.fn(),
  finishMeeting: vi.fn(),
}))
vi.mock('../renderer/google-cap', () => ({ googleCap: cap }))

const draft: EventDraft = {
  title: 'Synthetic planning',
  location: '',
  date: '2027-01-12',
  dateEnd: '2027-01-12',
  start: '10:00',
  end: '11:00',
  allDay: false,
  calendarName: 'Primary',
  color: 'var(--primary)',
}
const identity = { remote: 'owner/repo', sub: 'synthetic-account' }
const op: MeetingOperation = {
  input: {
    operation: '11111111-1111-4111-8111-111111111111',
    sub: identity.sub,
    title: draft.title,
    start: '2027-01-12T10:00:00Z',
    end: '2027-01-12T11:00:00Z',
    allDay: false,
    location: '',
    guests: ['guest@example.com'],
    meet: true,
  },
  eventId: '11111111111141118111111111111111',
  conferenceRequestId: '22222222-2222-4222-8222-222222222222',
  fingerprint: 'synthetic',
  attempts: 1,
  accepted: false,
  conference: 'pending',
  htmlLink: null,
  conferenceUrl: null,
}
function sheet(options: { connected?: boolean; initial?: EventDraft; strict?: boolean } = {}) {
  const save = vi.fn()
  const close = vi.fn()
  const created = vi.fn()
  const external = vi.fn()
  const element = (
    <EventSheet
      meetingIdentity={options.connected === false ? null : identity}
      onCreated={created}
      state={{ mode: 'create', draft: options.initial ?? draft }}
      error={null}
      saving={false}
      canCreateTask={false}
      onOpenChange={close}
      onEdit={vi.fn()}
      onSave={save}
      onDelete={vi.fn()}
      onCreateTask={vi.fn()}
      onOpenExternal={external}
    />
  )
  return {
    save,
    close,
    created,
    external,
    element,
    ...render(options.strict ? <StrictMode>{element}</StrictMode> : element),
  }
}
const ready = async () => waitFor(() => expect(screen.getByLabelText('Title')).toBeEnabled())
beforeEach(() => {
  for (const mock of Object.values(cap)) mock.mockReset()
  cap.meetingState.mockResolvedValue({ meetSupported: true, operation: null })
  cap.createMeeting.mockImplementation(async (_remote: string, input: MeetingInput) => ({
    ...op,
    input,
    accepted: true,
    conference: input.meet ? 'pending' : 'none',
  }))
  cap.checkMeeting.mockResolvedValue(op)
  cap.finishMeeting.mockResolvedValue({ ok: true })
})

it('requires an explicit button rather than Enter in a create field (regression)', async () => {
  const { save } = sheet({ connected: false })
  await userEvent.type(screen.getByLabelText('Title'), '{Enter}')
  expect(save).not.toHaveBeenCalled()
})

it('opening, typing and guest Enter never send; the explicit invitation button sends once', async () => {
  const user = userEvent.setup()
  sheet()
  await ready()
  expect(cap.createMeeting).not.toHaveBeenCalled()
  expect(screen.getByRole('switch', { name: 'Add Google Meet' })).not.toBeChecked()
  await user.type(screen.getByLabelText('Guests'), 'guest@example.com{Enter}')
  await user.type(screen.getByLabelText('Title'), '{Enter}')
  expect(cap.createMeeting).not.toHaveBeenCalled()
  await user.click(screen.getByRole('switch', { name: 'Add Google Meet' }))
  let complete!: (value: MeetingOperation) => void
  cap.createMeeting.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  await user.dblClick(screen.getByRole('button', { name: 'Create and send invitations' }))
  expect(cap.createMeeting).toHaveBeenCalledTimes(1)
  const sent = cap.createMeeting.mock.calls[0]![1] as MeetingInput
  expect(sent).toMatchObject({
    guests: ['guest@example.com'],
    meet: true,
    sub: identity.sub,
    title: draft.title,
  })
  expect(sent.operation).toMatch(/^[0-9a-f-]{36}$/)
  await act(async () => {
    complete({ ...op, input: sent, accepted: true })
  })
  expect(await screen.findByText(/Google Meet is still pending/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Retry same meeting' })).not.toBeInTheDocument()
})

it('preserves all fields when main rejects invalid input before sending', async () => {
  const user = userEvent.setup()
  sheet()
  await ready()
  cap.createMeeting.mockRejectedValueOnce(new Error('Enter a valid email address for each guest.'))
  await user.type(screen.getByLabelText('Guests'), 'invalid')
  await user.type(screen.getByLabelText('Location'), 'Synthetic venue')
  await user.click(screen.getByRole('button', { name: 'Create and send invitations' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email')
  expect(screen.getByLabelText('Title')).toHaveValue(draft.title)
  expect(screen.getByLabelText('Location')).toHaveValue('Synthetic venue')
  expect(screen.getByLabelText('Guests')).toHaveValue('invalid')
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(cap.createMeeting).toHaveBeenCalledTimes(1)
})

it('restores unresolved intent on reopen, checks read-only, and explicitly retries the identical operation', async () => {
  cap.meetingState.mockResolvedValue({ meetSupported: true, operation: op })
  const user = userEvent.setup()
  const first = sheet()
  expect(await screen.findByText(/Delivery is uncertain/)).toBeInTheDocument()
  expect(screen.getByLabelText('Guests')).toHaveValue('guest@example.com')
  expect(screen.getByLabelText('Title')).toBeDisabled()
  expect(cap.createMeeting).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Check status' }))
  expect(cap.checkMeeting).toHaveBeenCalledWith(identity.remote, { sub: identity.sub })
  expect(cap.createMeeting).not.toHaveBeenCalled()
  first.unmount()
  sheet({ initial: { ...draft, title: 'A different form' } })
  await screen.findByText(/Delivery is uncertain/)
  expect(screen.getByLabelText('Title')).toHaveValue(draft.title)
  await user.click(screen.getByRole('button', { name: 'Retry same meeting' }))
  await waitFor(() => expect(cap.createMeeting).toHaveBeenCalledWith(identity.remote, op.input))
})

it('accepted Meet failure has status recovery and an external action, never a create retry', async () => {
  const accepted = {
    ...op,
    accepted: true,
    conference: 'failure',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=synthetic',
  }
  cap.meetingState.mockResolvedValue({ meetSupported: true, operation: accepted })
  const user = userEvent.setup()
  const r = sheet()
  expect(await screen.findByText(/Google Meet failed/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Retry same meeting' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Open in Google Calendar' }))
  expect(r.external).toHaveBeenCalledWith(accepted.htmlLink)
  cap.checkMeeting.mockResolvedValue({
    ...accepted,
    conference: 'success',
    conferenceUrl: 'https://meet.google.com/abc-defg-hij',
  })
  await user.click(screen.getByRole('button', { name: 'Check status' }))
  await user.click(await screen.findByRole('button', { name: 'Join the call' }))
  expect(r.external).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij')
  await user.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(r.close).toHaveBeenCalledWith(false))
  expect(cap.finishMeeting).toHaveBeenCalledWith(identity.remote, {
    sub: identity.sub,
    operation: op.input.operation,
  })
  expect(cap.createMeeting).not.toHaveBeenCalled()
})

it('late submission results cannot overwrite or close a reopened sheet', async () => {
  let complete!: (value: MeetingOperation) => void
  cap.createMeeting.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const user = userEvent.setup()
  const first = sheet()
  await ready()
  await user.click(screen.getByRole('button', { name: 'Add event' }))
  await waitFor(() => expect(cap.createMeeting).toHaveBeenCalledTimes(1))
  first.unmount()
  const second = sheet({ initial: { ...draft, title: 'New synthetic draft' } })
  await ready()
  await act(async () => {
    complete({ ...op, accepted: true })
  })
  await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('New synthetic draft'))
  expect(second.close).not.toHaveBeenCalled()
  expect(first.created).not.toHaveBeenCalled()
  expect(second.created).not.toHaveBeenCalled()
  expect(cap.createMeeting).toHaveBeenCalledTimes(1)
})

it('read/reconnect errors keep the form and Retry only reads options', async () => {
  cap.meetingState.mockRejectedValueOnce(new Error('Synthetic reconnect required'))
  const user = userEvent.setup()
  sheet()
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic reconnect required')
  expect(screen.getByRole('button', { name: 'Add event' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await ready()
  expect(screen.getByLabelText('Title')).toHaveValue(draft.title)
  expect(cap.createMeeting).not.toHaveBeenCalled()
})

it('drops an old StrictMode options response rather than overwriting a submitted meeting', async () => {
  let complete!: (value: { meetSupported: boolean; operation: null }) => void
  cap.meetingState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const user = userEvent.setup()
  sheet({ strict: true })
  await ready()
  await user.click(screen.getByRole('button', { name: 'Add event' }))
  expect(await screen.findByText('Event created.')).toBeInTheDocument()
  await act(async () => {
    complete({ meetSupported: true, operation: null })
  })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument())
  expect(cap.createMeeting).toHaveBeenCalledTimes(1)
})

it('account and vault changes discard late form results without sending again', async () => {
  let complete!: (value: MeetingOperation) => void
  cap.createMeeting.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const user = userEvent.setup()
  const r = sheet()
  await ready()
  await user.click(screen.getByRole('button', { name: 'Add event' }))
  r.rerender(
    <EventSheet
      meetingIdentity={{ remote: 'owner/other', sub: 'synthetic-other' }}
      onCreated={r.created}
      state={{ mode: 'create', draft: { ...draft, title: 'Different account draft' } }}
      error={null}
      saving={false}
      canCreateTask={false}
      onOpenChange={r.close}
      onEdit={vi.fn()}
      onSave={r.save}
      onDelete={vi.fn()}
      onCreateTask={vi.fn()}
      onOpenExternal={r.external}
    />,
  )
  await ready()
  await act(async () => {
    complete({ ...op, accepted: true })
  })
  await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Different account draft'))
  expect(r.created).not.toHaveBeenCalled()
  expect(r.close).not.toHaveBeenCalled()
  expect(cap.createMeeting).toHaveBeenCalledTimes(1)
})
