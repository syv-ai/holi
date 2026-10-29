/**
 * The agenda as a month: the arithmetic under the grid, and making an event by
 * pressing a day.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { getDefaultStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgendaView } from '../renderer/agenda-view'
import { activeRemoteAtom } from '@/plugin-api'
import { resetMailImagesForTests } from '../renderer/mail-images'
import { localDate } from '@holi/shared'
import { eventDays, monthWindow, shiftMonth } from '../renderer/month-days'

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

  test('a timed event is on every local day it runs into, up to its exclusive end', () => {
    const timed = (start: Date, end: Date) =>
      eventDays({ start: start.toISOString(), end: end.toISOString(), allDay: false })
    expect(timed(new Date(2026, 9, 3, 23, 0), new Date(2026, 9, 5, 2, 0))).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ])
    expect(timed(new Date(2026, 9, 3, 22, 0), new Date(2026, 9, 4, 0, 0))).toEqual(['2026-10-03'])
  })

  test('paging wraps the year', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual([2027, 1])
    expect(shiftMonth(2026, 1, -1)).toEqual([2025, 12])
  })

  test('a month asks for its six weeks, within what one call allows', () => {
    const { from, to } = monthWindow(2026, 10)
    expect(localDate(new Date(from))).toBe('2026-09-28')
    expect(localDate(new Date(to))).toBe('2026-11-09')
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThanOrEqual(92)
  })
})

const agendaMock = vi.fn()
const scheduleMock = vi.fn()

const google: Record<string, (params: unknown) => unknown> = {
  'google.agenda': () => agendaMock(),
  'google.agendaCached': () => null,
  'google.calendars': () => [],
  'google.schedule': (p) => scheduleMock(p),
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

beforeEach(() => {
  agendaMock.mockReset().mockResolvedValue([])
  scheduleMock.mockReset().mockResolvedValue({ id: 'new' })
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

describe('making an event by pressing a day', () => {
  test('a timed event goes to Google with the day’s date, and the month is read again', async () => {
    const user = userEvent.setup()
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    const now = new Date()
    const day = localDate(new Date(now.getFullYear(), now.getMonth(), 20))
    await user.click(dayCell(day))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Lunch with Ada')
    await user.type(screen.getByRole('textbox', { name: 'Location' }), 'Café')
    agendaMock.mockClear()
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    const sent = scheduleMock.mock.calls[0]![0] as Record<string, unknown>
    expect(sent['title']).toBe('Lunch with Ada')
    expect(sent['location']).toBe('Café')
    expect(sent['all-day']).toBeUndefined()
    expect(localDate(new Date(sent['start'] as string))).toBe(day)
    expect(Date.parse(sent['end'] as string)).toBeGreaterThan(Date.parse(sent['start'] as string))
    await waitFor(() => expect(agendaMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull())
  })

  test('an all-day event ends on the day after, as Google’s do', async () => {
    const user = userEvent.setup()
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    const now = new Date()
    await user.click(dayCell(localDate(new Date(now.getFullYear(), now.getMonth(), 20))))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Holiday')
    await user.click(screen.getByRole('checkbox', { name: 'All day' }))
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    const sent = scheduleMock.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ 'all-day': true })
    expect((sent['start'] as string).length).toBe(10)
    expect(sent['end']).toBe(localDate(new Date(now.getFullYear(), now.getMonth(), 21)))
  })

  test('it asks for a title, and says why Google refused', async () => {
    const user = userEvent.setup()
    scheduleMock.mockRejectedValue(new Error('Google said no'))
    render(<AgendaView initialView="month" />)
    await screen.findByRole('grid', { name: 'Month' })
    await user.click(dayCell(localDate(new Date())))
    await user.click(await screen.findByRole('button', { name: 'Add event' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Give it a title.')
    expect(scheduleMock).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Standup')
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    expect(await screen.findByText('Google said no')).toBeInTheDocument()
    // Still there to try again.
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Standup')
  })
})
