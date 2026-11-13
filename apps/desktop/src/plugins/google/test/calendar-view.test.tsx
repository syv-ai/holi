/**
 * The calendar view (ReUI's event calendar over Google): what it asks Google
 * for, what it draws, and which writes it sends through which capability.
 */
import { fireEvent, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { getDefaultStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { localDate } from '@holi/shared'
import { activeRemoteAtom } from '@/plugin-api'
import { CalendarView } from '../renderer/calendar/calendar-view'
import { clockLabel, type TimeFormat } from '../renderer/calendar/calendar-format'
import { GOOGLE_INFO } from '../info'
import { rangeWindow, toCalendarItem, type GoogleEvent } from '../renderer/calendar-data'

/** The clock the view writes on when no settings file answers. */
const clock = GOOGLE_INFO.settings?.find((s) => s.key === 'timeFormat')?.default as TimeFormat

const renderCounts = vi.hoisted(() => ({ calendar: 0, timeSelect: 0 }))

vi.mock('@/components/ui/event-calendar/event-calendar', async (importOriginal) => {
  const React = await import('react')
  const actual =
    await importOriginal<typeof import('@/components/ui/event-calendar/event-calendar')>()
  return {
    ...actual,
    EventCalendar: (props: React.ComponentProps<typeof actual.EventCalendar>) =>
      React.createElement(
        React.Profiler,
        { id: 'calendar-render-counter', onRender: () => renderCounts.calendar++ },
        React.createElement(actual.EventCalendar, props),
      ),
  }
})

vi.mock('../renderer/calendar/event-fields', async (importOriginal) => {
  const React = await import('react')
  const actual = await importOriginal<typeof import('../renderer/calendar/event-fields')>()
  const component = actual.TimeSelect
  const implementation =
    (component as { type?: React.ComponentType<React.ComponentProps<typeof component>> }).type ??
    component
  const isMemo = implementation !== component
  const CountedTimeSelect = (props: React.ComponentProps<typeof component>) => {
    renderCounts.timeSelect++
    return React.createElement(implementation, props)
  }
  return {
    ...actual,
    // Preserve the production memo boundary exactly; if production loses it,
    // this adapter counts every parent-driven render instead.
    TimeSelect: isMemo ? React.memo(CountedTimeSelect) : CountedTimeSelect,
  }
})

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
const namesMock = vi.fn()
const taskMock = vi.fn()

const google: Record<string, (params: Record<string, unknown>) => unknown> = {
  'google.status': () => ({ account: { email: ME }, missingScopes: [] }),
  'google.allAccounts': () => ({ accounts: [{ sub: '1', email: ME }], current: '1' }),
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
  'tasks.create': (p) => taskMock(p),
}
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      names: { query: async () => namesMock() },
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
  namesMock.mockReset().mockResolvedValue([])
  taskMock.mockReset().mockResolvedValue({ path: 'Tasks/focus.md' })
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
  test('one sideways swipe pages one week, and a vertical scroll pages none', async () => {
    const { container } = render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const root = container.querySelector<HTMLElement>('[data-slot="event-calendar"]')!
    const title = () => container.querySelector('[data-slot="event-calendar-title"]')?.textContent
    const before = title()
    const from = () => Date.parse((agendaMock.mock.calls.at(-1)![0] as { from: string }).from)
    const first = from()

    fireEvent.wheel(root, { deltaY: 120 })
    fireEvent.wheel(root, { deltaX: 120, ctrlKey: true })
    expect(title()).toBe(before)

    // One input burst, even when a slow render delays handling its events.
    for (let i = 0; i < 12; i++) {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: 30,
        deltaY: 2,
      })
      Object.defineProperty(event, 'timeStamp', { value: i * 16 })
      fireEvent(root, event)
    }
    await waitFor(() => expect(title()).not.toBe(before))
    await waitFor(() => expect(from()).not.toBe(first))
    expect(Math.round((from() - first) / 86_400_000)).toBe(7)
  })

  test('pages backward and cleans up wheel and animation listeners on unmount', async () => {
    const { container, unmount } = render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const root = container.querySelector<HTMLElement>('[data-slot="event-calendar"]')!
    const content = root.querySelector<HTMLElement>('[data-slot="event-calendar-content"]')!
    const first = Date.parse((agendaMock.mock.calls.at(-1)![0] as { from: string }).from)

    for (let i = 0; i < 12; i++) {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: -30,
        deltaY: 2,
      })
      Object.defineProperty(event, 'timeStamp', { value: i * 16 })
      fireEvent(root, event)
    }
    await waitFor(() => {
      const from = Date.parse((agendaMock.mock.calls.at(-1)![0] as { from: string }).from)
      expect(Math.round((first - from) / 86_400_000)).toBe(7)
    })
    expect(content.className).toContain('motion-in-from-start')

    fireEvent.animationEnd(content)
    expect(content.className).not.toContain('motion-in-from-start')

    unmount()
    const calls = agendaMock.mock.calls.length
    fireEvent.wheel(root, { deltaX: -100 })
    expect(agendaMock).toHaveBeenCalledTimes(calls)
  })

  test.each([250, 500])(
    'keeps queued momentum in one swipe after a %i ms renderer stall',
    async (stall) => {
      const { container } = render(<CalendarView />)
      await screen.findAllByText('Focus block')
      const root = container.querySelector<HTMLElement>('[data-slot="event-calendar"]')!
      const first = Date.parse((agendaMock.mock.calls.at(-1)![0] as { from: string }).from)
      const dispatch = (timestamp: number, deltaX: number) => {
        const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX })
        Object.defineProperty(event, 'timeStamp', { value: timestamp })
        root.dispatchEvent(event)
      }

      // The first page blocks the renderer. Let the armed quiet timer expire
      // before dispatching the browser-queued remainder, whose timestamps show
      // it still belongs to the original gesture.
      vi.useFakeTimers()
      try {
        dispatch(0, 30)
        dispatch(16, 30)
        await vi.advanceTimersByTimeAsync(stall)
        for (let i = 2; i < 12; i++) dispatch(i * 16, 30)
      } finally {
        vi.useRealTimers()
      }

      await waitFor(() => {
        const from = Date.parse((agendaMock.mock.calls.at(-1)![0] as { from: string }).from)
        expect(Math.round((from - first) / 86_400_000)).toBe(7)
      })

      // A later independent gesture has a timestamp gap after the busy period.
      dispatch(11 * 16 + stall + 1, 60)
      await waitFor(() => {
        const from = Date.parse((agendaMock.mock.calls.at(-1)![0] as { from: string }).from)
        expect(Math.round((from - first) / 86_400_000)).toBe(14)
      })
      await waitFor(() => {
        const from = Date.parse((agendaMock.mock.calls.at(-1)![0] as { from: string }).from)
        expect(Math.round((from - first) / 86_400_000)).toBe(14)
      })
    },
  )

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

  test('month overflow event pointer-down does not start slot creation', async () => {
    agendaMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) =>
        googleEvent({ id: `overflow-${index}`, title: `Overflow event ${index}` }),
      ),
    )
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click(await screen.findByRole('button', { name: 'Select view' }))
    await user.click(await screen.findByText('Month'))
    await user.click(await screen.findByRole('button', { name: /more/i }))

    const overflow = await screen.findByRole('dialog')
    const event = within(overflow).getByRole('button', { name: /Overflow event 11/ })
    fireEvent.pointerDown(event, { button: 0, pointerId: 1 })
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull()
    expect(scheduleMock).not.toHaveBeenCalled()
  })

  test('clicking a month overflow event opens its card with focus', async () => {
    agendaMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) =>
        googleEvent({ id: `overflow-${index}`, title: `Overflow event ${index}` }),
      ),
    )
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click(await screen.findByRole('button', { name: 'Select view' }))
    await user.click(await screen.findByText('Month'))
    await user.click(await screen.findByRole('button', { name: /more/i }))

    const overflow = await screen.findByRole('dialog')
    await user.click(within(overflow).getByRole('button', { name: /Overflow event 11/ }))
    const card = await screen.findByRole('dialog', { name: 'Overflow event 11' })
    expect(within(card).getByText('Overflow event 11')).toHaveFocus()
    expect(within(card).queryByRole('textbox', { name: 'Title' })).toBeNull()
  })

  test('month overflow keeps a long event list inside the bounded scroller', async () => {
    agendaMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) =>
        googleEvent({ id: `overflow-${index}`, title: `Overflow event ${index}` }),
      ),
    )
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click(await screen.findByRole('button', { name: 'Select view' }))
    await user.click(await screen.findByText('Month'))
    await user.click(await screen.findByRole('button', { name: /more/i }))

    const overflow = await screen.findByRole('dialog')
    expect(within(overflow).getByText('Overflow event 11')).toBeInTheDocument()
    const viewport = overflow.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).toBeInTheDocument()
    expect(viewport?.parentElement).toHaveClass(
      '**:data-[slot=scroll-area-viewport]:max-h-(--ec-more-max-height,16rem)',
    )
  })

  test('an event of your own opens, and editing it reschedules it by its Google id', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const sheet = await screen.findByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: 'Edit' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    expect(title).toHaveFocus()
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

  test('typing in the event title does not re-render the calendar or unchanged time selects', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const sheet = await screen.findByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: 'Edit' }))
    await screen.findByRole('textbox', { name: 'Title' })

    renderCounts.calendar = 0
    renderCounts.timeSelect = 0
    await user.type(screen.getByRole('textbox', { name: 'Title' }), ' title')

    expect(renderCounts.calendar).toBe(0)
    expect(renderCounts.timeSelect).toBe(0)
  })

  test('canceling edits discards the title and time when the same event is reopened', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const sheet = await screen.findByRole('dialog')
    const form = within(sheet)
    await user.click(form.getByRole('button', { name: 'Edit' }))

    const title = await form.findByRole('textbox', { name: 'Title' })
    await user.clear(title)
    // Per-key rendering is covered above; this test exercises draft discard.
    await user.paste('Changed title')
    await user.click(form.getByRole('combobox', { name: 'From' }))
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(form.getByRole('combobox', { name: 'From' })).toHaveTextContent(
      clockLabel('09:30', clock),
    )
    await user.click(form.getByRole('button', { name: 'Cancel' }))

    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const reopened = within(await screen.findByRole('dialog'))
    expect(reopened.getByText('Focus block')).toBeInTheDocument()
    await user.click(reopened.getByRole('button', { name: 'Edit' }))
    expect(await reopened.findByRole('textbox', { name: 'Title' })).toHaveValue('Focus block')
    expect(reopened.getByRole('combobox', { name: 'From' })).toHaveTextContent(
      clockLabel('09:00', clock),
    )
    expect(rescheduleMock).not.toHaveBeenCalled()
  })

  test('delete confirmation stays pending and retries a refused delete', async () => {
    let rejectDelete!: (error: Error) => void
    unscheduleMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectDelete = reject
        }),
    )
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const card = await screen.findByRole('dialog')
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    expect(within(confirm).getByRole('button', { name: /Delete$/ })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(confirm).toBeInTheDocument()
    rejectDelete(new Error('Delete refused'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(await within(card).findByRole('alert')).toHaveTextContent('Delete refused')
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(unscheduleMock).toHaveBeenCalledTimes(2)
  })

  test('failed task creation explains the error and retries from the same event', async () => {
    namesMock.mockResolvedValue(['tasks.create'])
    taskMock.mockRejectedValueOnce(new Error('Task refused'))
    const user = userEvent.setup()
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Focus block'))[0]!)
    const card = await screen.findByRole('dialog')
    await user.click(await within(card).findByRole('button', { name: 'Task' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('Task refused')
    await user.click(within(card).getByRole('button', { name: 'Task' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(taskMock).toHaveBeenCalledTimes(2)
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

  test('Cancel and Close restore the connected origin', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const trigger = screen.getByRole('button', { name: 'New event' })
    await user.click(trigger)
    await screen.findByRole('textbox', { name: 'Title' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(trigger).toHaveFocus())

    const event = (await screen.findAllByText('Focus block'))[0]!.closest('button')!
    await user.click(event)
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(event).toHaveFocus())
  })

  test('nested date picker Escape preserves the card; card Escape restores its event trigger', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    const eventButton = (await screen.findAllByText('Focus block'))[0]!.closest('button')!
    await user.click(eventButton)
    expect(await screen.findByRole('dialog', { name: 'Focus block' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(eventButton).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'New event' }))
    await screen.findByRole('textbox', { name: 'Title' })
    await user.click(screen.getByRole('button', { name: 'Starts' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument()
  })

  test('a pending write is single-flight and keeps its anchored card open', async () => {
    const user = userEvent.setup()
    let resolve!: (value: { id: string }) => void
    scheduleMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const trigger = screen.getByRole('button', { name: 'New event' })
    await user.click(trigger)
    const card = await screen.findByRole('dialog', { name: 'New event' })
    const title = within(card).getByRole('textbox', { name: 'Title' })
    expect(title).toHaveFocus()
    await user.type(title, 'Deferred event')
    await user.click(within(card).getByRole('button', { name: 'Add event' }))
    expect(within(card).getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: 'Close' })).toBeDisabled()
    expect(card).toHaveAttribute('aria-busy', 'true')
    await user.keyboard('{Escape}')
    await user.click(trigger)
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument()
    resolve({ id: 'new' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('Enter saves a valid event and restores focus to its origin', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const trigger = screen.getByRole('button', { name: 'New event' })
    await user.click(trigger)
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.type(title, 'Enter-saved event')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toHaveFocus()
  })

  test('a failed save followed by outside-click navigation keeps the new card focused', async () => {
    const user = userEvent.setup()
    scheduleMock.mockRejectedValueOnce(new Error('Google said no'))
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const viewButton = screen.getByRole('button', { name: 'Select view' })
    await user.click(screen.getByRole('button', { name: 'New event' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.type(title, 'Failed event')
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Google said no')

    fireEvent.pointerDown(viewButton, { button: 0, pointerId: 1 })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Native pointer activation focuses the outside target after pointer-down.
    viewButton.focus()
    expect(viewButton).toHaveFocus()
  })

  test('a stale save completion does not close a card in a new vault context', async () => {
    const user = userEvent.setup()
    let resolve!: (value: { id: string }) => void
    scheduleMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.type(title, 'Old vault event')
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument()

    getDefaultStore().set(activeRemoteAtom, 'git@github.com:syv-ai/other.git')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByRole('button', { name: 'New event' }))
    const currentCard = await screen.findByRole('dialog', { name: 'New event' })
    resolve({ id: 'old-vault-event' })
    expect(await within(currentCard).findByRole('textbox', { name: 'Title' })).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument()
  })

  test('composition Enter does not submit the event', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.type(title, 'Composed event')
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true })
    expect(scheduleMock).not.toHaveBeenCalled()
    expect(title).toHaveValue('Composed event')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
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
    // The outage lasts through account initialization; only Retry recovers it.
    agendaMock.mockRejectedValue(new Error('Google is down'))
    render(<CalendarView />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Google is down')
    expect(alert.isConnected).toBe(true)
    agendaMock.mockResolvedValue([FOCUS, SYNC]).mockClear()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
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
