/**
 * The agenda as a month: the arithmetic under the grid, the grid itself, and
 * making an event by pressing a day.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { getDefaultStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgendaView } from '../renderer/AgendaView'
import { activeRemoteAtom } from '@/plugin-api'
import { resetMailImagesForTests } from '../renderer/mail-images'
import { eventDays, isoWeek, localDay, monthWindow, shiftMonth } from '../renderer/month-days'

describe('month days', () => {
  test('an all-day event covers every day up to its exclusive end', () => {
    expect(eventDays({ start: '2026-10-30', end: '2026-11-02', allDay: true })).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
    expect(eventDays({ start: '2026-10-31', end: '2026-11-01', allDay: true })).toEqual([
      '2026-10-31',
    ])
  })

  test('a timed event is on the local day it starts, however long it runs', () => {
    const start = new Date(2026, 9, 3, 23, 0)
    const end = new Date(2026, 9, 4, 2, 0)
    expect(
      eventDays({ start: start.toISOString(), end: end.toISOString(), allDay: false }),
    ).toEqual(['2026-10-03'])
  })

  test('week numbers are ISO’s', () => {
    expect(isoWeek('2026-09-28')).toBe(40)
    expect(isoWeek('2026-10-05')).toBe(41)
    expect(isoWeek('2026-01-01')).toBe(1)
    expect(isoWeek('2026-12-31')).toBe(53)
  })

  test('paging wraps the year', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual([2027, 1])
    expect(shiftMonth(2026, 1, -1)).toEqual([2025, 12])
  })

  test('a month asks for its six weeks, within what one call allows', () => {
    const { from, to } = monthWindow(2026, 10)
    expect(localDay(new Date(from))).toBe('2026-09-28')
    expect(localDay(new Date(to))).toBe('2026-11-09')
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThanOrEqual(92)
  })
})

const agendaMock = vi.fn()
const createEventMock = vi.fn()

const google: Record<string, (params: unknown) => unknown> = {
  'google.agenda': () => agendaMock(),
  'google.agendaCached': () => null,
  'google.calendars': () => [],
  'google.createEvent': (p) => createEventMock(p),
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
          return verb(JSON.parse(paramsJson ?? '{}') as object)
        },
      },
    },
  },
}))

/** An event on `day` of this month, local, at ten. */
function eventOn(day: number, over: Record<string, unknown> = {}) {
  const now = new Date()
  return {
    id: `e${day}`,
    title: `Event ${day}`,
    start: new Date(now.getFullYear(), now.getMonth(), day, 10).toISOString(),
    end: new Date(now.getFullYear(), now.getMonth(), day, 11).toISOString(),
    allDay: false,
    htmlLink: 'https://calendar.google.com/x',
    calendarId: 'primary',
    calendarName: 'Ada',
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
    ...over,
  }
}

beforeEach(() => {
  agendaMock.mockReset().mockResolvedValue([])
  createEventMock.mockReset().mockResolvedValue({ id: 'new' })
  resetMailImagesForTests()
  getDefaultStore().set(activeRemoteAtom, 'git@github.com:syv-ai/notes.git')
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal: vi.fn() }
})
afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
  getDefaultStore().set(activeRemoteAtom, null)
})

const dayCell = (day: string) => document.querySelector<HTMLElement>(`[data-day="${day}"]`)!

describe('the month grid', () => {
  test('opens on this month with today marked, and draws events on their days', async () => {
    agendaMock.mockResolvedValue([eventOn(15)])
    render(<AgendaView initialView="month" />)
    const grid = await screen.findByRole('grid', { name: 'Month' })
    expect(dayCell(localDay(new Date())).hasAttribute('data-today')).toBe(true)
    const now = new Date()
    const cell = dayCell(localDay(new Date(now.getFullYear(), now.getMonth(), 15)))
    expect(within(cell).getByRole('button', { name: /^Event 15, / })).toBeInTheDocument()
    // Six weeks, with a week number at the head of each.
    expect(within(grid).getAllByRole('row')).toHaveLength(7)
  })

  test('a day with more than fits shows two and "+N more", which lists them all', async () => {
    const user = userEvent.setup()
    agendaMock.mockResolvedValue([
      eventOn(12),
      eventOn(12, { id: 'b', title: 'B' }),
      eventOn(12, { id: 'c', title: 'C' }),
      eventOn(12, { id: 'd', title: 'D' }),
    ])
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    await user.click(await screen.findByRole('button', { name: '+2 more' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('D')).toBeInTheDocument()
  })

  test('pressing an event opens it', async () => {
    const user = userEvent.setup()
    agendaMock.mockResolvedValue([eventOn(15, { description: null })])
    render(<AgendaView initialView="month" />)
    await user.click(await screen.findByRole('button', { name: /^Event 15, / }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Event 15')
    // It did not start a new event on the way.
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull()
  })

  test('pages by month and returns with Today', async () => {
    const user = userEvent.setup()
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    const title = () => screen.getByRole('heading', { level: 2 }).textContent
    const first = title()
    await user.click(screen.getByRole('button', { name: 'next month' }))
    expect(title()).not.toBe(first)
    await user.click(screen.getByRole('button', { name: 'Today' }))
    expect(title()).toBe(first)
  })
})

describe('making an event by pressing a day', () => {
  test('a timed event goes to Google with the day’s date, and the month is read again', async () => {
    const user = userEvent.setup()
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    const now = new Date()
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), 20))
    await user.click(dayCell(day))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Lunch with Ada')
    await user.type(screen.getByRole('textbox', { name: 'Location' }), 'Café')
    agendaMock.mockClear()
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(createEventMock).toHaveBeenCalledTimes(1))
    const sent = createEventMock.mock.calls[0]![0] as Record<string, unknown>
    expect(sent['title']).toBe('Lunch with Ada')
    expect(sent['location']).toBe('Café')
    expect(sent['allDay']).toBeUndefined()
    expect(localDay(new Date(sent['start'] as string))).toBe(day)
    expect(Date.parse(sent['end'] as string)).toBeGreaterThan(Date.parse(sent['start'] as string))
    await waitFor(() => expect(agendaMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull())
  })

  test('an all-day event ends on the day after, as Google’s do', async () => {
    const user = userEvent.setup()
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    const now = new Date()
    await user.click(dayCell(localDay(new Date(now.getFullYear(), now.getMonth(), 20))))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Holiday')
    await user.click(screen.getByRole('checkbox', { name: 'All day' }))
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(createEventMock).toHaveBeenCalledTimes(1))
    const sent = createEventMock.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ allDay: true })
    expect((sent['start'] as string).length).toBe(10)
    expect(sent['end']).toBe(localDay(new Date(now.getFullYear(), now.getMonth(), 21)))
  })

  test('it asks for a title, and says why Google refused', async () => {
    const user = userEvent.setup()
    createEventMock.mockRejectedValue(new Error('Google said no'))
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    await user.click(dayCell(localDay(new Date())))
    await user.click(await screen.findByRole('button', { name: 'Add event' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Give it a title.')
    expect(createEventMock).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Standup')
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    expect(await screen.findByText('Google said no')).toBeInTheDocument()
    // Still there to try again.
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Standup')
  })

  test('Escape closes it and makes nothing', async () => {
    const user = userEvent.setup()
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    await user.click(dayCell(localDay(new Date())))
    await screen.findByRole('textbox', { name: 'Title' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull())
    expect(createEventMock).not.toHaveBeenCalled()
  })
})
