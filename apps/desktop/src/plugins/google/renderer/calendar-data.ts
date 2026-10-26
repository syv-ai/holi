/**
 * The calendar view's data: Google's agenda and calendar list, turned into the
 * events ReUI's event calendar draws, and the writes that view makes.
 *
 * Everything here goes through the capabilities the Agenda already uses
 * (`google.agenda`, `agendaCached`, `calendars`, `setCalendar`, `schedule`)
 * plus `reschedule` and `unschedule`, the agent's own attendee-free writes.
 * Main computes nothing about "today": the window is the visible range the
 * calendar reports, in this machine's time, as the Agenda's is.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { dayAfter, localDate } from '@holi/shared'
import type { CalendarEvent as CalendarItem } from '@/components/ui/event-calendar/event-calendar-types'
import type { CalendarChoice, CalendarEvent as GoogleEvent } from '../main/calendar'
import { googleCap } from './google-cap'
import { isDisconnected, messageOf } from './google-errors'

export type { CalendarChoice, GoogleEvent }

/** What a Google event carries beyond what the grid draws. */
export interface GoogleEventData {
  /** Google's id, unique per calendar only: the item's own id adds the
   *  calendar. */
  googleId: string
  calendarName: string
  htmlLink: string
  location: string | null
  description: string | null
  organizer: string | null
  /** People, the user included; rooms are not counted. */
  attendeeCount: number
  conferenceUrl: string | null
  myResponse: GoogleEvent['myResponse']
  kind: GoogleEvent['kind']
  /** False when it does not block time. */
  busy: boolean
  /** From a calendar the user owns. */
  mine: boolean
  /** An instance of a series. Google expands series itself
   *  (`singleEvents`), so the grid never sees a rule. */
  recurring: boolean
  /** Holi may move, edit and delete it: on the primary calendar, where every
   *  write goes, with nobody invited, since a change would email them. */
  editable: boolean
}

export type GoogleCalendarItem = CalendarItem<GoogleEventData>

/** The most one `google.agenda` call may ask for. */
const MAX_WINDOW_DAYS = 92
const DAY_MS = 86_400_000

/** Drawn when neither the event nor its calendar names a colour. */
export const FALLBACK_COLOR = 'var(--muted-foreground)'

/** A `YYYY-MM-DD` as this machine's midnight: the calendar paints all-day
 *  events on the days whose midnights they start and end on. */
const midnight = (day: string): Date => new Date(`${day.slice(0, 10)}T00:00:00`)

/** An item's id: Google's ids are unique per calendar, not across them, so a
 *  shared invitation on two calendars would otherwise collide. */
const itemId = (event: Pick<GoogleEvent, 'calendarId' | 'id'>): string =>
  `${event.calendarId}:${event.id}`

/**
 * One Google event as the calendar draws it. `ownCalendarId` is the primary
 * calendar's id (the account's address), the only calendar Holi writes to.
 */
export function toCalendarItem(
  event: GoogleEvent,
  ownCalendarId: string | null,
  calendarColor?: string | null,
): GoogleCalendarItem {
  const editable =
    ownCalendarId !== null && event.calendarId === ownCalendarId && event.attendeeCount === 0
  return {
    id: itemId(event),
    title: event.title || '(No title)',
    start: event.allDay ? midnight(event.start) : new Date(event.start),
    end: event.allDay ? midnight(event.end) : new Date(event.end),
    allDay: event.allDay,
    color: event.color ?? calendarColor ?? FALLBACK_COLOR,
    resourceId: event.calendarId,
    readOnly: !editable,
    data: {
      googleId: event.id,
      calendarName: event.calendarName,
      htmlLink: event.htmlLink,
      location: event.location ?? null,
      description: event.description,
      organizer: event.organizer,
      attendeeCount: event.attendeeCount,
      conferenceUrl: event.conferenceUrl,
      myResponse: event.myResponse,
      kind: event.kind,
      busy: event.busy,
      mine: event.mine,
      recurring: event.recurring,
      editable,
    },
  }
}

/** The instants to ask Google for, for a visible range: never more than one
 *  call allows, so a long agenda shows its first 92 days.
 * @public exported for its test
 */
export function rangeWindow(range: { start: Date; end: Date }): { from: string; to: string } {
  const from = range.start.getTime()
  const to = Math.min(range.end.getTime(), from + MAX_WINDOW_DAYS * DAY_MS)
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

/** An event as the person set it: when it is, what it is called, where. */
interface EventTimes {
  /** Absent on a move, which keeps the title Google has. */
  title?: string
  start: Date
  /** Exclusive, as Google's is: the midnight after an all-day event. */
  end: Date
  allDay: boolean
}

/** The raw params `schedule` and `reschedule` read: instants, or days for an
 *  all-day event, and the CLI's own `all-day` flag (spread, so the typed
 *  client, which names the parsed `allDay`, lets it through). */
function eventParams(times: EventTimes): { title?: string; start: string; end: string } {
  return {
    ...(times.title === undefined ? {} : { title: times.title }),
    start: times.allDay ? localDate(times.start) : times.start.toISOString(),
    end: times.allDay ? localDate(times.end) : times.end.toISOString(),
    ...(times.allDay ? { 'all-day': true } : {}),
  }
}

/** The midnight after `day`, for an all-day event's exclusive end. */
export const midnightAfter = (day: string): Date => midnight(dayAfter(day))

type CalendarStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }

export interface GoogleCalendarData {
  status: CalendarStatus
  /** A fetch is in flight; the last answer is still drawn. */
  loading: boolean
  events: GoogleEvent[]
  calendars: CalendarChoice[]
  /** Ask for this range; the same range again is a no-op. */
  showRange: (range: { start: Date; end: Date }) => void
  /** Read the range and the calendars again. */
  reload: () => void
  /** Switch a calendar on or off for every door: the setting main holds. */
  setCalendarEnabled: (id: string, enabled: boolean) => void
  /** Paint a move before Google answers it; the next load corrects it. */
  patchLocal: (key: string, times: Pick<EventTimes, 'start' | 'end' | 'allDay'>) => void
  create: (times: EventTimes & { title: string; location: string }) => Promise<void>
  update: (googleId: string, times: EventTimes) => Promise<void>
  remove: (googleId: string) => Promise<void>
}

/** Google's calendar for the open vault's account, a visible range at a time. */
export function useGoogleCalendar(remote: string | null): GoogleCalendarData {
  const [status, setStatus] = useState<CalendarStatus>({ kind: 'loading' })
  const [loading, setLoading] = useState(false)
  const [events, setEvents] = useState<GoogleEvent[]>([])
  const [calendars, setCalendars] = useState<CalendarChoice[]>([])
  const [window, setWindow] = useState<{ from: string; to: string } | null>(null)
  /** The newest load: an answer for a range already left arrives late and
   *  is dropped. */
  const latest = useRef(0)

  const loadCalendars = useCallback(() => {
    if (remote === null) return
    // No error surface of its own: the events' error covers an outage.
    void googleCap
      .calendars(remote)
      .then(setCalendars)
      .catch(() => setCalendars([]))
  }, [remote])

  const load = useCallback(() => {
    const asked = ++latest.current
    const current = (): boolean => asked === latest.current
    if (remote === null) {
      setStatus({ kind: 'disconnected' })
      return
    }
    if (window === null) return
    setLoading(true)
    // The last answer for this exact window paints while the live one is in
    // flight, and never stands in for it.
    void googleCap
      .agendaCached(remote, window)
      .then((cached) => {
        if (current() && cached !== null && cached.length > 0) {
          setEvents((shown) => (shown.length === 0 ? cached : shown))
          setStatus((s) => (s.kind === 'loading' ? { kind: 'ready' } : s))
        }
      })
      .catch(() => {})
    void googleCap.agenda(remote, window).then(
      (fresh) => {
        if (!current()) return
        setEvents(fresh)
        setStatus({ kind: 'ready' })
        setLoading(false)
      },
      (error: unknown) => {
        if (!current()) return
        setLoading(false)
        setStatus(
          isDisconnected(error)
            ? { kind: 'disconnected' }
            : { kind: 'error', message: messageOf(error, 'Could not load your calendar.') },
        )
      },
    )
  }, [remote, window])

  useEffect(load, [load])
  useEffect(loadCalendars, [loadCalendars])

  const showRange = useCallback((range: { start: Date; end: Date }) => {
    const next = rangeWindow(range)
    setWindow((shown) =>
      shown !== null && shown.from === next.from && shown.to === next.to ? shown : next,
    )
  }, [])

  const reload = useCallback(() => {
    load()
    loadCalendars()
  }, [load, loadCalendars])

  const setCalendarEnabled = useCallback(
    (id: string, enabled: boolean) => {
      setCalendars((all) => all.map((c) => (c.id === id ? { ...c, enabled } : c)))
      if (remote === null) return
      void googleCap
        .setCalendar(remote, { id, enabled })
        .then(load)
        // Put the box back rather than leave it lying about what main holds.
        .catch(loadCalendars)
    },
    [remote, load, loadCalendars],
  )

  const patchLocal = useCallback(
    (key: string, times: Pick<EventTimes, 'start' | 'end' | 'allDay'>) => {
      setEvents((all) =>
        all.map((event) =>
          itemId(event) === key
            ? {
                ...event,
                allDay: times.allDay,
                start: times.allDay ? localDate(times.start) : times.start.toISOString(),
                end: times.allDay ? localDate(times.end) : times.end.toISOString(),
              }
            : event,
        ),
      )
    },
    [],
  )

  const create = useCallback(
    async (times: EventTimes & { title: string; location: string }) => {
      if (remote === null) throw new Error('No vault is open.')
      await googleCap.schedule(remote, {
        ...eventParams(times),
        title: times.title,
        ...(times.location === '' ? {} : { location: times.location }),
      })
      load()
    },
    [remote, load],
  )

  const update = useCallback(
    async (googleId: string, times: EventTimes) => {
      if (remote === null) throw new Error('No vault is open.')
      await googleCap.reschedule(remote, { id: googleId, ...eventParams(times) })
      load()
    },
    [remote, load],
  )

  const remove = useCallback(
    async (googleId: string) => {
      if (remote === null) throw new Error('No vault is open.')
      await googleCap.unschedule(remote, { id: googleId })
      load()
    },
    [remote, load],
  )

  return {
    status,
    loading,
    events,
    calendars,
    showRange,
    reload,
    setCalendarEnabled,
    patchLocal,
    create,
    update,
    remove,
  }
}
