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
  /** The vault/account generation that supplied this occurrence. */
  sourceGeneration?: number
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
  sourceGeneration?: number,
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
      sourceGeneration,
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
  sourceGeneration: number
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

const NO_EVENTS: GoogleEvent[] = []
const NO_CALENDARS: CalendarChoice[] = []

/** Google's calendar for the open vault's account, a visible range at a time. */
export function useGoogleCalendar(
  remote: string | null,
  accountIdentity: string | null = null,
  accountReady = true,
): GoogleCalendarData {
  const [agenda, setAgenda] = useState<{
    generation: number
    events: GoogleEvent[]
    status: CalendarStatus
  } | null>(null)
  const [loadingGeneration, setLoadingGeneration] = useState<number | null>(null)
  const [choices, setChoices] = useState<{
    generation: number
    calendars: CalendarChoice[]
  } | null>(null)
  const [window, setWindow] = useState<{ from: string; to: string } | null>(null)
  /** The newest load: an answer for a range already left arrives late and
   *  is dropped. */
  const latest = useRef(0)
  const latestLoad = useRef<() => void>(() => {})
  const context = useRef({ remote, accountIdentity, accountReady, generation: 0 })
  if (context.current.remote !== remote || context.current.accountIdentity !== accountIdentity) {
    context.current = {
      remote,
      accountIdentity,
      accountReady,
      generation: context.current.generation + 1,
    }
    latest.current += 1
  }
  if (context.current.accountReady !== accountReady) {
    context.current.accountReady = accountReady
    latest.current += 1
  }
  const contextGeneration = context.current.generation

  const ownsContext = useCallback(
    () =>
      accountReady &&
      context.current.accountReady &&
      context.current.generation === contextGeneration,
    [accountReady, contextGeneration],
  )

  const loadCalendars = useCallback(() => {
    if (remote === null || !ownsContext()) return
    // No error surface of its own: the events' error covers an outage.
    void googleCap.calendars(remote).then(
      (calendars) => {
        if (ownsContext()) setChoices({ generation: contextGeneration, calendars })
      },
      () => {
        if (ownsContext()) setChoices({ generation: contextGeneration, calendars: [] })
      },
    )
  }, [remote, contextGeneration, ownsContext])

  const load = useCallback(() => {
    if (remote === null || window === null || !ownsContext()) return
    const asked = ++latest.current
    const generation = contextGeneration
    const current = () => asked === latest.current && ownsContext()
    let liveAnswered = false
    setLoadingGeneration(generation)
    // Cache is scoped by main to the account and window. Never let it paint
    // after the live read answers, including a legitimate empty response.
    void googleCap
      .agendaCached(remote, window)
      .then((cached) => {
        if (current() && !liveAnswered && cached !== null && cached.length > 0) {
          setAgenda((shown) =>
            shown?.generation === generation && shown.events.length > 0
              ? shown
              : { generation, events: cached, status: { kind: 'ready' } },
          )
        }
      })
      .catch(() => {})
    void googleCap.agenda(remote, window).then(
      (events) => {
        liveAnswered = true
        if (!current()) return
        setAgenda({ generation, events, status: { kind: 'ready' } })
        setLoadingGeneration(null)
      },
      (error: unknown) => {
        liveAnswered = true
        if (!current()) return
        setLoadingGeneration(null)
        setAgenda((shown) => ({
          generation,
          events: shown?.generation === generation ? shown.events : [],
          status: isDisconnected(error)
            ? { kind: 'disconnected' }
            : { kind: 'error', message: messageOf(error, 'Could not load your calendar.') },
        }))
      },
    )
  }, [remote, window, contextGeneration, ownsContext])
  latestLoad.current = load

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
      if (remote === null || !ownsContext()) return
      setChoices((shown) =>
        shown?.generation === contextGeneration
          ? {
              ...shown,
              calendars: shown.calendars.map((c) => (c.id === id ? { ...c, enabled } : c)),
            }
          : shown,
      )
      void googleCap
        .setCalendar(remote, { id, enabled })
        .then(load)
        // Put the box back rather than leave it lying about what main holds.
        .catch(loadCalendars)
    },
    [remote, contextGeneration, ownsContext, load, loadCalendars],
  )

  const patchLocal = useCallback(
    (key: string, times: Pick<EventTimes, 'start' | 'end' | 'allDay'>) => {
      if (!ownsContext()) return
      setAgenda((shown) =>
        shown?.generation === contextGeneration
          ? {
              ...shown,
              events: shown.events.map((event) =>
                itemId(event) === key
                  ? {
                      ...event,
                      allDay: times.allDay,
                      start: times.allDay ? localDate(times.start) : times.start.toISOString(),
                      end: times.allDay ? localDate(times.end) : times.end.toISOString(),
                    }
                  : event,
              ),
            }
          : shown,
      )
    },
    [contextGeneration, ownsContext],
  )

  const create = useCallback(
    async (times: EventTimes & { title: string; location: string }) => {
      if (remote === null || !ownsContext()) throw new Error('Google account changed.')
      const generation = context.current.generation
      await googleCap.schedule(remote, {
        ...eventParams(times),
        title: times.title,
        ...(times.location === '' ? {} : { location: times.location }),
      })
      if (context.current.generation === generation && context.current.remote === remote)
        latestLoad.current()
    },
    [remote, ownsContext],
  )

  const update = useCallback(
    async (googleId: string, times: EventTimes) => {
      if (remote === null || !ownsContext()) throw new Error('Google account changed.')
      const generation = context.current.generation
      await googleCap.reschedule(remote, { id: googleId, ...eventParams(times) })
      if (context.current.generation === generation && context.current.remote === remote)
        latestLoad.current()
    },
    [remote, ownsContext],
  )

  const remove = useCallback(
    async (googleId: string) => {
      if (remote === null || !ownsContext()) throw new Error('Google account changed.')
      const generation = context.current.generation
      await googleCap.unschedule(remote, { id: googleId })
      if (context.current.generation === generation && context.current.remote === remote)
        latestLoad.current()
    },
    [remote, ownsContext],
  )

  const shown = accountReady && agenda?.generation === contextGeneration ? agenda : null
  return {
    sourceGeneration: contextGeneration,
    status: remote === null ? { kind: 'disconnected' } : (shown?.status ?? { kind: 'loading' }),
    loading: !shown || loadingGeneration === contextGeneration,
    events: shown?.events ?? NO_EVENTS,
    calendars:
      accountReady && choices?.generation === contextGeneration ? choices.calendars : NO_CALENDARS,
    showRange,
    reload,
    setCalendarEnabled,
    patchLocal,
    create,
    update,
    remove,
  }
}
