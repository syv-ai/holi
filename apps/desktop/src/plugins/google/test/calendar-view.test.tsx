/**
 * The calendar view (ReUI's event calendar over Google): what it asks Google
 * for, what it draws, and which writes it sends through which capability.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { getDefaultStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { localDate } from '@holi/shared'
import { activeRemoteAtom } from '@/plugin-api'
import { CalendarView } from '../renderer/calendar/calendar-view'
import { rangeWindow, toCalendarItem, type GoogleEvent } from '../renderer/calendar-data'

const ME = 'me@example.com'

const at = (hour: number, minute = 0): string => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString()
}

function googleEvent(overrides: Partial<GoogleEvent>): GoogleEvent {
  return {
    id: 'ev',
    title: 'Event',
    start: at(10),
    end: at(11),
    allDay: false,
    htmlLink: 'https://calendar.google.com/event?eid=1',
    calendarId: ME,
    calendarName: 'Me',
    mine: true,
    color: '#039be5',
    myResponse: null,
    kind: 'default',
    busy: true,
    description: null,
    attendeeCount: 0,
    organizer: null,
    organizerEmail: null,
    conferenceUrl: null,
    recurring: false,
    ...overrides,
  }
}

const FOCUS = googleEvent({ id: 'focus-1', title: 'Focus block', start: at(9), end: at(10) })
const SYNC = googleEvent({
  id: 'sync-1',
  title: 'Team sync',
  start: at(13),
  end: at(14),
  attendeeCount: 3,
  organizer: 'ada@example.com',
  conferenceUrl: 'https://meet.google.com/abc',
  myResponse: 'needsAction',
})

const agendaMock = vi.fn()
const scheduleMock = vi.fn()
const rescheduleMock = vi.fn()
const unscheduleMock = vi.fn()
const setCalendarMock = vi.fn()

const google: Record<string, (params: Record<string, unknown>) => unknown> = {
  'google.status': () => ({ account: { email: ME }, missingScopes: [] }),
  'google.accounts': () => ({ accounts: [{ sub: '1', email: ME }], current: '1' }),
  'google.agenda': (p) => agendaMock(p),
  'google.agendaCached': () => null,
  'google.calendars': () => [
    { id: ME, name: 'Me', mine: true, color: '#039be5', enabled: true },
    { id: 'team', name: 'Team', mine: false, color: '#7986cb', enabled: false },
  ],
  'google.setCalendar': (p) => setCalendarMock(p),
  'google.schedule': (p) => scheduleMock(p),
  'google.reschedule': (p) => rescheduleMock(p),
  'google.unschedule': (p) => unscheduleMock(p),
  'google.imageSenders': () => [],
}
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      names: { query: async () => [] },
      run: {
        mutate: async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
          const verb = google[name]
          if (verb === undefined) throw new Error(`no such method: ${name}`)
          return verb(JSON.parse(paramsJson ?? '{}') as Record<string, unknown>)
        },
      },
    },
  },
}))

beforeEach(() => {
  agendaMock.mockReset().mockResolvedValue([FOCUS, SYNC])
  scheduleMock.mockReset().mockResolvedValue({ id: 'new' })
  rescheduleMock.mockReset().mockResolvedValue({ ok: true })
  unscheduleMock.mockReset().mockResolvedValue({ ok: true })
  setCalendarMock.mockReset().mockResolvedValue({ ok: true })
  getDefaultStore().set(activeRemoteAtom, 'git@github.com:syv-ai/notes.git')
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal: vi.fn() }
})
afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
  getDefaultStore().set(activeRemoteAtom, null)
})

describe('mapping Google onto the calendar', () => {
  test('an all-day event starts and ends on local midnights, its end exclusive', () => {
    const item = toCalendarItem(
      googleEvent({ allDay: true, start: '2026-10-30', end: '2026-11-02' }),
      ME,
    )
    expect(item.allDay).toBe(true)
    expect(item.start).toEqual(new Date(2026, 9, 30))
    expect(item.end).toEqual(new Date(2026, 10, 2))
  })

  test('only a solo event on the primary calendar is editable', () => {
    expect(toCalendarItem(FOCUS, ME).data?.editable).toBe(true)
    expect(toCalendarItem(FOCUS, ME).readOnly).toBe(false)
    expect(toCalendarItem(SYNC, ME).data?.editable).toBe(false)
    expect(toCalendarItem({ ...FOCUS, calendarId: 'team' }, ME).readOnly).toBe(true)
    expect(toCalendarItem(FOCUS, null).readOnly).toBe(true)
  })

  test('two calendars carrying one meeting stay two items', () => {
    expect(toCalendarItem(FOCUS, ME).id).not.toBe(
      toCalendarItem({ ...FOCUS, calendarId: 'team' }, ME).id,
    )
  })

  test('a long range asks for no more than one call allows', () => {
    const start = new Date(2026, 0, 1)
    const { from, to } = rangeWindow({ start, end: new Date(2026, 11, 31) })
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(92)
  })
})

describe('the calendar view', () => {
  test('asks Google for the visible week and draws its events', async () => {
    render(<CalendarView />)
    expect((await screen.findAllByText('Focus block')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Team sync').length).toBeGreaterThan(0)
    const window = agendaMock.mock.calls.at(-1)![0] as { from: string; to: string }
    expect(Date.parse(window.from)).toBeLessThanOrEqual(Date.parse(FOCUS.start))
    expect(Date.parse(window.to)).toBeGreaterThan(Date.parse(SYNC.end))
    // The week starts on a Monday.
    expect(new Date(window.from).getDay()).toBe(1)
  })

  test('an event of your own opens, and editing it reschedules it by its Google id', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const sheet = await screen.findByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: 'Edit' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Deep work')
    agendaMock.mockClear()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(rescheduleMock).toHaveBeenCalledTimes(1))
    const sent = rescheduleMock.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ id: 'focus-1', title: 'Deep work' })
    expect(Date.parse(sent['start'] as string)).toBe(Date.parse(FOCUS.start))
    expect(Date.parse(sent['end'] as string)).toBe(Date.parse(FOCUS.end))
    expect(sent['all-day']).toBeUndefined()
    // Read again, so the grid shows what Google holds.
    await waitFor(() => expect(agendaMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('deleting your own event unschedules it', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const sheet = await screen.findByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(unscheduleMock).toHaveBeenCalledWith({ id: 'focus-1' }))
  })

  test('a meeting with guests reads, and offers no edit', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(sheet).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(within(sheet).getByText(/Has guests/)).toBeInTheDocument()
    expect(within(sheet).getByText('Invited')).toBeInTheDocument()
    expect(within(sheet).getByText('3 people')).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Join the call' }))
    expect(window.holi.openExternal).toHaveBeenCalledWith('https://meet.google.com/abc')
  })

  test('New event schedules a solo event on your calendar', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Lunch with Ada')
    await user.type(screen.getByRole('textbox', { name: 'Location' }), 'Café')
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    const sent = scheduleMock.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ title: 'Lunch with Ada', location: 'Café' })
    expect(sent['all-day']).toBeUndefined()
    expect(localDate(new Date(sent['start'] as string))).toBe(localDate(new Date()))
  })

  test('an all-day event goes as days, its end the day after', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Holiday')
    await user.click(screen.getByRole('switch', { name: /All day/ }))
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    const sent = scheduleMock.mock.calls[0]![0] as Record<string, unknown>
    const today = new Date()
    expect(sent).toMatchObject({
      'all-day': true,
      start: localDate(today),
      end: localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)),
    })
  })

  test('a refused save says why and keeps the form', async () => {
    const user = userEvent.setup()
    scheduleMock.mockRejectedValue(new Error('Google said no'))
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.click(await screen.findByRole('button', { name: 'Add event' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Give it a title.')
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Standup')
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    expect(await screen.findByText('Google said no')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Standup')
  })

  test('a failed load says so inline, and Retry asks again', async () => {
    const user = userEvent.setup()
    agendaMock.mockRejectedValueOnce(new Error('Google is down'))
    render(<CalendarView />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Google is down')
    agendaMock.mockClear()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(agendaMock).toHaveBeenCalled())
    expect((await screen.findAllByText('Focus block')).length).toBeGreaterThan(0)
  })

  test('without a connection it offers Connections', async () => {
    const refusal = Object.assign(new Error('Google is not connected'), {
      data: { code: 'UNAUTHORIZED' },
    })
    agendaMock.mockRejectedValue(refusal)
    render(<CalendarView />)
    expect(await screen.findByText('Google isn’t connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Connections' })).toBeInTheDocument()
  })
})
