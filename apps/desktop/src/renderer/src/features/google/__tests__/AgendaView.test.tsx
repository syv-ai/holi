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
import { getDefaultStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgendaView } from '../AgendaView'
import { activeRemoteAtom } from '../../../state/vaults'

const agendaMock = vi.fn()
const calendarsMock = vi.fn()
const setCalendarMock = vi.fn()
const createTaskMock = vi.fn()

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    google: {
      agenda: { query: () => agendaMock() },
      calendars: { query: () => calendarsMock() },
      setCalendar: { mutate: (input: unknown) => setCalendarMock(input) },
    },
    tasks: { create: { mutate: (input: unknown) => createTaskMock(input) } },
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
    myResponse: null,
    kind: 'default',
    busy: true,
    description: null,
    attendeeCount: 0,
    organizer: null,
    conferenceUrl: null,
    recurring: false,
    ...overrides,
  }
}

const openExternal = vi.fn()

beforeEach(() => {
  agendaMock.mockReset().mockResolvedValue([])
  calendarsMock.mockReset().mockResolvedValue(CALENDARS)
  setCalendarMock.mockReset().mockResolvedValue({ ok: true })
  createTaskMock.mockReset().mockResolvedValue({ path: 'tasks/q2-review.md' })
  openExternal.mockReset()
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal }
})
afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
  getDefaultStore().set(activeRemoteAtom, null)
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

/**
 * Triage on the row.
 *
 * An agenda that renders every entry identically makes the user re-read their
 * own calendar to find the one thing that needs them. These tests are about the
 * three distinctions that carry the most: an unanswered invitation, a block
 * that is not a meeting, and time that is not really taken.
 */

test('flags an invitation that still needs an answer', async () => {
  agendaMock.mockResolvedValue([
    event({ myResponse: 'needsAction' }),
    event({ id: 'e2', title: 'Accepted thing', myResponse: 'accepted' }),
  ])
  const user = userEvent.setup()

  render(<AgendaView />)
  const rsvp = await screen.findByRole('button', { name: /answer Q2 review/i })

  // Only the unanswered one. An accepted meeting is a fact, not a task.
  expect(screen.queryByRole('button', { name: /answer Accepted thing/i })).toBeNull()

  await user.click(rsvp)

  // The scope is read-only: Holi cannot RSVP and must not pretend to, so the
  // affordance hands the user to Google rather than faking a reply.
  expect(openExternal).toHaveBeenCalledWith('https://calendar.google.com/x')
})

test('marks out-of-office distinctly from a meeting', async () => {
  agendaMock.mockResolvedValue([
    event({ id: 'ooo', title: 'Away', kind: 'outOfOffice' }),
    event({ id: 'meet', title: 'Sync', kind: 'default' }),
  ])

  render(<AgendaView />)
  await screen.findByText('Away')

  // "Away" that reads like a meeting is why people double-book someone on leave.
  expect(screen.getByText(/out of office/i)).toBeInTheDocument()
  expect(screen.getAllByText(/out of office/i)).toHaveLength(1)
})

test('dims an event that does not block time', async () => {
  agendaMock.mockResolvedValue([
    event({ id: 'free', title: 'FYI release', busy: false }),
    event({ id: 'busy', title: 'Interview', busy: true }),
  ])

  render(<AgendaView />)
  await screen.findByText('FYI release')

  const free = screen.getByText('FYI release').closest('li')!
  const busy = screen.getByText('Interview').closest('li')!
  expect(free.className).toContain('opacity-60')
  expect(busy.className).not.toContain('opacity-60')
})

test('offers the video link for a Zoom conference, not just Meet', async () => {
  agendaMock.mockResolvedValue([event({ conferenceUrl: 'https://syv.zoom.us/j/123' })])
  const user = userEvent.setup()

  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /join Q2 review/i }))

  // The row used to read `hangoutLink`, which is Meet-only — half a
  // consultancy's calls had no join button at all.
  expect(openExternal).toHaveBeenCalledWith('https://syv.zoom.us/j/123')
})

test('puts the event description into the task it creates', async () => {
  getDefaultStore().set(activeRemoteAtom, 'git@github.com:syv-ai/notes.git')
  agendaMock.mockResolvedValue([
    event({ description: 'Dial-in 555-0100, agenda in the deck' }),
  ])
  const user = userEvent.setup()

  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /^task$/i }))

  await waitFor(() => expect(createTaskMock).toHaveBeenCalled())
  const { description } = createTaskMock.mock.calls[0]![0] as { description: string }
  // The link is the representation (D67); the description is what makes the
  // task worth opening — the dial-in lives there, not in the title.
  expect(description).toContain('https://calendar.google.com/x')
  expect(description).toContain('Dial-in 555-0100')
})

test('says nothing about calendars when Google gives none', async () => {
  calendarsMock.mockRejectedValue(new Error('not connected'))

  render(<AgendaView />)
  await screen.findByRole('button', { name: /refresh agenda/i })

  // The agenda's own error surface covers the outage; a second broken control
  // saying the same thing is noise.
  expect(screen.queryByRole('button', { name: /choose calendars/i })).toBeNull()
})
