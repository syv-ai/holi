/**
 * The calendar view (ReUI's event calendar over Google): what it asks Google
 * for, what it draws, and which writes it sends through which capability.
 */
import { act, fireEvent, render as renderUi, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { localDate } from '@holi/shared'
import { activeRemoteAtom } from '@/plugin-api'
import { CalendarView } from '../renderer/calendar/calendar-view'
import { refreshGoogleAtom } from '../renderer/account'
import { ConnectionsSection } from '../renderer/connections-section'
import { clockLabel, type TimeFormat } from '../renderer/calendar/calendar-format'
import { GOOGLE_INFO } from '../info'
import { rangeWindow, toCalendarItem, type GoogleEvent } from '../renderer/calendar-data'
import type { MeetingInput, MeetingOperation } from '../main/meeting-creation'
import type {
  AttachEventFilesResult,
  DriveFilePage,
  EventAttachmentTarget,
} from '../shared/event-attachments'

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
const NOTES = 'git@github.com:syv-ai/notes.git'
const BRIEF = { id: 'brief', name: 'Workshop brief', mimeType: 'application/pdf' }
const AGENDA = { id: 'agenda', name: 'Workshop agenda', mimeType: 'application/pdf' }
const HANDOUT = {
  fileId: 'handout',
  title: 'Existing handout',
  fileUrl: 'https://drive.google.com/open?id=handout',
}
const attachmentOf = (file: { id: string; name: string }) => ({
  fileId: file.id,
  title: file.name,
  fileUrl: `https://drive.google.com/open?id=${file.id}`,
})

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function confirmDriveFiles(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  await user.click(await screen.findByRole('button', { name: 'Add from Drive' }))
  for (const name of names) await user.click(await screen.findByRole('checkbox', { name }))
  await user.click(screen.getByRole('button', { name: 'Review files' }))
  await user.click(screen.getByRole('button', { name: 'Attach and share with guests' }))
}

const statusMock = vi.fn()
const allAccountsMock = vi.fn()
const agendaMock = vi.fn()
const agendaCachedMock = vi.fn()
const scheduleMock = vi.fn()
const rescheduleMock = vi.fn()
const unscheduleMock = vi.fn()
const setCalendarMock = vi.fn()
const namesMock = vi.fn()
const taskMock = vi.fn()
const meetingStateMock = vi.fn()
const checkMeetingMock = vi.fn()
const eventAttachmentsMock = vi.fn()
const driveFilesMock = vi.fn()
const attachEventFilesMock = vi.fn()
const checkEventFileAccessMock = vi.fn()
const finishConsentMock = vi.fn()

const google: Record<string, (params: Record<string, unknown>, remote: string) => unknown> = {
  'google.status': (_p, remote) => statusMock(remote),
  'google.allAccounts': (_p, remote) => allAccountsMock(remote),
  'google.agenda': (p, remote) => agendaMock(p, remote),
  'google.agendaCached': (p, remote) => agendaCachedMock(p, remote),
  'google.calendars': () => [
    { id: ME, name: 'Me', mine: true, color: '#039be5', enabled: true },
    { id: 'team', name: 'Team', mine: false, color: '#7986cb', enabled: false },
  ],
  'google.setCalendar': (p) => setCalendarMock(p),
  'google.schedule': (p) => scheduleMock(p),
  'google.meetingState': () => meetingStateMock(),
  'google.createMeeting': (p) => scheduleMock(p),
  'google.checkMeeting': (p) => checkMeetingMock(p),
  'google.finishMeeting': () => ({ ok: true }),
  'google.eventAttachments': (p, remote) => eventAttachmentsMock(remote, p),
  'google.driveFiles': (p, remote) => driveFilesMock(remote, p),
  'google.attachEventFiles': (p, remote) => attachEventFilesMock(remote, p),
  'google.checkEventFileAccess': (p, remote) => checkEventFileAccessMock(remote, p),
  'google.connect': () => ({ url: 'https://accounts.google.com/' }),
  'google.awaitConnect': () => finishConsentMock(),
  'google.client': () => ({ id: 'example.apps.googleusercontent.com', source: 'shipped' }),
  'google.mailMarkerPreferences': () => ({ enabledOrder: ['yellow-star'] }),
  'google.reschedule': (p) => rescheduleMock(p),
  'google.unschedule': (p) => unscheduleMock(p),
  'google.imageSenders': () => ({ senders: [], allSenders: false }),
  'tasks.create': (p) => taskMock(p),
}
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      names: { query: async () => namesMock() },
      run: {
        mutate: async ({
          name,
          paramsJson,
          remote,
        }: {
          name: string
          paramsJson?: string
          remote: string
        }) => {
          const verb = google[name]
          if (verb === undefined) throw new Error(`no such method: ${name}`)
          return verb(JSON.parse(paramsJson ?? '{}') as Record<string, unknown>, remote)
        },
      },
    },
  },
}))

let store: ReturnType<typeof createStore>

function render(ui: React.ReactElement) {
  const withStore = (child: React.ReactElement) => <Provider store={store}>{child}</Provider>
  const result = renderUi(withStore(ui))
  return { ...result, rerender: (next: React.ReactElement) => result.rerender(withStore(next)) }
}

beforeEach(() => {
  store = createStore()
  statusMock.mockReset().mockResolvedValue({ account: { email: ME }, missingScopes: [] })
  allAccountsMock
    .mockReset()
    .mockResolvedValue({ accounts: [{ sub: '1', email: ME }], current: '1' })
  agendaMock.mockReset().mockResolvedValue([FOCUS, SYNC])
  agendaCachedMock.mockReset().mockResolvedValue(null)
  scheduleMock
    .mockReset()
    .mockImplementation(async (input: MeetingInput): Promise<MeetingOperation> => ({
      input,
      eventId: input.operation.replaceAll('-', ''),
      conferenceRequestId: '22222222-2222-4222-8222-222222222222',
      fingerprint: 'synthetic',
      attempts: 1,
      accepted: true,
      conference: 'none',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=synthetic',
      conferenceUrl: null,
    }))
  rescheduleMock.mockReset().mockResolvedValue({ ok: true })
  unscheduleMock.mockReset().mockResolvedValue({ ok: true })
  setCalendarMock.mockReset().mockResolvedValue({ ok: true })
  namesMock.mockReset().mockResolvedValue([])
  taskMock.mockReset().mockResolvedValue({ path: 'Tasks/focus.md' })
  meetingStateMock.mockReset().mockResolvedValue({ meetSupported: true, operation: null })
  checkMeetingMock.mockReset()
  eventAttachmentsMock.mockReset().mockResolvedValue({ attachments: [], canAttach: false })
  driveFilesMock.mockReset()
  attachEventFilesMock.mockReset()
  checkEventFileAccessMock.mockReset()
  finishConsentMock.mockReset()
  store.set(activeRemoteAtom, NOTES)
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal: vi.fn() }
})
afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
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
  test('uses pane-width containers for the rail and toolbar controls', async () => {
    const { container } = render(<CalendarView />)
    const host = container.querySelector<HTMLElement>('[class*="@container/calendar-host"]')!
    const rail = container.querySelector<HTMLElement>('aside')!
    const calendar = container.querySelector<HTMLElement>('[data-slot="event-calendar"]')!
    const nav = container.querySelector<HTMLElement>('[data-slot="event-calendar-nav"]')!
    const toolbar = container.querySelector<HTMLElement>('[data-slot="event-calendar-toolbar"]')!
    const calendarsMenu = container.querySelector<HTMLElement>(
      '[class*="@min-[64rem]/calendar-host:hidden"]',
    )

    expect(host).toBeInTheDocument()
    expect(rail).toHaveClass('@min-[64rem]/calendar-host:flex')
    expect(calendar).toHaveClass('@container/calendar')
    expect(nav).toHaveClass('@min-[48rem]/calendar:w-auto')
    expect(toolbar).toHaveClass('@min-[48rem]/calendar:w-auto')
    expect(calendarsMenu).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Calendars' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Select view' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New event' })).toBeInTheDocument()
  })

  test('collapses and restores the calendar rail without losing calendar controls or view state', async () => {
    const user = userEvent.setup()
    const { container } = render(<CalendarView />)
    await screen.findAllByText('Focus block')

    const rail = container.querySelector<HTMLElement>('aside')!
    const title = container.querySelector('[data-slot="event-calendar-title"]')?.textContent
    expect(rail).toHaveClass('@min-[64rem]/calendar-host:flex')
    expect(screen.getByRole('button', { name: 'Hide calendar rail' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(screen.getByRole('button', { name: 'Hide calendar rail' }))
    expect(rail).toHaveClass('hidden')
    expect(rail).not.toHaveClass('@min-[64rem]/calendar-host:flex')
    expect(
      container.querySelector('[class*="@min-[64rem]/calendar-host:hidden"]'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show calendar rail' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getAllByRole('button', { name: 'Calendars' })).toHaveLength(2)
    expect(container.querySelector('[data-slot="event-calendar-title"]')?.textContent).toBe(title)
    expect(screen.getAllByText('Focus block').length).toBeGreaterThan(0)

    const pickers = screen.getAllByRole('button', { name: 'Calendars' })
    await user.click(pickers.at(-1)!)
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Team' }))
    expect(setCalendarMock).toHaveBeenCalledWith({ id: 'team', enabled: true })
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Show calendar rail' }))
    expect(rail).toHaveClass('@min-[64rem]/calendar-host:flex')
    expect(screen.getByRole('button', { name: 'Hide calendar rail' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(container.querySelector('[data-slot="event-calendar-title"]')?.textContent).toBe(title)
    expect(screen.getAllByText('Focus block').length).toBeGreaterThan(0)
  })

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

  test('hiding the calendar cancels its in-flight and blocked gestures', async () => {
    const { container, rerender } = render(<CalendarView visible />)
    await screen.findAllByText('Focus block')
    const focus = container.querySelector<HTMLElement>(
      '[data-slot="event-calendar-event"][aria-label^="Focus block"]',
    )!
    const sync = container.querySelector<HTMLElement>(
      '[data-slot="event-calendar-event"][aria-label^="Team sync"]',
    )!
    const columns = container.querySelectorAll<HTMLElement>('[data-ec-day][data-ec-bounds-start]')
    const focusDay = new Date(FOCUS.start).setHours(0, 0, 0, 0)
    for (const column of columns) {
      // Only the event's actual day sits under the pointer, regardless of weekday.
      const left = Number(column.dataset.ecDay) === focusDay ? 100 : 1000
      vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(left, 0, 100, 1440))
    }
    vi.spyOn(focus, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 540, 80, 60))
    const dispatchPointer = (
      target: Element | Window,
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      pointerId: number,
      clientX: number,
      clientY: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
      })
      Object.defineProperty(event, 'pointerId', { value: pointerId })
      fireEvent(target, event)
    }

    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const expectPointerListenersRemoved = () => {
      for (const [type, listener, options] of added.mock.calls) {
        if (!['pointermove', 'pointerup', 'pointercancel'].includes(type)) continue
        const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
        expect(removed.mock.calls).toContainEqual([type, listener, ...(capture ? [true] : [])])
      }
    }

    // A pending press is owner-scoped too: hiding before activation removes
    // its global listeners, including the chip's trailing-click marker.
    dispatchPointer(focus, 'pointerdown', 31, 130, 540)
    rerender(<CalendarView visible={false} />)
    expectPointerListenersRemoved()
    dispatchPointer(window, 'pointermove', 31, 130, 600)
    dispatchPointer(window, 'pointerup', 31, 130, 600)
    expect(document.querySelector('[data-slot="event-calendar-drag-carry"]')).toBeNull()
    expect(rescheduleMock).not.toHaveBeenCalled()

    // A real drag creates the body-level carry and proposal. Hiding cleans both;
    // a release after the calendar becomes visible again is stale and inert.
    rerender(<CalendarView visible />)
    dispatchPointer(focus, 'pointerdown', 32, 130, 540)
    dispatchPointer(window, 'pointermove', 32, 130, 600)
    expect(document.querySelector('[data-slot="event-calendar-drag-carry"]')).not.toBeNull()
    rerender(<CalendarView visible={false} />)
    expectPointerListenersRemoved()
    expect(document.querySelector('[data-slot="event-calendar-drag-carry"]')).toBeNull()
    expect(document.body).not.toHaveClass('ec-dragging')
    dispatchPointer(window, 'pointermove', 32, 130, 900)
    expect(focus).not.toHaveAttribute('data-dragging', 'true')
    rerender(<CalendarView visible />)
    dispatchPointer(window, 'pointerup', 32, 130, 600)
    expect(rescheduleMock).not.toHaveBeenCalled()

    // Blocked gestures (e.g. an event with guests) own cleanup even though no
    // normal drag proposal is created.
    dispatchPointer(sync, 'pointerdown', 33, 130, 540)
    dispatchPointer(window, 'pointermove', 33, 130, 550)
    expect(document.body).toHaveClass('ec-drag-blocked')
    rerender(<CalendarView visible={false} />)
    expectPointerListenersRemoved()
    expect(document.body).not.toHaveClass('ec-drag-blocked')
    dispatchPointer(window, 'pointerup', 33, 130, 550)

    // A fresh gesture on the redisplayed calendar still works.
    rerender(<CalendarView visible />)
    dispatchPointer(focus, 'pointerdown', 34, 130, 540)
    dispatchPointer(window, 'pointermove', 34, 130, 900)
    expect(document.querySelector('[data-slot="event-calendar-drag-carry"]')).not.toBeNull()
    expect(focus).toHaveAttribute('data-dragging', 'true')
    dispatchPointer(window, 'pointerup', 34, 130, 900)
    expect(document.querySelector('[data-slot="event-calendar-drag-carry"]')).toBeNull()
    expect(rescheduleMock).toHaveBeenCalledExactlyOnceWith({
      id: 'focus-1',
      start: at(15),
      end: at(16),
    })
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

  test.each(['vault', 'account'])(
    'withholds an old shared calendar row while the new %s agenda loads',
    async (changed) => {
      const user = userEvent.setup()
      const nextRemote = changed === 'vault' ? 'git@github.com:syv-ai/other.git' : NOTES
      const shared = { ...SYNC, calendarId: 'team', calendarName: 'Team', title: 'Shared workshop' }
      agendaMock.mockResolvedValue([shared])
      render(<CalendarView />)
      const staleChip = (await screen.findAllByText(shared.title))[0]!

      const newAgenda = deferred<GoogleEvent[]>()
      agendaMock.mockClear().mockReturnValue(newAgenda.promise)
      allAccountsMock.mockResolvedValue({ accounts: [{ sub: '2', email: ME }], current: '2' })
      await act(async () => {
        if (changed === 'vault') store.set(activeRemoteAtom, nextRemote)
        else store.set(refreshGoogleAtom)
      })
      await waitFor(() => expect(agendaMock).toHaveBeenCalledWith(expect.anything(), nextRemote))
      expect(screen.queryByText(shared.title)).not.toBeInTheDocument()
      fireEvent.click(staleChip)
      expect(screen.queryByRole('dialog', { name: shared.title })).not.toBeInTheDocument()
      expect(eventAttachmentsMock).not.toHaveBeenCalled()

      // Both accounts can see the same calendar and event ID. Only the row
      // returned for this account may open its attachment actions.
      await act(async () => newAgenda.resolve([shared]))
      await user.click((await screen.findAllByText(shared.title))[0]!)
      expect(await screen.findByRole('dialog', { name: shared.title })).toBeInTheDocument()
      expect(eventAttachmentsMock).toHaveBeenCalledWith(nextRemote, {
        expectedAccountSub: '2',
        calendarId: 'team',
        eventId: shared.id,
      })
    },
  )

  test('rejects both cached and live agenda rows when the mapping changes before their reads finish', async () => {
    const user = userEvent.setup()
    const cached = deferred<void>()
    const live = deferred<void>()
    let mappedSub = '1'
    const sharedFrom = (title: string) => [{ ...SYNC, calendarId: 'team', title }]
    const read = async (
      release: Promise<void>,
      { expectedAccountSub }: { expectedAccountSub?: string },
      title: string,
    ) => {
      await release
      if (expectedAccountSub !== undefined && expectedAccountSub !== mappedSub) {
        throw Object.assign(new Error('Google account changed.'), { data: { code: 'FORBIDDEN' } })
      }
      return sharedFrom(title)
    }
    agendaCachedMock.mockImplementationOnce((params) =>
      read(cached.promise, params, 'Wrong cached workshop'),
    )
    agendaMock.mockImplementationOnce((params) => read(live.promise, params, 'Wrong live workshop'))
    render(<CalendarView />)
    await waitFor(() => {
      for (const request of [agendaMock, agendaCachedMock]) {
        expect(request).toHaveBeenCalledWith(
          expect.objectContaining({ expectedAccountSub: '1' }),
          NOTES,
        )
      }
    })

    // Main learns of the new mapping while the renderer still holds account 1.
    mappedSub = '2'
    allAccountsMock.mockResolvedValue({
      accounts: [{ sub: mappedSub, email: ME }],
      current: mappedSub,
    })
    await act(async () => cached.resolve())
    expect(screen.queryByText('Wrong cached workshop')).not.toBeInTheDocument()
    await act(async () => live.resolve())
    const alert = await screen.findByRole('alert')
    expect(screen.queryByText('Wrong live workshop')).not.toBeInTheDocument()

    agendaMock.mockResolvedValue(sharedFrom('Current workshop'))
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await user.click((await screen.findAllByText('Current workshop'))[0]!)
    const card = await screen.findByRole('dialog', { name: 'Current workshop' })
    expect(await within(card).findByText('No attachments')).toBeInTheDocument()
    expect(eventAttachmentsMock).toHaveBeenCalledWith(NOTES, {
      expectedAccountSub: '2',
      calendarId: 'team',
      eventId: SYNC.id,
    })
  })

  test('attaches selected Drive search results only after confirming guest access', async () => {
    const user = userEvent.setup()
    const target: EventAttachmentTarget = {
      expectedAccountSub: '1',
      calendarId: ME,
      eventId: SYNC.id,
    }
    const actual = [HANDOUT, attachmentOf(AGENDA), attachmentOf(BRIEF)]
    let written = false
    eventAttachmentsMock.mockImplementation(async () => ({
      attachments: written ? actual : [HANDOUT],
      canAttach: true,
    }))
    let resolveBrowsing!: (page: DriveFilePage) => void
    driveFilesMock.mockImplementation(async (_remote, { query, pageToken }) => {
      if (!query)
        return new Promise<DriveFilePage>((resolve) => {
          resolveBrowsing = resolve
        })
      return pageToken === 'next-workshop'
        ? { files: [BRIEF] }
        : { files: [AGENDA], nextPageToken: 'next-workshop' }
    })
    attachEventFilesMock.mockImplementation(async (): Promise<AttachEventFilesResult> => {
      written = true
      return {
        attachments: actual,
        attachmentStatus: 'attached',
        sharing: [
          { fileId: AGENDA.id, guest: 'team@example.test', status: 'granted' },
          { fileId: BRIEF.id, guest: 'team@example.test', status: 'failed' },
          { fileId: BRIEF.id, guest: 'guest@example.test', status: 'unknown' },
        ],
      }
    })

    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    const detail = within(await screen.findByRole('dialog', { name: 'Team sync' }))
    await user.click(await detail.findByRole('button', { name: HANDOUT.title }))
    expect(window.holi.openExternal).toHaveBeenCalledWith(HANDOUT.fileUrl)
    expect(eventAttachmentsMock).toHaveBeenCalledWith(NOTES, target)
    expect(detail.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    await user.click(detail.getByRole('button', { name: 'Add from Drive' }))

    const picker = within(await screen.findByRole('dialog', { name: 'Add from Google Drive' }))
    await user.type(picker.getByRole('searchbox'), 'workshop{Enter}')
    await user.click(await picker.findByRole('checkbox', { name: AGENDA.name }))
    await act(async () => resolveBrowsing({ files: [{ ...BRIEF, name: 'Stale browsing result' }] }))
    expect(
      picker.queryByRole('checkbox', { name: 'Stale browsing result' }),
    ).not.toBeInTheDocument()
    await user.click(picker.getByRole('button', { name: 'Load more' }))
    await user.click(await picker.findByRole('checkbox', { name: BRIEF.name }))
    expect(picker.getByRole('checkbox', { name: AGENDA.name })).toBeChecked()
    expect(driveFilesMock).toHaveBeenCalledWith(NOTES, {
      ...target,
      query: 'workshop',
      pageToken: 'next-workshop',
    })
    await user.click(picker.getByRole('button', { name: 'Review files' }))
    const confirmation = within(await screen.findByRole('dialog', { name: 'Confirm file sharing' }))
    expect(confirmation.getByText(AGENDA.name)).toBeInTheDocument()
    expect(confirmation.getByText(BRIEF.name)).toBeInTheDocument()
    expect(attachEventFilesMock).not.toHaveBeenCalled()
    await user.click(confirmation.getByRole('button', { name: 'Attach and share with guests' }))

    const write = { ...target, fileIds: [AGENDA.id, BRIEF.id] }
    expect(attachEventFilesMock).toHaveBeenCalledExactlyOnceWith(NOTES, write)
    expect(await detail.findByRole('button', { name: BRIEF.name })).toBeInTheDocument()
    const outcome = detail.getByRole('alert')
    expect(outcome).toHaveTextContent('Files attached')
    expect(outcome).toHaveTextContent(/guest access incomplete.*workshop brief.*team@example.test/i)
    expect(outcome).toHaveTextContent(/sharing not confirmed.*guest@example.test/i)
    expect(detail.getByRole('button', { name: 'Add from Drive' })).toBeDisabled()
    expect(
      detail.queryByRole('button', { name: /revise selection|review sharing retry/i }),
    ).not.toBeInTheDocument()

    const checked = {
      attachments: actual,
      attachmentStatus: 'attached',
      sharingComplete: false,
      sharing: [
        { fileId: AGENDA.id, guest: 'team@example.test', status: 'already-accessible' },
        { fileId: BRIEF.id, guest: 'team@example.test', status: 'failed' },
        { fileId: BRIEF.id, guest: 'guest@example.test', status: 'unknown' },
      ],
    } as const
    checkEventFileAccessMock.mockResolvedValueOnce(checked).mockResolvedValueOnce({
      ...checked,
      sharing: [
        ...checked.sharing.slice(0, 2),
        { ...checked.sharing[2], status: 'already-accessible' },
      ],
    })
    await user.click(detail.getByRole('button', { name: 'Check file access' }))
    const check = await detail.findByRole('button', { name: 'Check guest access' })
    expect(detail.getByRole('alert')).toHaveTextContent(
      /sharing not confirmed.*guest@example.test/i,
    )
    expect(
      detail.queryByRole('button', { name: /revise selection|review sharing retry/i }),
    ).not.toBeInTheDocument()
    expect(checkEventFileAccessMock).toHaveBeenCalledExactlyOnceWith(NOTES, write)
    await user.click(check)
    await waitFor(() =>
      expect(detail.getByRole('alert')).toHaveTextContent(/guest access confirmed for 2/i),
    )
    expect(detail.getByRole('alert')).not.toHaveTextContent(/sharing not confirmed/i)
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)

    await user.click(await detail.findByRole('button', { name: 'Review sharing retry' }))
    const revised = within(await screen.findByRole('dialog', { name: 'Add from Google Drive' }))
    await user.click(revised.getByRole('button', { name: 'Review files' }))
    const retry = within(await screen.findByRole('dialog', { name: 'Confirm file sharing' }))
    expect(retry.queryByText(AGENDA.name)).not.toBeInTheDocument()
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
    attachEventFilesMock.mockResolvedValueOnce({
      attachments: actual,
      attachmentStatus: 'attached',
      sharing: [
        { fileId: BRIEF.id, guest: 'team@example.test', status: 'granted' },
        { fileId: BRIEF.id, guest: 'guest@example.test', status: 'already-accessible' },
      ],
    })
    await user.click(retry.getByRole('button', { name: 'Attach and share with guests' }))
    expect(attachEventFilesMock).toHaveBeenLastCalledWith(NOTES, { ...target, fileIds: [BRIEF.id] })
    await waitFor(() =>
      expect(detail.getByRole('alert')).not.toHaveTextContent(/guest access incomplete/i),
    )
  })

  test('returns from Connections with a read-only check and explicit retry for attached files', async () => {
    const user = userEvent.setup()
    const actual = [attachmentOf(BRIEF)]
    const grant = { fileId: BRIEF.id, guest: 'first@example.test', status: 'granted' }
    const refusal = { fileId: BRIEF.id, guest: 'second@example.test', status: 'failed' }
    eventAttachmentsMock
      .mockResolvedValueOnce({ attachments: [], canAttach: true })
      .mockResolvedValue({ attachments: actual, canAttach: true })
    driveFilesMock.mockResolvedValue({ files: [BRIEF] })
    attachEventFilesMock
      .mockResolvedValueOnce({
        attachments: actual,
        attachmentStatus: 'attached',
        sharingComplete: false,
        reconnect: true,
        sharing: [grant],
      })
      .mockResolvedValue({ attachments: actual, attachmentStatus: 'attached', sharing: [grant] })
    checkEventFileAccessMock.mockResolvedValue({
      attachments: actual,
      attachmentStatus: 'attached',
      sharingComplete: false,
      sharing: [grant, refusal],
    })
    finishConsentMock.mockImplementation(async () => {
      statusMock.mockResolvedValue({ account: { email: ME }, missingScopes: [] })
      return { kind: 'granted' }
    })
    const shell = (settingsOpen: boolean) => (
      <>
        <div hidden={settingsOpen}>
          <CalendarView visible={!settingsOpen} />
        </div>
        {settingsOpen && <ConnectionsSection />}
      </>
    )
    const view = render(shell(false))
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    await confirmDriveFiles(user, [BRIEF.name])
    expect(await screen.findByRole('button', { name: BRIEF.name })).toBeInTheDocument()
    const partial = screen.getByRole('alert')
    expect(partial).toHaveTextContent(/guest access incomplete/i)
    expect(partial).toHaveTextContent(/files attached/i)
    expect(partial).toHaveTextContent(/guest access confirmed for 1/i)
    statusMock.mockResolvedValue({
      account: { email: ME },
      missingScopes: ['https://www.googleapis.com/auth/drive'],
    })
    await user.click(within(partial).getByRole('button', { name: 'Open Connections' }))
    // Mirror the shell parking Calendar when the Settings tab takes focus.
    view.rerender(shell(true))
    expect(partial).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Team sync' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Reconnect' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
      expect(screen.queryByText('Holi needs new permissions')).not.toBeInTheDocument()
    })

    view.rerender(shell(false))
    const returned = within(await screen.findByRole('dialog', { name: 'Team sync' }))
    expect(await returned.findByRole('button', { name: BRIEF.name })).toBeInTheDocument()
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
    expect(checkEventFileAccessMock).not.toHaveBeenCalled()
    await user.click(returned.getByRole('button', { name: 'Check file access' }))
    expect(await returned.findByRole('alert')).toHaveTextContent('second@example.test')
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)

    await user.click(await returned.findByRole('button', { name: 'Review sharing retry' }))
    const revised = within(await screen.findByRole('dialog', { name: 'Add from Google Drive' }))
    expect(
      revised.getByRole('checkbox', { name: /Workshop brief.*already attached/i }),
    ).toBeChecked()
    await waitFor(() => expect(revised.getByRole('button', { name: 'Review files' })).toBeEnabled())
    await user.click(revised.getByRole('button', { name: 'Review files' }))
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Attach and share with guests' }))
    await waitFor(() =>
      expect(attachEventFilesMock).toHaveBeenLastCalledWith(NOTES, {
        expectedAccountSub: '1',
        calendarId: ME,
        eventId: SYNC.id,
        fileIds: [BRIEF.id],
      }),
    )
    expect(attachEventFilesMock).toHaveBeenCalledTimes(2)
  })

  test('finds guest access after a fresh mount and retries only through explicit confirmation', async () => {
    const user = userEvent.setup()
    const actual = [
      attachmentOf(BRIEF),
      { title: 'Reference link', fileUrl: 'https://example.test/ref' },
    ]
    const pending = { fileId: BRIEF.id, guest: 'first@example.test', status: 'unknown' }
    const refused = { fileId: BRIEF.id, guest: 'second@example.test', status: 'failed' }
    eventAttachmentsMock.mockResolvedValue({ attachments: actual, canAttach: true })
    driveFilesMock.mockResolvedValue({ files: [BRIEF] })
    checkEventFileAccessMock
      .mockResolvedValueOnce({
        attachments: actual,
        attachmentStatus: 'attached',
        sharingComplete: false,
        sharing: [pending, refused],
      })
      .mockResolvedValueOnce({
        attachments: actual,
        attachmentStatus: 'attached',
        sharingComplete: false,
        sharing: [{ ...pending, status: 'already-accessible' }, refused],
      })
    attachEventFilesMock.mockResolvedValue({
      attachments: actual,
      attachmentStatus: 'attached',
      sharingComplete: true,
      sharing: [
        { ...pending, status: 'already-accessible' },
        { ...refused, status: 'granted' },
      ],
    })

    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    const check = await screen.findByRole('button', { name: 'Check guest access' })
    expect(checkEventFileAccessMock).not.toHaveBeenCalled()
    await user.click(check)
    expect(
      await screen.findByText(/sharing not confirmed.*first@example.test/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /revise selection|review sharing retry/i }),
    ).not.toBeInTheDocument()
    expect(attachEventFilesMock).not.toHaveBeenCalled()
    const target = {
      expectedAccountSub: '1',
      calendarId: ME,
      eventId: SYNC.id,
      fileIds: [BRIEF.id],
    }
    expect(checkEventFileAccessMock).toHaveBeenCalledExactlyOnceWith(NOTES, target)

    // Google now reports access for the formerly uncertain guest. The other
    // guest still lacks access; that file may be selected for an explicit retry.
    await user.click(screen.getByRole('button', { name: 'Check guest access' }))
    await user.click(await screen.findByRole('button', { name: 'Review sharing retry' }))
    expect(
      screen.getByRole('checkbox', { name: /Workshop brief.*already attached/i }),
    ).toBeChecked()
    await user.click(await screen.findByRole('button', { name: 'Review files' }))
    const confirm = within(await screen.findByRole('dialog', { name: 'Confirm file sharing' }))
    expect(attachEventFilesMock).not.toHaveBeenCalled()
    await user.click(confirm.getByRole('button', { name: 'Attach and share with guests' }))
    expect(attachEventFilesMock).toHaveBeenCalledExactlyOnceWith(NOTES, target)
  })

  test('keeps a removed file off the card when the access check needs reconnect and a list read is late', async () => {
    const user = userEvent.setup()
    const actual = [attachmentOf(BRIEF), attachmentOf(AGENDA)]
    const remaining = [attachmentOf(BRIEF)]
    const beforeCheck = deferred<{ attachments: typeof actual; canAttach: boolean }>()
    const afterCheck = deferred<{ attachments: typeof actual; canAttach: boolean }>()
    eventAttachmentsMock
      .mockResolvedValueOnce({ attachments: [], canAttach: true })
      .mockReturnValueOnce(beforeCheck.promise)
      .mockReturnValue(afterCheck.promise)
    driveFilesMock.mockResolvedValue({ files: [BRIEF, AGENDA] })
    attachEventFilesMock.mockResolvedValue({
      attachments: actual,
      attachmentStatus: 'attached',
      sharingComplete: false,
      sharing: [{ fileId: AGENDA.id, guest: 'guest@example.test', status: 'granted' }],
    })
    checkEventFileAccessMock.mockResolvedValue({
      attachments: remaining,
      attachmentStatus: 'unknown',
      sharingComplete: false,
      reconnect: true,
      sharing: [],
    })
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    await confirmDriveFiles(user, [BRIEF.name, AGENDA.name])
    await user.click(await screen.findByRole('button', { name: 'Check file access' }))
    expect(await screen.findByRole('button', { name: 'Open Connections' })).toBeEnabled()
    await act(async () => beforeCheck.resolve({ attachments: actual, canAttach: true }))
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      /files attached|guest access confirmed/i,
    )
    expect(screen.queryByRole('button', { name: AGENDA.name })).not.toBeInTheDocument()
    await act(async () => afterCheck.resolve({ attachments: remaining, canAttach: true }))
    expect(await screen.findByRole('button', { name: BRIEF.name })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: AGENDA.name })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /revise selection|review sharing retry/i }),
    ).not.toBeInTheDocument()
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
  })

  test('allows explicit confirmation after a known no-write preflight and a fresh event read', async () => {
    const user = userEvent.setup()
    const refreshed = deferred<{ attachments: []; canAttach: boolean }>()
    eventAttachmentsMock
      .mockResolvedValueOnce({ attachments: [], canAttach: true })
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValue({ attachments: [attachmentOf(BRIEF)], canAttach: true })
    driveFilesMock.mockResolvedValue({ files: [BRIEF] })
    attachEventFilesMock
      .mockResolvedValueOnce({
        attachments: [],
        attachmentStatus: 'failed',
        sharing: [],
        reconnect: true,
      })
      .mockResolvedValue({
        attachments: [attachmentOf(BRIEF)],
        attachmentStatus: 'attached',
        sharing: [],
      })
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    await confirmDriveFiles(user, [BRIEF.name])
    expect(await screen.findByRole('alert')).toHaveTextContent(/attachment failed/i)
    expect(
      screen.queryByRole('button', { name: /revise selection|review sharing retry/i }),
    ).not.toBeInTheDocument()
    await act(async () => refreshed.resolve({ attachments: [], canAttach: true }))
    await user.click(await screen.findByRole('button', { name: 'Revise selection' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review files' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Review files' }))
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
    expect(checkEventFileAccessMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Attach and share with guests' }))
    expect(await screen.findByRole('button', { name: BRIEF.name })).toBeInTheDocument()
    expect(attachEventFilesMock).toHaveBeenCalledTimes(2)
  })

  test('keeps a lost submit response locked for a read-only check', async () => {
    const user = userEvent.setup()
    eventAttachmentsMock.mockResolvedValue({ attachments: [], canAttach: true })
    driveFilesMock.mockResolvedValue({ files: [BRIEF] })
    attachEventFilesMock.mockRejectedValue(new Error('Connection to Holi was interrupted.'))
    checkEventFileAccessMock.mockResolvedValue({
      attachments: [],
      attachmentStatus: 'unknown',
      sharing: [],
    })
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    await confirmDriveFiles(user, [BRIEF.name])
    expect(await screen.findByRole('alert')).toHaveTextContent(/attachment not confirmed/i)
    await user.click(await screen.findByRole('button', { name: 'Check file access' }))
    expect(await screen.findByRole('button', { name: 'Add from Drive' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /revise selection|review sharing retry/i }),
    ).not.toBeInTheDocument()
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
  })

  test('counts all existing attachments and lets people revise a selection after the limit changes', async () => {
    const user = userEvent.setup()
    const attachments = Array.from({ length: 23 }, (_, index) => ({
      title: `Resource ${index}`,
      fileUrl: `https://example.test/resource/${index}`,
    }))
    const changed = [...attachments, HANDOUT]
    eventAttachmentsMock
      .mockResolvedValueOnce({ attachments, canAttach: true })
      .mockResolvedValueOnce({ attachments: changed, canAttach: true })
      .mockResolvedValue({ attachments: [...changed, attachmentOf(AGENDA)], canAttach: true })
    driveFilesMock.mockResolvedValue({
      files: [AGENDA, BRIEF, { ...BRIEF, id: 'notes', name: 'Notes' }],
    })
    attachEventFilesMock
      .mockResolvedValueOnce({
        attachments: changed,
        attachmentStatus: 'failed',
        sharing: [],
        message: 'Attachment limit reached.',
      })
      .mockResolvedValueOnce({
        attachments: [...changed, attachmentOf(AGENDA)],
        attachmentStatus: 'attached',
        sharing: [],
      })

    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    const detail = within(await screen.findByRole('dialog', { name: 'Team sync' }))
    await user.click(await detail.findByRole('button', { name: 'Add from Drive' }))
    const picker = within(await screen.findByRole('dialog', { name: 'Add from Google Drive' }))
    expect(picker.getByRole('status', { name: '' })).toHaveTextContent(/2 attachment slots left/i)
    await user.click(await picker.findByRole('checkbox', { name: AGENDA.name }))
    await user.click(picker.getByRole('checkbox', { name: BRIEF.name }))
    expect(picker.getByRole('checkbox', { name: 'Notes' })).toBeDisabled()
    await user.click(picker.getByRole('button', { name: 'Review files' }))
    await user.click(screen.getByRole('button', { name: 'Attach and share with guests' }))
    expect(await detail.findByRole('alert')).toHaveTextContent(/attachment limit reached/i)

    await user.click(await detail.findByRole('button', { name: 'Revise selection' }))
    const revised = within(await screen.findByRole('dialog', { name: 'Add from Google Drive' }))
    expect(revised.getByRole('button', { name: 'Review files' })).toBeDisabled()
    await user.click(revised.getByRole('checkbox', { name: BRIEF.name }))
    await user.click(revised.getByRole('button', { name: 'Review files' }))
    const confirm = within(await screen.findByRole('dialog', { name: 'Confirm file sharing' }))
    expect(confirm.getByText(AGENDA.name)).toBeInTheDocument()
    expect(confirm.queryByText(BRIEF.name)).not.toBeInTheDocument()
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
    await user.click(confirm.getByRole('button', { name: 'Attach and share with guests' }))
    expect(attachEventFilesMock).toHaveBeenLastCalledWith(
      NOTES,
      expect.objectContaining({ fileIds: [AGENDA.id] }),
    )
    expect(await detail.findByRole('button', { name: AGENDA.name })).toBeInTheDocument()
  })

  test('can start a reconnect after a runtime scope refusal even with no stored scope gaps', async () => {
    const user = userEvent.setup()
    eventAttachmentsMock.mockResolvedValue({ attachments: [], canAttach: true })
    driveFilesMock.mockRejectedValue(
      Object.assign(new Error('this Google permission was not granted'), {
        data: { code: 'FORBIDDEN' },
      }),
    )
    const consent = deferred<{ kind: 'denied' }>()
    finishConsentMock.mockReturnValue(consent.promise)
    const view = render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    await user.click(await screen.findByRole('button', { name: 'Add from Drive' }))
    const picker = within(await screen.findByRole('dialog', { name: 'Add from Google Drive' }))
    await user.click(await picker.findByRole('button', { name: 'Open Connections' }))
    // Mirror the shell switching to Connections.
    view.rerender(<ConnectionsSection />)
    expect(await screen.findByText('What Holi may do')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
    await act(async () => consent.resolve({ kind: 'denied' }))
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeEnabled()
    expect(attachEventFilesMock).not.toHaveBeenCalled()
  })

  test('offers Drive read retry without suggesting reconnect when event editability changed', async () => {
    const user = userEvent.setup()
    eventAttachmentsMock.mockResolvedValue({ attachments: [], canAttach: true })
    driveFilesMock.mockRejectedValueOnce(
      Object.assign(new Error('This event cannot be changed by this account.'), {
        data: { code: 'FORBIDDEN' },
      }),
    )
    driveFilesMock.mockResolvedValueOnce({ files: [] })
    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    await user.click(await screen.findByRole('button', { name: 'Add from Drive' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Add from Google Drive' }))
    expect(await dialog.findByRole('alert')).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Open Connections' })).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Retry' }))
    expect(await dialog.findByRole('button', { name: 'Refresh files' })).toBeEnabled()
    expect(dialog.getByRole('button', { name: 'Review files' })).toBeDisabled()
    expect(attachEventFilesMock).not.toHaveBeenCalled()
  })

  test('does not show the outcome of a write from a vault left while it was pending', async () => {
    const user = userEvent.setup()
    const otherVault = 'git@github.com:syv-ai/other.git'
    eventAttachmentsMock.mockImplementation(async (remote: string) => ({
      canAttach: true,
      attachments: remote === NOTES ? [] : [HANDOUT],
    }))
    driveFilesMock.mockResolvedValue({ files: [BRIEF] })
    let finishOldWrite!: (result: AttachEventFilesResult) => void
    attachEventFilesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOldWrite = resolve
        }),
    )

    render(<CalendarView />)
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    await user.click(await screen.findByRole('button', { name: 'Add from Drive' }))
    await user.click(await screen.findByRole('checkbox', { name: BRIEF.name }))
    await user.click(screen.getByRole('button', { name: 'Review files' }))
    await user.click(screen.getByRole('button', { name: 'Attach and share with guests' }))
    expect(attachEventFilesMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: BRIEF.name })).not.toBeInTheDocument()

    await act(async () => store.set(activeRemoteAtom, otherVault))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click((await screen.findAllByText('Team sync'))[0]!)
    const detail = within(await screen.findByRole('dialog', { name: 'Team sync' }))
    expect(await detail.findByRole('button', { name: HANDOUT.title })).toBeInTheDocument()
    await act(async () =>
      finishOldWrite({
        attachments: [attachmentOf(BRIEF)],
        attachmentStatus: 'attached',
        sharing: [],
      }),
    )
    expect(detail.queryByRole('button', { name: BRIEF.name })).not.toBeInTheDocument()
    expect(detail.queryByText('Files attached')).not.toBeInTheDocument()
  })

  test('New event creates a solo event only after explicit send', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await waitFor(() => expect(title).toBeEnabled())
    await user.type(title, 'Lunch with Ada')
    expect(screen.getByRole('img', { name: 'About all-day events' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Location' }), 'Café')
    expect(scheduleMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    const sent = scheduleMock.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({
      title: 'Lunch with Ada',
      location: 'Café',
      guests: [],
      meet: false,
      sub: '1',
    })
    expect(sent.allDay).toBe(false)
    expect(localDate(new Date(sent['start'] as string))).toBe(localDate(new Date()))
    expect(await screen.findByText('Event created.')).toBeInTheDocument()
    expect(screen.queryByText(/Delivery is uncertain/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('an all-day event goes as days, its end the day after', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await waitFor(() => expect(title).toBeEnabled())
    await user.type(title, 'Holiday')
    await user.click(screen.getByRole('switch', { name: /All day/ }))
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    const sent = scheduleMock.mock.calls[0]![0] as Record<string, unknown>
    const today = new Date()
    expect(sent).toMatchObject({
      allDay: true,
      start: localDate(today),
      end: localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)),
    })
  })

  test('guest meeting sends only from its explicit action with Meet enabled', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await waitFor(() => expect(title).toBeEnabled())
    await user.type(title, 'Planning session')
    await user.type(
      screen.getByRole('textbox', { name: 'Guests' }),
      'ada@example.com, grace@example.com',
    )
    const meetSwitch = screen.getByRole('switch', { name: 'Add Google Meet' })
    await user.click(meetSwitch)
    expect(meetSwitch).toBeChecked()
    screen.getByRole('textbox', { name: 'Guests' }).focus()
    await user.keyboard('{Enter}')
    expect(scheduleMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Create and send invitations' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    expect(scheduleMock.mock.calls[0]![0]).toMatchObject({
      title: 'Planning session',
      guests: ['ada@example.com', 'grace@example.com'],
      meet: true,
      sub: '1',
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

  test.each(['submit', 'check'] as const)(
    '%s completion reloads the current week after navigation',
    async (completion) => {
      const user = userEvent.setup()
      const operation: MeetingOperation = {
        input: {
          operation: '11111111-1111-4111-8111-111111111111',
          sub: '1',
          title: 'Planning session',
          start: '2027-01-12T10:00:00Z',
          end: '2027-01-12T11:00:00Z',
          allDay: false,
          location: '',
          guests: ['guest@example.com'],
          meet: true,
        },
        eventId: 'new',
        conferenceRequestId: '22222222-2222-4222-8222-222222222222',
        fingerprint: 'synthetic',
        attempts: 1,
        accepted: false,
        conference: 'pending',
        htmlLink: null,
        conferenceUrl: null,
      }
      let resolve!: (value: MeetingOperation) => void
      if (completion === 'check') {
        meetingStateMock.mockResolvedValue({ meetSupported: true, operation })
        checkMeetingMock.mockReturnValueOnce(new Promise((done) => (resolve = done)))
      } else {
        scheduleMock.mockReturnValueOnce(new Promise((done) => (resolve = done)))
      }

      const { container } = render(<CalendarView />)
      await screen.findAllByText('Focus block')
      let card = screen.queryByRole('dialog')
      if (!card) {
        await user.click(screen.getByRole('button', { name: 'New event' }))
        card = await screen.findByRole('dialog', { name: 'New event' })
      }
      if (completion === 'check') {
        await user.click(within(card).getByRole('button', { name: 'Check status' }))
      } else {
        await user.type(within(card).getByRole('textbox', { name: 'Title' }), 'Planning session')
        await user.type(within(card).getByRole('textbox', { name: 'Guests' }), 'guest@example.com')
        await user.click(within(card).getByRole('switch', { name: 'Add Google Meet' }))
        await user.click(within(card).getByRole('button', { name: 'Create and send invitations' }))
      }

      const root = container.querySelector<HTMLElement>('[data-slot="event-calendar"]')!
      const requestFrom = () => (agendaMock.mock.calls.at(-1)![0] as { from: string }).from
      const originalWeek = Date.parse(requestFrom())
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
      await waitFor(() => {
        expect(Math.round((Date.parse(requestFrom()) - originalWeek) / 86_400_000)).toBe(7)
      })
      const currentWeek = requestFrom()
      await act(async () => resolve({ ...operation, accepted: true }))
      await waitFor(() =>
        expect(agendaMock.mock.calls.at(-1)![0]).toMatchObject({ from: currentWeek }),
      )
    },
  )

  test('a pending write is single-flight and keeps its anchored card open', async () => {
    const user = userEvent.setup()
    let resolve!: (value: MeetingOperation) => void
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
    const closeButtons = within(card).getAllByRole('button', { name: 'Close' })
    expect(closeButtons).toHaveLength(2)
    for (const button of closeButtons) expect(button).toBeEnabled()
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    const input = scheduleMock.mock.calls[0]![0] as MeetingInput
    resolve({
      input,
      eventId: 'new',
      conferenceRequestId: '22222222-2222-4222-8222-222222222222',
      fingerprint: 'synthetic',
      attempts: 1,
      accepted: true,
      conference: 'none',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=new',
      conferenceUrl: null,
    })
    expect(await within(card).findByText('Event created.')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('Enter does not send; the explicit action sends and restores focus on done', async () => {
    const user = userEvent.setup()
    render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const trigger = screen.getByRole('button', { name: 'New event' })
    await user.click(trigger)
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.type(title, 'Enter-saved event')
    await user.keyboard('{Enter}')
    expect(scheduleMock).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add event' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    await user.click(await screen.findByRole('button', { name: 'Done' }))
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

    store.set(activeRemoteAtom, 'git@github.com:syv-ai/other.git')
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
    expect(scheduleMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Add event' }))
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

  test('parking closes calendar menus but retains the selected view and range', async () => {
    const user = userEvent.setup()
    const view = render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const switcher = screen.getByRole('button', { name: 'Select view' })
    await user.click(switcher)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    view.rerender(<CalendarView visible={false} />)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    view.rerender(<CalendarView visible />)
    expect(screen.getByRole('button', { name: 'Select view' })).toHaveTextContent('Week')
  })

  test('parking closes both calendar pickers without reopening either', async () => {
    const user = userEvent.setup()
    const view = render(<CalendarView />)
    await screen.findAllByText('Focus block')
    const triggers = screen.getAllByRole('button', { name: 'Calendars' })
    for (const trigger of triggers) {
      await user.click(trigger)
      expect(await screen.findByRole('menu')).toBeInTheDocument()
      view.rerender(<CalendarView visible={false} />)
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      expect(document.body.style.pointerEvents).toBe('')
      view.rerender(<CalendarView visible />)
      expect(screen.queryByRole('menu')).toBeNull()
    }
  })

  test('a create draft survives parking and cancel discards it', async () => {
    const user = userEvent.setup()
    const view = render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Draft event')
    view.rerender(<CalendarView visible={false} />)
    expect(screen.queryByRole('dialog', { name: 'New event' })).toBeNull()
    view.rerender(<CalendarView visible />)
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Draft event')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'New event' }))
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('')
  })

  test('a create draft retains guests and Meet through parking without sending', async () => {
    const user = userEvent.setup()
    const view = render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Draft event')
    await user.type(screen.getByRole('textbox', { name: 'Guests' }), 'guest@example.com')
    await user.click(screen.getByRole('switch', { name: 'Add Google Meet' }))
    expect(scheduleMock).not.toHaveBeenCalled()

    view.rerender(<CalendarView visible={false} />)
    view.rerender(<CalendarView visible />)
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Draft event')
    expect(screen.getByRole('textbox', { name: 'Guests' })).toHaveValue('guest@example.com')
    expect(screen.getByRole('switch', { name: 'Add Google Meet' })).toBeChecked()
    expect(scheduleMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Create and send invitations' }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1))
    expect(scheduleMock.mock.calls[0]![0]).toMatchObject({
      title: 'Draft event',
      guests: ['guest@example.com'],
      meet: true,
    })
  })

  test('an edit draft survives parking and account changes clear it', async () => {
    const user = userEvent.setup()
    const view = render(<CalendarView />)
    await screen.findAllByText('Focus block')
    await user.click(screen.getAllByText('Focus block')[0]!)
    const details = await screen.findByRole('dialog', { name: 'Focus block' })
    await user.click(within(details).getByRole('button', { name: 'Edit' }))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Edited focus')
    view.rerender(<CalendarView visible={false} />)
    view.rerender(<CalendarView visible />)
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Edited focus')

    store.set(activeRemoteAtom, 'git@github.com:syv-ai/other.git')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByRole('button', { name: 'New event' }))
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('')
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
