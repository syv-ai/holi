/**
 * The agenda's calendar picker.
 *
 * The problem it solves: a Workspace account is subscribed to colleagues'
 * calendars, rooms and birthdays, and an agenda that merges all of them cannot
 * answer "what am I doing today". So the tests worth having are about the
 * distinction being visible and the toggle reaching main — which is what makes
 * it true for the agent as well as the panel.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { AgendaView } from '../AgendaView'

const agendaMock = vi.fn()
const calendarsMock = vi.fn()
const setCalendarMock = vi.fn()

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    google: {
      agenda: { query: () => agendaMock() },
      calendars: { query: () => calendarsMock() },
      setCalendar: { mutate: (input: unknown) => setCalendarMock(input) },
    },
    tasks: { create: { mutate: vi.fn() } },
  },
}))

const CALENDARS = [
  { id: 'primary', name: 'Nicolai', mine: true, color: '#039be5', enabled: true },
  { id: 'jane', name: 'Jane Doe', mine: false, color: '#d50000', enabled: false },
  { id: 'room3', name: 'Meeting Room 3', mine: false, color: null, enabled: false },
]

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    title: 'Q2 review',
    start: '2026-08-04T09:00:00.000Z',
    end: '2026-08-04T10:00:00.000Z',
    allDay: false,
    htmlLink: 'https://calendar.google.com/x',
    calendarId: 'primary',
    calendarName: 'Nicolai',
    mine: true,
    color: '#039be5',
    ...overrides,
  }
}

beforeEach(() => {
  agendaMock.mockReset().mockResolvedValue([])
  calendarsMock.mockReset().mockResolvedValue(CALENDARS)
  setCalendarMock.mockReset().mockResolvedValue({ ok: true })
})

/** Open the picker and hand back its menu. */
async function openPicker() {
  const user = userEvent.setup()
  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /choose calendars/i }))
  return { user, menu: await screen.findByRole('menu') }
}

test('separates the calendars you own from the ones you only watch', async () => {
  const { menu } = await openPicker()

  // The grouping IS the feature — "Jane Doe" sitting in an undifferentiated
  // list is what made the agenda unreadable in the first place.
  expect(within(menu).getByText('Your calendars')).toBeInTheDocument()
  expect(within(menu).getByText('Subscribed')).toBeInTheDocument()
})

test('shows subscribed calendars switched off, and yours switched on', async () => {
  const { menu } = await openPicker()

  expect(within(menu).getByRole('menuitemcheckbox', { name: /Nicolai/ })).toBeChecked()
  expect(within(menu).getByRole('menuitemcheckbox', { name: /Jane Doe/ })).not.toBeChecked()
})

test('switching a colleague on tells main, and reloads the agenda', async () => {
  const { user, menu } = await openPicker()
  agendaMock.mockClear()

  await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Jane Doe/ }))

  // Persisted in main rather than held here, because the agent resolves its own
  // agenda through the same store.
  expect(setCalendarMock).toHaveBeenCalledWith({ id: 'jane', enabled: true })
  await waitFor(() => expect(agendaMock).toHaveBeenCalled())
})

test('stays open while several calendars are ticked', async () => {
  // Radix closes a menu on select by default; ticking three colleagues through
  // three separate openings is the wrong interaction for a filter list.
  const { user, menu } = await openPicker()

  await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Jane Doe/ }))

  expect(screen.getByRole('menu')).toBeInTheDocument()
})

test('marks an event from someone else’s calendar as theirs', async () => {
  agendaMock.mockResolvedValue([
    event(),
    event({ id: 'e2', title: 'Dentist', calendarId: 'jane', calendarName: 'Jane Doe', mine: false }),
  ])

  render(<AgendaView />)

  // Attribution on the row, so a glance never reads someone else's dentist
  // appointment as the user's own.
  expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
})

test('says nothing about calendars when Google gives none', async () => {
  calendarsMock.mockRejectedValue(new Error('not connected'))

  render(<AgendaView />)
  await screen.findByRole('button', { name: /refresh agenda/i })

  // The agenda's own error surface covers the outage; a second broken control
  // saying the same thing is noise.
  expect(screen.queryByRole('button', { name: /choose calendars/i })).toBeNull()
})
