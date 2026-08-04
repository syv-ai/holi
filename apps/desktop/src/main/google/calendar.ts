/**
 * The agenda — Google Calendar, flattened into the shape the panel renders.
 *
 * Everything here is **read-only** (D67): Holi shows your day and lets you make
 * a task out of an event; it cannot create or move one. That is a scope
 * decision, not a politeness — `calendar.readonly` makes a write impossible
 * rather than merely undone.
 */
import type { GoogleApi } from './api'

const BASE = 'https://www.googleapis.com/calendar/v3'

export interface CalendarEvent {
  id: string
  title: string
  /**
   * ISO 8601. A timed event carries a full instant; an **all-day** event
   * carries `YYYY-MM-DD` and no timezone, which is why `allDay` exists rather
   * than being inferred from the string's shape at every call site.
   */
  start: string
  end: string
  allDay: boolean
  location?: string
  /**
   * Google's own permalink for the event — **the link Holi writes into a task
   * or note** (D67). Taken from the API rather than assembled from the id: the
   * id alone is not enough to build a working URL, and a hand-built one breaks
   * across accounts.
   */
  htmlLink: string
  /** Which calendar it came from; an agenda merges several. */
  calendarId: string
  calendarName: string
  /** A video link, when the event has one. The single most-clicked thing on an
   *  agenda row, so it is lifted out rather than left buried in the payload. */
  meetLink?: string
}

interface RawEvent {
  id?: string
  summary?: string
  status?: string
  htmlLink?: string
  location?: string
  hangoutLink?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  attendees?: { self?: boolean; responseStatus?: string }[]
}

export interface CalendarListEntry {
  id: string
  summary: string
  primary?: boolean
  selected?: boolean
  deleted?: boolean
}

/**
 * The calendars an agenda should draw from.
 *
 * **`selected` is honoured** — it is the checkbox state in the user's own
 * Google Calendar UI, so respecting it means Holi shows the same set they
 * already curated, instead of every calendar they have ever been added to
 * (which for a Workspace account includes rooms, birthdays, and every
 * colleague's calendar they once peeked at).
 */
export async function listCalendars(api: GoogleApi): Promise<CalendarListEntry[]> {
  const items = await api.getAll<CalendarListEntry>(
    `${BASE}/users/me/calendarList`,
    { minAccessRole: 'reader', showDeleted: 'false' },
    (page) => page.items ?? [],
  )
  return items.filter((c) => c.deleted !== true && c.selected !== false)
}

export interface AgendaWindow {
  /** ISO instants. The caller owns "today" — main never computes it, because
   *  the machine's local date is the renderer's fact (the daily-notes rule). */
  timeMin: string
  timeMax: string
}

/**
 * Every event in the window, across the user's selected calendars, in start
 * order.
 *
 * **`singleEvents=true` is load-bearing.** Without it a weekly stand-up comes
 * back once, as a recurrence *rule* with the series' original start date — so
 * an agenda built on the raw response shows today's meetings as whatever day
 * the series began. With it, Google expands the rule into the instances that
 * actually fall in the window, which is the only thing an agenda can render.
 */
export async function listAgenda(api: GoogleApi, window: AgendaWindow): Promise<CalendarEvent[]> {
  const calendars = await listCalendars(api)

  const perCalendar = await Promise.all(
    calendars.map(async (calendar) => {
      const raw = await api.getAll<RawEvent>(
        `${BASE}/calendars/${encodeURIComponent(calendar.id)}/events`,
        {
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '250',
        },
        (page) => page.items ?? [],
      )
      return raw.filter(isWorthShowing).map((event) => toCalendarEvent(event, calendar))
    }),
  )

  // Merged across calendars, so per-calendar ordering is not enough.
  return perCalendar.flat().sort(byStart)
}

/** Cancelled instances of a recurring series still come back (that is how a
 *  client learns they were cancelled), and an event the user declined is one
 *  they have already said they are not attending — neither belongs on an
 *  agenda that answers "what am I doing today". */
function isWorthShowing(event: RawEvent): boolean {
  if (event.status === 'cancelled') return false
  return event.attendees?.some((a) => a.self === true && a.responseStatus === 'declined') !== true
}

function toCalendarEvent(event: RawEvent, calendar: CalendarListEntry): CalendarEvent {
  const allDay = event.start?.date !== undefined
  return {
    id: event.id ?? '',
    // An untitled event is a real thing Google returns; the calendar UI shows
    // it the same way rather than an empty row.
    title: event.summary?.trim() || '(no title)',
    start: event.start?.dateTime ?? event.start?.date ?? '',
    end: event.end?.dateTime ?? event.end?.date ?? '',
    allDay,
    location: event.location,
    htmlLink: event.htmlLink ?? '',
    calendarId: calendar.id,
    calendarName: calendar.summary,
    meetLink: event.hangoutLink,
  }
}

/**
 * All-day events sort before timed ones on the same date.
 *
 * An all-day `start` is `YYYY-MM-DD`, which compares *less than* any
 * `YYYY-MM-DDTHH:MM` for the same day under plain string comparison — so the
 * desired order falls out of comparing the raw strings, but only because the
 * dates share a prefix. Anything else needs a real instant.
 */
function byStart(a: CalendarEvent, b: CalendarEvent): number {
  if (a.allDay !== b.allDay) {
    const sameDay = a.start.slice(0, 10) === b.start.slice(0, 10)
    if (sameDay) return a.allDay ? -1 : 1
  }
  const ta = a.allDay ? Date.parse(`${a.start}T00:00:00`) : Date.parse(a.start)
  const tb = b.allDay ? Date.parse(`${b.start}T00:00:00`) : Date.parse(b.start)
  return ta - tb || a.title.localeCompare(b.title)
}
