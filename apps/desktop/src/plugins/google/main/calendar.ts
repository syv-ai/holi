/**
 * The agenda: Google Calendar, flattened into the shape the panel renders, plus
 * the agent's attendee-free calendar writes at the bottom, and answering an
 * invitation, the one that tells somebody.
 */
import { createHash } from 'node:crypto'
import { fenceUntrusted } from '@holi/shared'
import { GoogleApiError, type GoogleApi, type GoogleParams } from './api'
import { fetchEventColors } from './event-colors'
import type { parseMailInvitation } from './mail-invitation'
import {
  conferenceUrlIn,
  googleEventUrl,
  httpsLink,
  providerConferenceUrl,
} from '../shared/meeting-links'

const BASE = 'https://www.googleapis.com/calendar/v3'

/** The user's own answer to an invitation. */
type RsvpStatus = 'needsAction' | 'tentative' | 'accepted' | 'declined'

/**
 * What kind of block this is.
 *
 * `workingLocation` is deliberately absent: Google writes one of those per
 * working day and they are a setting rather than an event, so they are filtered
 * out entirely.
 */
type EventKind = 'default' | 'outOfOffice' | 'focusTime' | 'birthday' | 'fromGmail'

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
   * Google's own permalink for the event: **the link Holi writes into a task
   * or note**. Taken from the API rather than assembled from the id,
   * which is not enough to build a working URL.
   */
  htmlLink: string
  /** Which calendar it came from; an agenda merges several. */
  calendarId: string
  calendarName: string
  /**
   * From a calendar the user owns, rather than one they are subscribed to.
   *
   * "I am in this meeting" versus "Jane is busy then". The agent needs the same
   * distinction, so it travels on the event rather than being recomputed.
   */
  mine: boolean
  /** Google's own hex colour for the source calendar, or `null`. */
  color: string | null
  /** Meet's `hangoutLink`, when the event has one. */
  meetLink?: string
  /**
   * The user's own RSVP, or `null` when they are not an attendee at all.
   *
   * `needsAction` is the one entry on an agenda that is a *task* rather than a
   * fact.
   */
  myResponse: RsvpStatus | null
  kind: EventKind
  /** `false` when Google says `transparency: 'transparent'`: it is on the
   *  calendar but does not claim the time. */
  busy: boolean
  description: string | null
  /** People, not rooms: a booked room is an `attendee` to Google. */
  attendeeCount: number
  /** The organizer's display name, or their address when Google has none. */
  organizer: string | null
  /** The organizer's address, or `null`. */
  organizerEmail: string | null
  /** Meet, Zoom or Teams. `conferenceData`'s video entry point, then
   *  `hangoutLink` (Meet-only), then a join link recognised in the invite's own
   *  body. See `conferenceUrlOf` for why the third is needed. */
  conferenceUrl: string | null
  recurring: boolean
}

interface RawEvent {
  kind?: string
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
  organizer?: { displayName?: string; email?: string; self?: boolean }
  iCalUID?: string
  etag?: string
  sequence?: number
  recurrence?: string[]
  originalStartTime?: RawEvent['start']
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

interface CalendarListEntry {
  kind?: string
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
  /** Google's declared primary calendar, used to resolve the documented `primary` alias. */
  primary: boolean
}

/** Per-calendar on/off, as the user has explicitly set it. Absent = the default
 *  rule applies. See `resolveCalendars`. */
export type CalendarOverrides = Record<string, boolean>

/**
 * The calendars an agenda should draw from.
 *
 * **`selected` is honoured**: it is the checkbox state in the user's own
 * Google Calendar UI, so Holi starts from the set they already curated rather
 * than every calendar they have ever been added to.
 * @public exported for its test
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
 *  that matches "my day": a calendar you can edit is not necessarily one whose
 *  events are yours. */
function isMine(calendar: CalendarListEntry): boolean {
  return calendar.primary === true || calendar.accessRole === 'owner'
}

/**
 * Every calendar the user could draw from, each with whether it is on.
 *
 * **The default is "calendars you own, and nothing else."** A Workspace account
 * accumulates subscriptions (colleagues, rooms, birthdays) that sit in their own
 * columns in Google Calendar; flattened into one agenda they are noise, so Holi
 * starts from your own and lets you switch a colleague on deliberately.
 *
 * Overrides are stored **per calendar rather than as "the enabled set"**, so a
 * calendar created next month follows the rule instead of arriving silently
 * switched off.
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
    primary: calendar.primary === true,
  }))
}

export interface AgendaWindow {
  /** ISO instants. The caller owns "today": main never computes it, because
   *  the machine's local date is the renderer's fact (the daily-notes rule). */
  timeMin: string
  timeMax: string
}

/**
 * Every event in the window, across the user's selected calendars, in start
 * order.
 *
 * **`singleEvents=true` is load-bearing.** Without it a weekly stand-up comes
 * back once, as a recurrence *rule* with the series' original start date. With
 * it, Google expands the rule into the instances that fall in the window.
 */
export async function listAgenda(
  api: GoogleApi,
  window: AgendaWindow,
  options: { overrides?: CalendarOverrides } = {},
): Promise<CalendarEvent[]> {
  // Filtered BEFORE fetching, not after: a calendar that is off costs no
  // request.
  const calendars = (await resolveCalendars(api, options.overrides ?? {})).filter((c) => c.enabled)

  // The palette runs *concurrently with* the events: it cannot fail the agenda
  // (it returns `{}` instead), and awaiting it first would add its latency.
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

type InvitationCalendarCopy = {
  kind: 'verified'
  target: string
  etag: string | null
  proof: string
  revision: Parsed['details']['identity']
  title?: string
  start?: string
  end?: string
  allDay: boolean
  location?: string
  conferenceUrl: string | null
  conferenceLinkSource: 'calendar' | 'provider' | null
  htmlLink: string | null
  responseStatus: RsvpStatus | null
  cancelled: boolean
  unavailableReason: string | null
  reply: ((answer: InviteAnswer, gate: InvitationDispatchGate) => Promise<void>) | null
}

type CalendarLookup =
  InvitationCalendarCopy | { kind: 'absent' } | { kind: 'blocked'; reason: string }

type InvitationDispatchGate = {
  validate: () => Promise<void>
  reserveDispatch: () => Promise<void>
}

type Parsed = NonNullable<ReturnType<typeof parseMailInvitation>>
type InvitationTarget = {
  details: Parsed['details']
  request: NonNullable<Parsed['request']>
  joinOnly: boolean
}

async function invitationPages<T>(
  api: GoogleApi,
  url: string,
  kind: 'calendar#events' | 'calendar#calendarList',
  params: GoogleParams,
): Promise<T[]> {
  return api.getAll<T>(
    url,
    params,
    (page) => {
      if (
        !page ||
        typeof page !== 'object' ||
        Array.isArray(page) ||
        !('kind' in page) ||
        page.kind !== kind ||
        (page.items !== undefined &&
          (!Array.isArray(page.items) ||
            page.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))) ||
        (page.nextPageToken !== undefined &&
          (typeof page.nextPageToken !== 'string' ||
            !/^[^\s\p{Cc}]{1,4096}$/u.test(page.nextPageToken)))
      )
        throw new Error('Invalid Calendar collection')
      return page.items ?? []
    },
    10,
    true,
  )
}

function instant(value: string): number {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN
}

function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}

function validTime(value: RawEvent['start']): boolean {
  return Boolean(
    value &&
    ((date(value.date) && value.dateTime === undefined) ||
      (value.date === undefined &&
        typeof value.dateTime === 'string' &&
        Number.isFinite(instant(value.dateTime)))),
  )
}

function sameOccurrence(event: RawEvent, recurrenceId: string): boolean {
  const original = event.originalStartTime
  if (!original) return false
  if (original.date !== undefined) return original.date === recurrenceId
  return original.dateTime !== undefined && instant(original.dateTime) === instant(recurrenceId)
}

async function exactCopies(
  api: GoogleApi,
  url: string,
  uid: string,
  recurrenceId: string | null,
): Promise<RawEvent[]> {
  const events = await invitationPages<RawEvent>(api, url, 'calendar#events', {
    iCalUID: uid,
    singleEvents: 'false',
    showDeleted: 'true',
  })
  if (
    events.some(
      (event) =>
        !usableInvitationEvent(event) ||
        (event.iCalUID !== uid && !(event.iCalUID === undefined && event.status === 'cancelled')),
    )
  ) {
    throw new Error('Invalid Calendar events for this invitation')
  }
  // The unexpanded list contains the series master and sometimes exception
  // rows. No recurrence ID means the master, not any expanded occurrence.
  const roots = events.filter((event) => !event.recurringEventId && !event.originalStartTime)
  if (new Set(events.map(({ id }) => id)).size !== events.length)
    throw new Error('Calendar returned duplicate event rows')
  if (recurrenceId === null) return roots
  if (roots.length > 1) throw new Error('Calendar returned ambiguous series rows')
  const matching = new Map(
    events.filter((event) => sameOccurrence(event, recurrenceId)).map((event) => [event.id, event]),
  )
  for (const series of roots) {
    if (!series.id || !series.recurrence?.length || series.status === 'cancelled') continue
    // Unmodified instances do not appear in events.list. Query for the original
    // start (not timeMin or the displayed start, which miss moved occurrences).
    const instances = await invitationPages<RawEvent>(
      api,
      `${url}/${encodeURIComponent(series.id)}/instances`,
      'calendar#events',
      {
        originalStart: recurrenceId,
        showDeleted: 'true',
      },
    )
    if (new Set(instances.map(({ id }) => id)).size !== instances.length)
      throw new Error('Calendar returned duplicate instance rows')
    for (const event of instances) {
      if (
        !usableInvitationEvent(event) ||
        (event.iCalUID !== undefined && event.iCalUID !== uid) ||
        event.recurringEventId !== series.id ||
        !sameOccurrence(event, recurrenceId)
      ) {
        throw new Error('Invalid Calendar instance for this invitation')
      }
      const listed = matching.get(event.id)
      if (listed && (listed.etag !== event.etag || calendarProof(listed) !== calendarProof(event)))
        throw new Error('Calendar returned conflicting instance rows')
      matching.set(event.id, event)
    }
  }
  // A cancelled series suppresses every occurrence even if Google no longer
  // returns its instances. Never use the series itself as a write target.
  return matching.size
    ? [...matching.values()]
    : roots.filter((root) => root.status === 'cancelled')
}

function usableInvitationEvent(event: RawEvent): boolean {
  const original = event.originalStartTime
  return (
    (event.kind === undefined || event.kind === 'calendar#event') &&
    typeof event.id === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(event.id) &&
    (event.status === undefined ||
      ['confirmed', 'tentative', 'cancelled'].includes(event.status)) &&
    (event.sequence === undefined ||
      (Number.isSafeInteger(event.sequence) && event.sequence >= 0)) &&
    (event.recurrence === undefined ||
      (Array.isArray(event.recurrence) &&
        event.recurrence.every((rule) => typeof rule === 'string'))) &&
    (event.recurringEventId === undefined
      ? original === undefined
      : typeof event.recurringEventId === 'string' &&
        Boolean(event.recurringEventId) &&
        validTime(original)) &&
    (event.start === undefined || validTime(event.start)) &&
    (event.end === undefined || validTime(event.end)) &&
    (event.organizer === undefined ||
      (event.organizer &&
        typeof event.organizer === 'object' &&
        !Array.isArray(event.organizer) &&
        (event.organizer.email === undefined || typeof event.organizer.email === 'string') &&
        (event.organizer.self === undefined || typeof event.organizer.self === 'boolean'))) &&
    (event.attendees === undefined ||
      (Array.isArray(event.attendees) &&
        event.attendees.every(
          (attendee) =>
            attendee &&
            typeof attendee === 'object' &&
            !Array.isArray(attendee) &&
            (attendee.email === undefined || typeof attendee.email === 'string') &&
            (attendee.self === undefined || typeof attendee.self === 'boolean') &&
            (attendee.resource === undefined || typeof attendee.resource === 'boolean') &&
            (attendee.responseStatus === undefined || asRsvp(attendee.responseStatus) !== null),
        ))) &&
    [
      event.summary,
      event.description,
      event.location,
      event.htmlLink,
      event.hangoutLink,
      event.etag,
    ].every((value) => value === undefined || typeof value === 'string') &&
    (event.conferenceData === undefined ||
      Boolean(
        event.conferenceData &&
        typeof event.conferenceData === 'object' &&
        !Array.isArray(event.conferenceData) &&
        (event.conferenceData.entryPoints === undefined ||
          (Array.isArray(event.conferenceData.entryPoints) &&
            event.conferenceData.entryPoints.every(
              (point) =>
                point &&
                typeof point === 'object' &&
                !Array.isArray(point) &&
                (point.entryPointType === undefined || typeof point.entryPointType === 'string') &&
                (point.uri === undefined || typeof point.uri === 'string'),
            ))),
      ))
  )
}

/** RSVP lookup is independent of agenda visibility, dates and RSVP state. */
export async function findInvitationCalendarCopy(
  api: GoogleApi,
  invitation: InvitationTarget,
  mailbox: string,
): Promise<CalendarLookup> {
  try {
    return await lookupInvitationCalendarCopy(api, invitation, mailbox)
  } catch (error) {
    // Neither a 404 nor incomplete/malformed results prove there is no copy.
    if (error instanceof GoogleApiError && [401, 403, 429].includes(error.status)) throw error
    return {
      kind: 'blocked',
      reason: 'Calendar could not verify whether it has a copy of this invitation',
    }
  }
}

async function lookupInvitationCalendarCopy(
  api: GoogleApi,
  invitation: InvitationTarget,
  mailbox: string,
): Promise<CalendarLookup> {
  const { uid, recurrenceId } = invitation.details.identity
  if (
    recurrenceId !== null &&
    invitation.request.recurrenceKind !== 'date' &&
    invitation.request.recurrenceKind !== 'instant'
  )
    return { kind: 'blocked', reason: 'Calendar cannot verify a floating occurrence' }
  const primary = await exactCopies(api, PRIMARY_EVENTS, uid, recurrenceId)
  const ambiguous = {
    kind: 'blocked',
    reason: 'More than one Calendar event matches this invitation',
  } as const
  if (primary.length > 1) return ambiguous
  if (primary[0]) return invitationCopy(api, PRIMARY_EVENTS, primary[0], invitation, mailbox, true)

  const calendars = await invitationPages<CalendarListEntry>(
    api,
    `${BASE}/users/me/calendarList`,
    'calendar#calendarList',
    {
      minAccessRole: 'reader',
      showDeleted: 'false',
      showHidden: 'true',
    },
  )
  let match: CalendarLookup | undefined
  const seen = new Set<string>()
  for (const calendar of calendars) {
    if (
      (calendar.kind !== undefined && calendar.kind !== 'calendar#calendarListEntry') ||
      typeof calendar.id !== 'string' ||
      !/^[^\s\p{Cc}/?#]+$/u.test(calendar.id) ||
      seen.has(calendar.id) ||
      (calendar.primary !== undefined && typeof calendar.primary !== 'boolean') ||
      (calendar.deleted !== undefined && typeof calendar.deleted !== 'boolean') ||
      (!calendar.deleted &&
        !['owner', 'writer', 'reader', 'freeBusyReader'].includes(calendar.accessRole ?? ''))
    ) {
      throw new Error('Invalid Calendar list entry')
    }
    seen.add(calendar.id)
    if (calendar.primary || calendar.deleted || calendar.accessRole === 'freeBusyReader') continue
    const url = `${BASE}/calendars/${encodeURIComponent(calendar.id)}/events`
    const events = await exactCopies(api, url, uid, recurrenceId)
    if (events.length > 1 || (events.length && match)) return ambiguous
    if (events[0]) {
      match = invitationCopy(
        api,
        url,
        events[0],
        invitation,
        mailbox,
        calendar.accessRole === 'owner' || calendar.accessRole === 'writer',
        calendar.accessRole === 'owner' ? calendar.id.toLowerCase() : undefined,
        calendar.accessRole === 'owner',
      )
    }
  }
  return match ?? { kind: 'absent' }
}

function invitationCopy(
  api: GoogleApi,
  base: string,
  event: RawEvent,
  invitation: InvitationTarget,
  mailbox: string,
  writable: boolean,
  ownedCalendar?: string,
  owned = base === PRIMARY_EVENTS,
): CalendarLookup {
  const self = event.attendees?.filter((attendee) => attendee.self === true) ?? []
  const selfEmail = self[0]?.email?.toLowerCase()
  // Calendar's `self` denotes the calendar copy, not necessarily the mailbox.
  // An owned secondary calendar is ours; a shared writer may not RSVP as its owner.
  const attendee =
    self.length === 1 && selfEmail && (selfEmail === mailbox || selfEmail === ownedCalendar)
      ? self[0]
      : undefined
  const organizer = event.organizer?.email?.toLowerCase()
  const { details, request, joinOnly } = invitation
  const { sequence, recurrenceId } = details.identity
  const blocked = (reason: string): CalendarLookup => ({ kind: 'blocked', reason })
  const cancelled = event.status === 'cancelled'
  if (cancelled && (joinOnly || !attendee || organizer !== details.organizer?.email))
    return blocked('This Calendar event was cancelled')
  if (organizer !== details.organizer?.email)
    return blocked('The Calendar organizer does not match this invitation')
  const organizes =
    event.organizer?.self === true && (organizer === mailbox || organizer === ownedCalendar)
  if (
    joinOnly
      ? !owned || (!organizes && (!attendee || attendee.resource))
      : !attendee || attendee.resource
  )
    return blocked('This account cannot verify its place on this Calendar event')
  if (!joinOnly && (event.organizer?.self || organizer === mailbox || organizer === ownedCalendar))
    return blocked('You organize this event')
  if ((event.sequence ?? 0) !== sequence)
    return blocked(
      (event.sequence ?? 0) > sequence
        ? 'Calendar has a newer revision of this event'
        : 'Calendar has not received this revision of the invitation yet',
    )
  if (recurrenceId === null && Boolean(event.recurrence?.length) !== details.recurring)
    return blocked('The Calendar recurrence scope does not match this invitation')
  const { explicitFields } = request
  const start = event.start?.date ?? event.start?.dateTime
  const end = event.end?.date ?? event.end?.dateTime
  const allDay = event.start?.date !== undefined
  const { url: conferenceUrl, source: conferenceLinkSource } = mailConference(event)
  const calendarConference = httpsLink(structuredConference(event)) ?? conferenceUrl
  const htmlLink = googleEventUrl(event.htmlLink)
  const calendarPageInMail = googleEventUrl(details.htmlLink)
  const timeMatches = (mail: string | null, calendar: string) =>
    mail !== null && (details.allDay ? mail === calendar : instant(mail) === instant(calendar))
  const words = (value: string | null | undefined) =>
    value?.normalize('NFC').trim().replace(/\r\n/g, '\n') ?? ''
  if (
    (explicitFields.title &&
      event.summary !== undefined &&
      words(event.summary) !== words(details.title)) ||
    ((joinOnly || explicitFields.start) &&
      start !== undefined &&
      !timeMatches(details.start, start)) ||
    ((joinOnly || explicitFields.end) && end !== undefined && !timeMatches(details.end, end)) ||
    (explicitFields.location &&
      event.location !== undefined &&
      words(event.location) !== words(details.location)) ||
    (explicitFields.conferenceUrl &&
      details.conferenceUrl &&
      calendarConference &&
      details.conferenceUrl !== calendarConference) ||
    (explicitFields.htmlLink && calendarPageInMail && htmlLink && calendarPageInMail !== htmlLink)
  )
    return blocked('The Calendar details do not match this revision of the invitation')
  if (joinOnly && (!start || !end || !explicitFields.start))
    return blocked('Calendar could not verify the time of this meeting')
  const etag = event.etag || null
  const reason = cancelled
    ? 'This Calendar event was cancelled'
    : joinOnly
      ? null
      : !etag || !writable
        ? 'This Calendar copy cannot be edited'
        : null
  const url = `${base}/${encodeURIComponent(event.id ?? '')}?sendUpdates=all`
  return {
    kind: 'verified',
    target: JSON.stringify([url, selfEmail ?? organizer]),
    etag,
    proof: calendarProof(event),
    revision: details.identity,
    title: event.summary,
    start,
    end,
    allDay,
    location: event.location,
    conferenceUrl,
    conferenceLinkSource,
    htmlLink,
    responseStatus: joinOnly || cancelled ? null : asRsvp(attendee?.responseStatus),
    cancelled,
    unavailableReason: reason,
    reply:
      !joinOnly && reason === null && etag
        ? (answer, gate) =>
            api.patch(
              url,
              { attendeesOmitted: true, attendees: [{ ...attendee, responseStatus: answer }] },
              { ...gate, ifMatch: etag },
            )
        : null,
  }
}

function mailConference(event: RawEvent) {
  const structured = providerConferenceUrl(structuredConference(event))
  if (structured) return { url: structured, source: 'calendar' as const }
  const prose = conferenceUrlIn(event.description) ?? conferenceUrlIn(event.location)
  return { url: prose, source: prose ? ('provider' as const) : null }
}

function calendarProof(event: RawEvent): string {
  const when = (time: RawEvent['start']) =>
    time?.date ?? (time?.dateTime ? instant(time.dateTime) : null)
  // Ignore RSVP and ETag changes, but never mistake a different revision at the
  // same resource URL for confirmation of an earlier write.
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.id,
        event.iCalUID,
        event.sequence ?? 0,
        event.recurringEventId,
        when(event.originalStartTime),
        event.recurrence,
        event.organizer?.email?.toLowerCase(),
        event.summary,
        when(event.start),
        when(event.end),
        event.location,
        httpsLink(structuredConference(event)) ?? mailConference(event).url,
        googleEventUrl(event.htmlLink),
      ]),
    )
    .digest('hex')
}

/** Only a read of the original identity can reconcile a superseded Calendar
 * attempt. Deletion or a newer event at the original URL is not a refusal. */
export async function verifyInvitationCalendarResponse(
  api: GoogleApi,
  target: string,
  proof: string,
  answer: InviteAnswer,
): Promise<boolean> {
  const binding: unknown = JSON.parse(target)
  if (!Array.isArray(binding) || binding.length !== 2) return false
  const [url, mailbox] = binding as unknown[]
  if (
    typeof url !== 'string' ||
    typeof mailbox !== 'string' ||
    !/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/[^/?#]+\/events\/[\w-]+\?sendUpdates=all$/.test(
      url,
    )
  )
    return false
  const event = await api.get<RawEvent>(url.split('?')[0]!)
  if (
    !event ||
    !usableInvitationEvent(event) ||
    event.status === 'cancelled' ||
    event.organizer?.self ||
    calendarProof(event) !== proof
  )
    return false
  const self = event.attendees?.filter((attendee) => attendee.self === true) ?? []
  return (
    self.length === 1 &&
    !self[0]?.resource &&
    self[0]?.email?.toLowerCase() === mailbox &&
    self[0]?.responseStatus === answer
  )
}

/** Cancelled instances of a recurring series still come back (that is how a
 *  client learns they were cancelled), and an event the user declined is one
 *  they have already said they are not attending. */
function isWorthShowing(event: RawEvent): boolean {
  if (event.status === 'cancelled') return false
  // Google writes a `workingLocation` entry for every working day. It is a
  // setting rendered as an event, and on a week's agenda it is half the rows.
  if (event.eventType === 'workingLocation') return false
  // `needsAction` is deliberately kept: an unanswered invitation is what the
  // agenda wants to surface.
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

/** Google's own value, or the safe default, never a string the UI has to
 *  switch on blindly. An unknown `eventType` reads as an ordinary event. */
function asKind(eventType: string | undefined): EventKind {
  return EVENT_KINDS.find((k) => k === eventType) ?? 'default'
}

function asRsvp(status: string | undefined): RsvpStatus | null {
  return RSVP_STATUSES.find((s) => s === status) ?? null
}

function structuredConference(event: RawEvent): string | undefined {
  return (
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ??
    event.hangoutLink
  )
}

function conferenceUrlOf(event: RawEvent): string | null {
  return (
    structuredConference(event) ??
    conferenceUrlIn(event.description) ??
    conferenceUrlIn(event.location)
  )
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
    // Rooms and equipment are attendees to Google.
    attendeeCount: attendees.filter((a) => a.resource !== true).length,
    organizer,
    organizerEmail: event.organizer?.email ?? null,
    conferenceUrl: conferenceUrlOf(event),
    recurring: event.recurringEventId !== undefined,
  }
}

/**
 * All-day events sort before timed ones on the same date.
 *
 * An all-day `start` is `YYYY-MM-DD`, which compares *less than* any
 * `YYYY-MM-DDTHH:MM` for the same day under plain string comparison, so the
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

/**
 * Calendar writes: the agent's time-blocking surface.
 *
 * **Every function here is bounded by one rule: it must not email anyone.**
 * An event carrying attendees sends invitations on create and cancellations on
 * delete, which makes it the calendar's version of `send`. `respondToEvent`,
 * last, is the one exception, and the send gate asks before it runs.
 *
 * The bound is enforced here rather than in `SKILL.md` on purpose: the agent is
 * the thing being bounded, so a rule it can read and reason about is not a
 * bound. `NewEvent` has no `attendees` field at all, which handles creation;
 * `updateEvent` and `deleteEvent` read the event first.
 *
 * Writes target `primary` only. A subscribed calendar is someone else's.
 */
const PRIMARY_EVENTS = `${BASE}/calendars/primary/events`

/**
 * `sendUpdates=none` on every write, belt-and-braces with the attendee refusal.
 *
 * The refusal is the real wall; this is the second one, for the case where an
 * event acquires attendees between the read and the write.
 */
const NO_MAIL = 'sendUpdates=none'

export interface NewEvent {
  title: string
  /** ISO instant, or `YYYY-MM-DD` when `allDay`. */
  start: string
  end: string
  allDay?: boolean
  location?: string
  description?: string
}

export interface EventPatch {
  title?: string
  start?: string
  end?: string
  allDay?: boolean
}

/**
 * An all-day event uses `date`; a timed one uses `dateTime` **and** a
 * `timeZone`.
 *
 * Sending `dateTime` for an all-day event does not fail. It creates a
 * midnight-to-midnight timed block, which reads correctly in an agenda list and
 * is visibly wrong in a day view.
 */
function endpoint(value: string, allDay: boolean): Record<string, string> {
  if (allDay) return { date: value }
  return {
    dateTime: value,
    // The machine's zone. Google requires one alongside `dateTime`, and the
    // instant is already absolute, so this only decides how it is displayed.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

/** The event as Google holds it, for the one field this module asks about. */
interface RawAttendees {
  attendees?: unknown[]
  summary?: string
}

/** An event as a refusal names it. The title is the organizer's words, so it
 *  is fenced like everything else `holi google` prints. */
const eventName = (id: string, summary: string | undefined): string =>
  summary === undefined || summary === ''
    ? `Event ${id}`
    : `Event ${id} (${fenceUntrusted(summary, 'calendar')})`

/**
 * Refuse anything that would put mail in someone's inbox.
 *
 * An empty `attendees` array is *not* attendees: Google returns one on some
 * solo events, and refusing those would leave the agent unable to move its own
 * blocks.
 */
async function assertNobodyIsInvited(api: GoogleApi, eventId: string): Promise<void> {
  const event = await api.get<RawAttendees>(`${PRIMARY_EVENTS}/${encodeURIComponent(eventId)}`)
  if (Array.isArray(event.attendees) && event.attendees.length > 0) {
    // Read by the agent, so it says what to do instead rather than only what
    // went wrong.
    throw new Error(
      `${eventName(eventId, event.summary)} has attendees, so changing it would email them. ` +
        'Holi does not let me do that: ask the user to make this change in Google Calendar.',
    )
  }
}

/** Create a solo event. `NewEvent` has no `attendees` field: the type is the
 *  first wall, and there is no way to express an invitation here. */
export async function createEvent(api: GoogleApi, event: NewEvent): Promise<{ id: string | null }> {
  const created = await api.postJson<{ id?: string }>(`${PRIMARY_EVENTS}?${NO_MAIL}`, {
    summary: event.title,
    start: endpoint(event.start, event.allDay === true),
    end: endpoint(event.end, event.allDay === true),
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.description === undefined ? {} : { description: event.description }),
  })
  return { id: created?.id ?? null }
}

/**
 * Move or retitle an event. Refuses if anyone is invited.
 *
 * A `PATCH`, so fields the caller did not mention keep their values: an
 * `update` would blank the description of every event the agent moved.
 */
export async function updateEvent(api: GoogleApi, id: string, patch: EventPatch): Promise<void> {
  await assertNobodyIsInvited(api, id)
  await api.patch(`${PRIMARY_EVENTS}/${encodeURIComponent(id)}?${NO_MAIL}`, {
    ...(patch.title === undefined ? {} : { summary: patch.title }),
    ...(patch.start === undefined ? {} : { start: endpoint(patch.start, patch.allDay === true) }),
    ...(patch.end === undefined ? {} : { end: endpoint(patch.end, patch.allDay === true) }),
  })
}

/** Delete an event. Refuses if anyone is invited: a delete would email them a
 *  cancellation, which is not something the agent may do on its own. */
export async function deleteEvent(api: GoogleApi, id: string): Promise<void> {
  await assertNobodyIsInvited(api, id)
  await api.del(`${PRIMARY_EVENTS}/${encodeURIComponent(id)}?${NO_MAIL}`)
}

/** What `holi google respond` answers an invitation with. */
export type InviteAnswer = 'accepted' | 'declined' | 'tentative'

/** The event as Google holds it, for answering it. */
interface RawInvite {
  summary?: string
  organizer?: { self?: boolean }
  attendees?: Record<string, unknown>[]
}

/**
 * Answer an invitation: the one calendar write here that reaches another
 * person, since Google tells the organizer (`sendUpdates=all`). The agent's
 * send gate asks the person before the command runs.
 *
 * Only the person's own attendee entry is sent, with `attendeesOmitted`, which
 * is how Calendar takes "update just my answer": a `PATCH` replaces the whole
 * `attendees` array, and sending everyone else's entries back would rewrite
 * them with whatever this read saw. The entry is copied, so a field Holi does
 * not know about (`additionalGuests`, an old comment kept when no new one is
 * given) survives. Refused when the person is not invited, and when they
 * organise it: an organizer's change to the attendee list mails every guest.
 */
export async function respondToEvent(
  api: GoogleApi,
  id: string,
  answer: InviteAnswer,
  comment?: string,
): Promise<void> {
  const url = `${PRIMARY_EVENTS}/${encodeURIComponent(id)}`
  const event = await api.get<RawInvite>(url)
  if (event.organizer?.self === true) {
    throw new Error(
      `${eventName(id, event.summary)} is one the user organises, so there is no invitation ` +
        'to answer. Ask the user to change it in Google Calendar.',
    )
  }
  const self = (event.attendees ?? []).find((a) => a.self === true)
  if (self === undefined) {
    throw new Error(
      `${eventName(id, event.summary)} does not list the user as a guest, so there is ` +
        'no invitation to answer.',
    )
  }
  await api.patch(`${url}?sendUpdates=all`, {
    attendeesOmitted: true,
    attendees: [{ ...self, responseStatus: answer, ...(comment === undefined ? {} : { comment }) }],
  })
}
