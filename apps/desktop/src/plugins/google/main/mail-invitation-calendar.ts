import { createHash } from 'node:crypto'
import { canonicalIanaZone } from '../shared/time-zones'
import { GoogleApiError, type GoogleApi, type GoogleDispatchGate, type GoogleParams } from './api'
import {
  asRsvp,
  BASE,
  PRIMARY_EVENTS,
  structuredConference,
  type CalendarListEntry,
  type InviteAnswer,
  type RawEvent,
  type RsvpStatus,
} from './calendar'
import type { parseMailInvitation } from './mail-invitation'
import {
  conferenceUrlIn,
  googleEventUrl,
  httpsLink,
  providerConferenceUrl,
} from '../shared/meeting-links'

type InvitationCalendarCopy = {
  kind: 'verified'
  target: string
  etag: string | null
  proof: string
  matchesProof: (proof: string) => boolean
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
  reply: ((answer: InviteAnswer, gate: GoogleDispatchGate) => Promise<void>) | null
}

type CalendarLookup =
  | InvitationCalendarCopy
  | { kind: 'absent' }
  | { kind: 'blocked'; reason: string; cancelled?: true }

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
  // Do not let Date.parse roll over invalid dates or truncate precision that
  // could distinguish two revisions or invert an interval.
  const rfc3339 =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3}0*)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(
      value,
    )
  return rfc3339 && value === rfc3339[0] && date(rfc3339[1]) ? Date.parse(value) : NaN
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
    (value.timeZone === undefined ||
      (typeof value.timeZone === 'string' && canonicalIanaZone(value.timeZone) !== null)) &&
    ((date(value.date) && value.dateTime === undefined) ||
      (value.date === undefined &&
        typeof value.dateTime === 'string' &&
        Number.isFinite(instant(value.dateTime)))),
  )
}

function coherentEventTimes(event: RawEvent): boolean {
  const { start, end, originalStartTime, endTimeUnspecified } = event
  // Google can emit a placeholder end even when the end time is unspecified.
  if (!start || !end || (endTimeUnspecified !== undefined && endTimeUnspecified !== false))
    return false
  const allDay = start.date !== undefined
  if (originalStartTime && (originalStartTime.date !== undefined) !== allDay) return false
  // Calendar's DATE end is exclusive. A timed event can have zero duration.
  return start.date !== undefined
    ? end.date !== undefined && end.date > start.date
    : start.dateTime !== undefined &&
        end.dateTime !== undefined &&
        instant(end.dateTime) >= instant(start.dateTime)
}

/** If-Match must bind to exactly one strong validator, never a wildcard or list. */
function strongEventEtag(value: string | undefined): string | null {
  return value?.endsWith('"') && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : null
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
  floating: boolean,
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
  // Any row for a floating series could occupy this wall-clock slot. An
  // empty UID collection is still meaningful; never query instances in a guessed zone.
  if (floating) return events
  const requireScope = (copies: RawEvent[]) => {
    if (events.length && !copies.length)
      throw new Error('Calendar returned events but could not verify this recurrence scope')
    return copies
  }
  if (recurrenceId === null) return requireScope(roots)
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
  const cancelledRoots = roots.filter((root) => root.status === 'cancelled')
  return requireScope(
    !matching.size ||
      cancelledRoots.some((root) =>
        [...matching.values()].some((instance) => instance.recurringEventId === root.id),
      )
      ? cancelledRoots
      : [...matching.values()],
  )
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
    if (propagateCalendarRefusal(error)) throw error
    if (error instanceof GoogleApiError && error.status === 403)
      return { kind: 'blocked', reason: 'Calendar refused access to this invitation copy' }
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
  const series = recurrenceId === null && invitation.details.recurring
  const basis = invitation.request.recurrenceTimeBasis
  const floating =
    invitation.request.recurrenceKind === 'floating' || (series && basis?.kind === 'floating')
  const unmatchable = {
    kind: 'blocked',
    reason: 'Calendar cannot verify a floating recurrence',
  } as const
  const primary = await exactCopies(api, PRIMARY_EVENTS, uid, recurrenceId, floating)
  if (floating && primary.length) return unmatchable
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
    const events = await exactCopies(api, url, uid, recurrenceId, floating)
    if (floating && events.length) return unmatchable
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
  const { details, request, joinOnly } = invitation
  // Calendar's `self` denotes the copy, not the mailbox. Even its owner must
  // not answer for a calendar ID or alias that is not the invited mailbox.
  const attendee =
    self.length === 1 &&
    selfEmail &&
    (joinOnly
      ? selfEmail === mailbox || selfEmail === ownedCalendar
      : selfEmail === mailbox &&
        request.attendees.includes(mailbox) &&
        event.attendees?.filter((guest) => guest.email?.toLowerCase() === mailbox).length === 1)
      ? self[0]
      : undefined
  const organizer = event.organizer?.email?.toLowerCase()
  const { sequence, recurrenceId } = details.identity
  const blocked = (reason: string): CalendarLookup => ({ kind: 'blocked', reason })
  const cancelled = event.status === 'cancelled'
  if (
    cancelled &&
    (joinOnly ||
      !attendee ||
      organizer !== details.organizer?.email ||
      (recurrenceId !== null && !event.recurringEventId))
  )
    return { kind: 'blocked', reason: 'This Calendar event was cancelled', cancelled: true }
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
  if (recurrenceId === null && details.recurring && !sameRecurrenceStart(request, event.start))
    return blocked('The Calendar time zone does not match this series invitation')
  const { explicitFields } = request
  if (explicitFields.recurrence) {
    const expected = recurrenceSet(request.recurrence)
    const actual = recurrenceSet(event.recurrence ?? [])
    if (expected === null || actual === null || expected !== actual)
      return blocked('Calendar could not verify the recurrence of this invitation')
  }
  const start = event.start?.date ?? event.start?.dateTime
  const end = event.end?.date ?? event.end?.dateTime
  const allDay = event.start?.date !== undefined
  if (!cancelled && (!coherentEventTimes(event) || allDay !== details.allDay))
    return blocked('Calendar could not verify the start and end of this event')
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
  const etag = strongEventEtag(event.etag)
  const reason = cancelled
    ? 'This Calendar event was cancelled'
    : joinOnly
      ? null
      : !etag || !writable
        ? 'This Calendar copy cannot be edited'
        : null
  const url = `${base}/${encodeURIComponent(event.id ?? '')}?sendUpdates=all`
  const proof = calendarProof(event)
  return {
    kind: 'verified',
    target: JSON.stringify([url, selfEmail ?? organizer]),
    etag,
    proof,
    matchesProof: (stored) => matchesCalendarProof(event, stored, proof),
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

function sameRecurrenceStart(
  request: InvitationTarget['request'],
  start: RawEvent['start'],
): boolean {
  const basis = request.recurrenceTimeBasis
  if (!start || !basis) return false
  if (basis.kind === 'date')
    return (
      start.date === basis.wallStart &&
      request.calendarRecurrenceZoneMatches(start.timeZone ?? null)
    )
  if (!start.dateTime || !request.calendarRecurrenceZoneMatches(start.timeZone ?? null))
    return false
  // Calendar requires a named expansion zone for a timed recurring event.
  // A serialized offset (even Z) alone only describes the first instant.
  const expectedZone = canonicalIanaZone(start.timeZone)
  if (!expectedZone) return false
  // Use the declared recurrence zone, not the offset chosen to serialize the
  // first instant (which may be serialized in UTC even for a zoned series).
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: expectedZone,
    dateStyle: 'short',
    timeStyle: 'medium',
  })
    .format(instant(start.dateTime))
    .replace(' ', 'T')
  return local === basis.wallStart.replace(/(?:\.000)?Z$/, '')
}

/** Compare descriptions, not expanded occurrences. Normalise unordered rule
 * terms and date sets, but do not infer equality across different time zones,
 * DATE vs DATE-TIME, or recurrence forms we cannot interpret. */
function recurrenceSet(lines: string[]): string | null {
  if (lines.length > 4096) return null
  const terms = new Set<string>()
  const setFields = new Set([
    'BYSECOND',
    'BYMINUTE',
    'BYHOUR',
    'BYDAY',
    'BYMONTHDAY',
    'BYYEARDAY',
    'BYWEEKNO',
    'BYMONTH',
    'BYSETPOS',
  ])
  const scalarFields = new Set(['FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'WKST'])
  for (const line of lines) {
    if (line.length > 8192) return null
    const property = /^(RRULE|RDATE|EXDATE)((?:;[^:\r\n]+)?):([^\r\n]+)$/i.exec(line.trim())
    if (!property) return null
    const kind = property[1]!.toUpperCase()
    const qualifiers = property[2]!
    const body = property[3]!.toUpperCase()
    if (kind === 'RRULE') {
      if (qualifiers) return null
      const fields = new Map<string, string>()
      for (const term of body.split(';')) {
        const field = /^([A-Z]+)=([A-Z0-9,+-]+)$/.exec(term)
        if (!field) return null
        const key = field[1]!
        const value = field[2]!
        if (fields.has(key) || (!scalarFields.has(key) && !setFields.has(key))) return null
        fields.set(
          key,
          setFields.has(key) ? [...new Set(value.split(','))].sort().join(',') : value,
        )
      }
      if (!fields.has('FREQ')) return null
      if (!fields.has('INTERVAL')) fields.set('INTERVAL', '1')
      if (!fields.has('WKST')) fields.set('WKST', 'MO')
      terms.add(JSON.stringify([kind, [...fields].sort()]))
    } else {
      let type: string | undefined
      let zone: string | undefined
      for (const qualifier of qualifiers ? qualifiers.slice(1).split(';') : []) {
        const param = /^(VALUE|TZID)=([A-Za-z0-9_+/.-]+)$/i.exec(qualifier)
        if (!param) return null
        if (param[1]!.toUpperCase() === 'VALUE' && type === undefined)
          type = param[2]!.toUpperCase()
        else if (param[1]!.toUpperCase() === 'TZID' && zone === undefined) {
          const canonical = canonicalIanaZone(param[2])
          if (!canonical) return null
          zone = canonical
        } else return null
      }
      for (const value of body.split(',')) {
        if (
          type === 'DATE'
            ? zone !== undefined || !/^\d{8}$/.test(value)
            : (type !== undefined && type !== 'DATE-TIME') ||
              !/^\d{8}T\d{6}Z?$/.test(value) ||
              (zone !== undefined && value.endsWith('Z'))
        )
          return null
        terms.add(JSON.stringify([kind, type ?? 'DATE-TIME', zone ?? null, value]))
      }
    }
  }
  return JSON.stringify([...terms].sort())
}

function propagateCalendarRefusal(error: unknown): boolean {
  return (
    error instanceof GoogleApiError &&
    (error.code === 'reconnect' || error.code === 'scope' || error.code === 'rate-limit')
  )
}

function mailConference(event: RawEvent) {
  const structured = providerConferenceUrl(structuredConference(event))
  if (structured) return { url: structured, source: 'calendar' as const }
  const prose = conferenceUrlIn(event.description) ?? conferenceUrlIn(event.location)
  return { url: prose, source: prose ? ('provider' as const) : null }
}

function matchesCalendarProof(event: RawEvent, stored: string, proof = calendarProof(event)) {
  // Old journals can still prove an exact match. Only canonical proofs can
  // recognize reordered rules; never infer what a previous raw hash meant.
  return (
    stored === proof || (event.recurrence !== undefined && stored === calendarProof(event, true))
  )
}

function calendarProof(event: RawEvent, legacy = false): string {
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
        // Use the same equality as verification. Keep raw unrecognized rules
        // distinct rather than treating them as empty or equal to each other.
        legacy
          ? event.recurrence
          : event.recurrence?.length
            ? (recurrenceSet(event.recurrence) ?? event.recurrence)
            : undefined,
        event.organizer?.email?.toLowerCase(),
        event.summary,
        when(event.start),
        when(event.end),
        event.location,
        httpsLink(structuredConference(event)) ?? mailConference(event).url,
        googleEventUrl(event.htmlLink),
        ...(event.recurrence?.length && event.start?.timeZone !== undefined
          ? [canonicalIanaZone(event.start.timeZone) ?? event.start.timeZone]
          : []),
      ]),
    )
    .digest('hex')
}

function calendarTargetUrl(target: string, mailbox: string): string | null {
  let binding: unknown
  try {
    binding = JSON.parse(target)
  } catch {
    return null
  }
  if (!Array.isArray(binding) || binding.length !== 2) return null
  const [url, attendee] = binding as unknown[]
  return typeof url === 'string' &&
    attendee === mailbox &&
    /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/[^/?#]+\/events\/[\w-]+\?sendUpdates=all$/.test(
      url,
    )
    ? url.split('?')[0]!
    : null
}

export function calendarTargetIsMailbox(target: string, mailbox: string): boolean {
  return calendarTargetUrl(target, mailbox) !== null
}

/** Only a read of the original identity can reconcile a superseded Calendar
 * attempt. Deletion or a newer event at the original URL is not a refusal. */
export async function verifyInvitationCalendarResponse(
  api: GoogleApi,
  target: string,
  proof: string,
  answer: InviteAnswer,
  mailbox: string,
): Promise<boolean> {
  const url = calendarTargetUrl(target, mailbox)
  if (!url) return false
  const event = await api.get<RawEvent>(url).catch((error) => {
    if (propagateCalendarRefusal(error)) throw error
    return null
  })
  if (
    !event ||
    !usableInvitationEvent(event) ||
    event.status === 'cancelled' ||
    event.organizer?.self ||
    !matchesCalendarProof(event, proof)
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
