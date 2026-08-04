/**
 * The agenda — Google Calendar, flattened into the shape the panel renders.
 *
 * Everything here is **read-only** (D67): Holi shows your day and lets you make
 * a task out of an event; it cannot create or move one. That is a scope
 * decision, not a politeness — `calendar.readonly` makes a write impossible
 * rather than merely undone.
 */
import type { GoogleApi } from './api'
import { fetchEventColors } from './event-colors'

const BASE = 'https://www.googleapis.com/calendar/v3'

/** The user's own answer to an invitation. */
export type RsvpStatus = 'needsAction' | 'tentative' | 'accepted' | 'declined'

/**
 * What kind of block this is.
 *
 * `workingLocation` is deliberately absent — Google writes one of those per
 * working day and they are a setting rather than an event, so they are filtered
 * out entirely rather than given a kind.
 */
export type EventKind = 'default' | 'outOfOffice' | 'focusTime' | 'birthday' | 'fromGmail'

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
  /**
   * From a calendar the user owns, rather than one they are subscribed to.
   *
   * On the row this is the difference between "I am in this meeting" and "Jane
   * is busy then" — and it is the same distinction the agent needs, which is
   * why it travels on the event rather than being recomputed per surface.
   */
  mine: boolean
  /** Google's own hex colour for the source calendar, or `null`. */
  color: string | null
  /** A video link, when the event has one. The single most-clicked thing on an
   *  agenda row, so it is lifted out rather than left buried in the payload. */
  meetLink?: string
  /**
   * The user's own RSVP, or `null` when they are not an attendee at all.
   *
   * The most valuable field on the row: `needsAction` is the one entry on an
   * agenda that is a *task* rather than a fact.
   */
  myResponse: RsvpStatus | null
  kind: EventKind
  /** `false` when Google says `transparency: 'transparent'` — it is on the
   *  calendar but does not claim the time. */
  busy: boolean
  /** Where the dial-in and the agenda live; also what makes a task made from an
   *  event worth more than its title. */
  description: string | null
  /** People, not rooms — a booked room is an `attendee` to Google. */
  attendeeCount: number
  organizer: string | null
  /** The conferenceData video entry point, falling back to `hangoutLink`.
   *  Meet, Zoom or Teams — `hangoutLink` alone is Meet-only. */
  conferenceUrl: string | null
  recurring: boolean
}

interface RawEvent {
  id?: string
  summary?: string
  status?: string
  htmlLink?: string
  location?: string
  hangoutLink?: string
  description?: string
  /** `default` | `outOfOffice` | `focusTime` | `birthday` | `fromGmail` |
   *  `workingLocation`. */
  eventType?: string
  /** `opaque` (blocks time, the default) | `transparent`. */
  transparency?: string
  /** An index into the palette `event-colors` fetches, not a colour. */
  colorId?: string
  /** Present on an instance of a recurring series; it is the series' id. */
  recurringEventId?: string
  organizer?: { displayName?: string; email?: string }
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  attendees?: {
    self?: boolean
    responseStatus?: string
    email?: string
    displayName?: string
    /** A meeting room or piece of equipment. Google lists it as an attendee;
     *  a human count must not. */
    resource?: boolean
  }[]
}

export interface CalendarListEntry {
  id: string
  summary: string
  /** The name *the user* gave this calendar. Google Calendar displays it in
   *  place of `summary`, and people rename a colleague's calendar precisely so
   *  it stops reading as that colleague's name. */
  summaryOverride?: string
  primary?: boolean
  selected?: boolean
  deleted?: boolean
  /** `owner` | `writer` | `reader` | `freeBusyReader`. What separates a calendar
   *  that is *yours* from one you merely watch. */
  accessRole?: string
  /** Google's own hex colour for the calendar, e.g. `#039be5`. */
  backgroundColor?: string
}

/** A calendar as the picker shows it, and as the agenda decides by. */
export interface CalendarChoice {
  id: string
  name: string
  /** Yours, rather than one you are subscribed to. Drives both the default and
   *  the attribution on every event it produces. */
  mine: boolean
  /** Google's hex colour, or `null` when the entry carries none. */
  color: string | null
  enabled: boolean
}

/** Per-calendar on/off, as the user has explicitly set it. Absent = the default
 *  rule applies. See `resolveCalendars`. */
export type CalendarOverrides = Record<string, boolean>

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

/** Yours to answer for, rather than a colleague's you happen to watch. Google
 *  gives write access to shared team calendars too, but `owner` is the line
 *  that matches "my day" — a calendar you can edit is not necessarily one whose
 *  events are yours. */
function isMine(calendar: CalendarListEntry): boolean {
  return calendar.primary === true || calendar.accessRole === 'owner'
}

/**
 * Every calendar the user could draw from, each with whether it is on.
 *
 * **The default is "calendars you own, and nothing else."** A Workspace account
 * accumulates subscriptions — colleagues whose calendars you compare against,
 * meeting rooms, birthdays — and Google's own `selected` flag says they are
 * visible *in Google Calendar*, where they sit in their own columns. Flattened
 * into one agenda they stop being comparable and start being noise, so Holi
 * starts from your own and lets you switch a colleague on deliberately.
 *
 * Overrides are stored **per calendar rather than as "the enabled set"**, which
 * is what makes a calendar created next month follow the rule instead of
 * arriving silently switched off because it was not in a list written today.
 */
export async function resolveCalendars(
  api: GoogleApi,
  overrides: CalendarOverrides,
): Promise<CalendarChoice[]> {
  const calendars = await listCalendars(api)
  return calendars.map((calendar) => ({
    id: calendar.id,
    name: calendar.summaryOverride ?? calendar.summary,
    mine: isMine(calendar),
    color: calendar.backgroundColor ?? null,
    enabled: overrides[calendar.id] ?? isMine(calendar),
  }))
}

/** The ids an agenda should actually fetch. */
export function enabledCalendarIds(calendars: CalendarChoice[]): string[] {
  return calendars.filter((c) => c.enabled).map((c) => c.id)
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
export async function listAgenda(
  api: GoogleApi,
  window: AgendaWindow,
  options: { overrides?: CalendarOverrides } = {},
): Promise<CalendarEvent[]> {
  // Filtered BEFORE fetching, not after: a calendar that is off costs no
  // request, which is what keeps a Workspace account's twenty subscriptions
  // from turning one agenda into twenty round-trips.
  const calendars = (await resolveCalendars(api, options.overrides ?? {})).filter((c) => c.enabled)

  // The palette runs *concurrently with* the events rather than before them: it
  // is one request, it cannot fail the agenda (it returns `{}` instead), and
  // awaiting it first would add its latency to every load for a tint.
  const [palette, perCalendar] = await Promise.all([
    fetchEventColors(api),
    Promise.all(
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
        return { calendar, raw: raw.filter(isWorthShowing) }
      }),
    ),
  ])

  // Merged across calendars, so per-calendar ordering is not enough.
  return perCalendar
    .flatMap(({ calendar, raw }) => raw.map((event) => toCalendarEvent(event, calendar, palette)))
    .sort(byStart)
}

/** Cancelled instances of a recurring series still come back (that is how a
 *  client learns they were cancelled), and an event the user declined is one
 *  they have already said they are not attending — neither belongs on an
 *  agenda that answers "what am I doing today". */
function isWorthShowing(event: RawEvent): boolean {
  if (event.status === 'cancelled') return false
  // Google writes a `workingLocation` entry for every working day. It is a
  // setting rendered as an event, and on a week's agenda it is half the rows.
  if (event.eventType === 'workingLocation') return false
  // Note the asymmetry with `needsAction`, which is deliberately kept: an
  // unanswered invitation is precisely what the agenda now wants to surface.
  return event.attendees?.some((a) => a.self === true && a.responseStatus === 'declined') !== true
}

const RSVP_STATUSES: readonly RsvpStatus[] = ['needsAction', 'tentative', 'accepted', 'declined']
const EVENT_KINDS: readonly EventKind[] = [
  'default',
  'outOfOffice',
  'focusTime',
  'birthday',
  'fromGmail',
]

/** Google's own value, or the safe default — never a string the UI has to
 *  switch on blindly. An unknown `eventType` reads as an ordinary event. */
function asKind(eventType: string | undefined): EventKind {
  return EVENT_KINDS.find((k) => k === eventType) ?? 'default'
}

function asRsvp(status: string | undefined): RsvpStatus | null {
  return RSVP_STATUSES.find((s) => s === status) ?? null
}

/** The video link, whoever hosts it. `hangoutLink` is Meet-only, so it is the
 *  fallback rather than the answer — a Zoom or Teams meeting has no hangoutLink
 *  at all and used to lose its join link entirely. */
function conferenceUrlOf(event: RawEvent): string | null {
  const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')
  return video?.uri ?? event.hangoutLink ?? null
}

function toCalendarEvent(
  event: RawEvent,
  calendar: CalendarChoice,
  palette: Record<string, string>,
): CalendarEvent {
  const allDay = event.start?.date !== undefined
  const attendees = event.attendees ?? []
  const organizer = event.organizer?.displayName ?? event.organizer?.email ?? null
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
    calendarName: calendar.name,
    mine: calendar.mine,
    // A per-event colour is how people mark the one thing that matters in a day
    // of identical blocks; it wins over the calendar's own.
    color: (event.colorId !== undefined ? palette[event.colorId] : undefined) ?? calendar.color,
    meetLink: event.hangoutLink,
    myResponse: asRsvp(attendees.find((a) => a.self === true)?.responseStatus),
    kind: asKind(event.eventType),
    busy: event.transparency !== 'transparent',
    description: event.description ?? null,
    // Rooms and equipment are attendees to Google; "2 people" for a solo
    // meeting in a booked room is a lie the count would tell constantly.
    attendeeCount: attendees.filter((a) => a.resource !== true).length,
    organizer,
    conferenceUrl: conferenceUrlOf(event),
    recurring: event.recurringEventId !== undefined,
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
