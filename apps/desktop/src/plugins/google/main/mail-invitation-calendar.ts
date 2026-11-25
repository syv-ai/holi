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
import type { CalendarLocator } from './mail-invitation-store'
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
  upcomingLinks:
    ((suppressSlot: (slot: string) => boolean) => Promise<InvitationLinks | null>) | null
}

export type InvitationLinks = Pick<
  InvitationCalendarCopy,
  'conferenceUrl' | 'conferenceLinkSource' | 'htmlLink'
>

type CalendarLookup =
  | InvitationCalendarCopy
  | { kind: 'absent' }
  | { kind: 'blocked'; reason: string; cancelled?: true; navigationUnverified?: true }

type Parsed = NonNullable<ReturnType<typeof parseMailInvitation>>
type RevisionMaterial = {
  details: Parsed['details']
  material: NonNullable<Parsed['revisionMaterial']>
}
type InvitationTarget = RevisionMaterial & {
  request: NonNullable<Parsed['request']>
  joinOnly: boolean
  predecessors: RevisionMaterial[]
}

const CALENDAR_PAGE_LIMIT = 10

type CollectionKind = 'calendar#events' | 'calendar#calendarList'
type CollectionPage<T> = { items?: T[]; nextPageToken?: string }

function invitationPageItems<T>(page: CollectionPage<T>, kind: CollectionKind): T[] {
  if (
    !page ||
    typeof page !== 'object' ||
    Array.isArray(page) ||
    !('kind' in page) ||
    page.kind !== kind ||
    (page.items !== undefined && !Array.isArray(page.items))
  )
    throw new Error('Invalid Calendar collection')
  return page.items ?? []
}

function invitationPageToken(page: CollectionPage<unknown>): string | undefined {
  const token = page.nextPageToken
  if (token !== undefined && (typeof token !== 'string' || !/^[^\s\p{Cc}]{1,4096}$/u.test(token)))
    throw new Error('Invalid Calendar page token')
  return token
}

function isCollectionRow(item: unknown): boolean {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item))
}

async function invitationPages<T>(
  api: GoogleApi,
  url: string,
  kind: CollectionKind,
  params: GoogleParams,
  observe?: (item: T) => Promise<void>,
): Promise<T[]> {
  const all: T[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  for (let index = 0; index < CALENDAR_PAGE_LIMIT; index++) {
    const page = await api.get<CollectionPage<T>>(url, { ...params, pageToken })
    const items = invitationPageItems(page, kind)
    // An independently verified locator is evidence of existence, even if a
    // sibling, page token, or later request prevents using the collection.
    if (observe) for (const item of items) if (isCollectionRow(item)) await observe(item)
    if (!items.every(isCollectionRow)) throw new Error('Invalid Calendar collection row')
    all.push(...items)
    pageToken = invitationPageToken(page)
    if (pageToken === undefined) return all
    if (seen.has(pageToken)) throw new Error('Calendar repeated a page token')
    seen.add(pageToken)
  }
  throw new Error('Calendar returned too many pages')
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

/** Call after validating the provider's event times. */
function occurrenceSlot(event: RawEvent): string | null {
  const original = event.originalStartTime
  return original ? (original.date ?? new Date(instant(original.dateTime!)).toISOString()) : null
}

function sameOccurrence(event: RawEvent, recurrenceId: string): boolean {
  const original = event.originalStartTime
  if (!original) return false
  if (original.date !== undefined) return original.date === recurrenceId
  return original.dateTime !== undefined && instant(original.dateTime) === instant(recurrenceId)
}

// Only comparable original slots can rule out a relationship. In particular,
// an absolute provider slot says nothing about a floating mail slot's zone.
function distinctSlots(a: string, b: string): boolean {
  if (date(a) && date(b)) return a !== b
  const first = instant(a)
  const second = instant(b)
  return Number.isFinite(first) && Number.isFinite(second) && first !== second
}

type CalendarScope = Pick<CalendarLocator, 'recurrenceId' | 'occurrenceUnverified'>

function eventLocatorScope(event: RawEvent): CalendarScope {
  const instance = event.recurringEventId !== undefined || event.originalStartTime !== undefined
  const recurrenceId = instance && usableEventLocator(event) ? occurrenceSlot(event) : null
  return {
    recurrenceId,
    ...(instance && recurrenceId === null ? { occurrenceUnverified: true } : {}),
  }
}

/** Existence only: an exact slot can rule out a different comparable slot.
 * A root cannot rule out an occurrence (even without rules, e.g. a cancelled
 * master), and an exception alone cannot establish absence of a root. This
 * also applies to legacy locators that described a root as non-recurring. */
export function calendarLocatorMayMatchScope(
  copy: CalendarScope,
  { recurrenceId }: Pick<Parsed['details']['identity'], 'recurrenceId'>,
): boolean {
  return (
    copy.occurrenceUnverified === true ||
    copy.recurrenceId === null ||
    recurrenceId === null ||
    !distinctSlots(copy.recurrenceId, recurrenceId)
  )
}

class PossibleSeriesCancellation extends Error {}

async function exactCopies(
  api: GoogleApi,
  url: string,
  identity: Parsed['details']['identity'],
  floating: boolean,
  context: { organizer: string | undefined; bindsParent: (event: RawEvent) => boolean },
  observe: (event: RawEvent) => Promise<void>,
): Promise<RawEvent[]> {
  const { uid, recurrenceId, sequence } = identity
  const events = await invitationPages<RawEvent>(
    api,
    url,
    'calendar#events',
    { iCalUID: uid, singleEvents: 'false', showDeleted: 'true' },
    async (event) => {
      if (event.iCalUID === uid) await observe(event)
    },
  )
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
  const possible = events.filter((event) =>
    calendarLocatorMayMatchScope(eventLocatorScope(event), identity),
  )
  const roots = possible.filter((event) => !event.recurringEventId && !event.originalStartTime)
  const listedIds = new Set(events.map(({ id }) => id))
  if (listedIds.size !== events.length) throw new Error('Calendar returned duplicate event rows')
  // Any row for a floating series could occupy this wall-clock slot. An
  // empty UID collection is still meaningful; never query instances in a guessed zone.
  if (floating) return possible
  const requireScope = (copies: RawEvent[]) => {
    // Even rows ruled out as locators don't make a nonempty list proof of absence.
    if (events.length && !copies.length)
      throw new Error('Calendar returned events but could not verify this recurrence scope')
    return copies
  }
  if (recurrenceId === null) return requireScope(roots)
  const cancelledRoots = roots.filter((root) => root.status === 'cancelled')
  const activeRoots = roots.filter((root) => root.status !== 'cancelled')
  if (activeRoots.length > 1) throw new Error('Calendar returned ambiguous series rows')
  const verifiedInstances = new Set<string | undefined>()
  const matching = new Map(
    possible
      .filter((event) => sameOccurrence(event, recurrenceId))
      .map((event) => [event.id, event]),
  )
  for (const series of activeRoots) {
    if (!series.id || !series.recurrence?.length) continue
    const verifiedParent =
      cancelledRoots.length > 0 &&
      series.iCalUID === uid &&
      Boolean(context.organizer) &&
      series.organizer?.email?.toLowerCase() === context.organizer &&
      context.bindsParent(series) &&
      (series.sequence ?? 0) === sequence &&
      coherentEventTimes(series) &&
      (series.start?.date !== undefined) === date(recurrenceId) &&
      recurrenceSet(series.recurrence) !== null
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
      async (event) => {
        // Only a UID-verified parent can establish UID when the instance omits it.
        if (
          (event.iCalUID === uid || (event.iCalUID === undefined && series.iCalUID === uid)) &&
          event.recurringEventId === series.id
        )
          await observe(event)
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
      if (
        listedIds.has(event.id) &&
        (!listed || listed.etag !== event.etag || calendarProof(listed) !== calendarProof(event))
      )
        throw new Error('Calendar returned conflicting instance rows')
      matching.set(event.id, event)
      if (verifiedParent) verifiedInstances.add(event.id)
    }
  }
  const matches = [...matching.values()]
  // A root may cover an occurrence even when Google removed its recurrence
  // rules. A different recurringEventId on a listed row is not evidence that
  // the cancellation is unrelated. Only a corroborated current parent and
  // older, distinct tombstones can disambiguate it for RSVP or navigation.
  if (!matches.length) return requireScope(cancelledRoots)
  const cancelledParents = cancelledRoots.filter((root) =>
    matches.some((instance) => instance.recurringEventId === root.id),
  )
  if (cancelledParents.length) return cancelledParents
  if (
    cancelledRoots.length &&
    (matches.length !== 1 ||
      !verifiedInstances.has(matches[0]!.id) ||
      cancelledRoots.some(
        (root) =>
          root.iCalUID !== uid ||
          root.organizer?.email?.toLowerCase() !== context.organizer ||
          root.sequence === undefined ||
          root.sequence >= sequence,
      ))
  )
    throw new PossibleSeriesCancellation()
  return matches
}

function hasEventResourceId(event: RawEvent): boolean {
  return (
    (event.kind === undefined || event.kind === 'calendar#event') &&
    typeof event.id === 'string' &&
    /^[A-Za-z0-9_-]{1,1024}$/.test(event.id)
  )
}

function usableEventLocator(event: RawEvent): boolean {
  return (
    hasEventResourceId(event) &&
    (event.recurringEventId === undefined
      ? event.originalStartTime === undefined
      : typeof event.recurringEventId === 'string' &&
        Boolean(event.recurringEventId) &&
        validTime(event.originalStartTime))
  )
}

function usableInvitationEvent(event: RawEvent): boolean {
  return (
    usableEventLocator(event) &&
    (event.status === undefined ||
      ['confirmed', 'tentative', 'cancelled'].includes(event.status)) &&
    (event.sequence === undefined ||
      (Number.isSafeInteger(event.sequence) && event.sequence >= 0)) &&
    (event.recurrence === undefined ||
      (Array.isArray(event.recurrence) &&
        event.recurrence.every((rule) => typeof rule === 'string'))) &&
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

class CalendarObservationError extends Error {}

/** RSVP lookup is independent of agenda visibility, dates and RSVP state. */
export async function findInvitationCalendarCopy(
  api: GoogleApi,
  invitation: InvitationTarget,
  mailbox: string,
  remember: (locator: Omit<CalendarLocator, 'accountSub'>) => Promise<void>,
): Promise<CalendarLookup> {
  try {
    return await lookupInvitationCalendarCopy(api, invitation, mailbox, async (locator) => {
      try {
        await remember(locator)
      } catch (cause) {
        throw new CalendarObservationError('Could not retain a Calendar locator', { cause })
      }
    })
  } catch (error) {
    if (error instanceof CalendarObservationError) throw error.cause
    if (error instanceof PossibleSeriesCancellation)
      return {
        kind: 'blocked',
        reason: 'Calendar could not distinguish this occurrence from a cancelled series',
        navigationUnverified: true,
      }
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
  remember: (locator: Omit<CalendarLocator, 'accountSub'>) => Promise<void>,
): Promise<CalendarLookup> {
  const { identity } = invitation.details
  const { uid, recurrenceId } = identity
  const organizer = invitation.details.organizer?.email
  const parentContext = (ownedCalendar?: string) => ({
    organizer,
    bindsParent: (event: RawEvent) =>
      Boolean(
        mailboxAttendee(event, mailbox) ||
        (invitation.joinOnly &&
          event.organizer?.self &&
          (organizer === mailbox || organizer === ownedCalendar)),
      ),
  })
  const observeCopy =
    (base: string, calendarId?: string, owned = false) =>
    async (event: RawEvent) => {
      // Bind organizer and mailbox independently of scope, RSVP fields,
      // and the rest of the collection.
      if (
        !hasEventResourceId(event) ||
        !organizer ||
        typeof event.organizer?.email !== 'string' ||
        event.organizer.email.toLowerCase() !== organizer
      )
        return
      // The authenticated primary collection itself binds the resource to the
      // mailbox. Elsewhere, require the provider's self marker, not just an
      // attendee address on a shared calendar's copy.
      if (base !== PRIMARY_EVENTS) {
        const self = uniqueSelfAttendee(event)
        const selfEmail = typeof self?.email === 'string' ? self.email.toLowerCase() : undefined
        const person = self && (self.resource === undefined || self.resource === false)
        const mailboxCopy = selfEmail === mailbox && person
        const ownedCopy =
          owned &&
          ((selfEmail === calendarId && person) ||
            (event.organizer?.self === true && (organizer === mailbox || organizer === calendarId)))
        if (!mailboxCopy && !ownedCopy) return
      }
      const instance = event.recurringEventId !== undefined || event.originalStartTime !== undefined
      const series =
        instance || event.recurrence === undefined
          ? false
          : Array.isArray(event.recurrence)
            ? event.recurrence.length > 0
            : undefined
      const scope = eventLocatorScope(event)
      if (!calendarLocatorMayMatchScope(scope, identity)) return
      await remember({
        uid,
        organizer,
        ...scope,
        series,
        target: calendarCopyTarget(calendarResponseUrl(base, event), mailbox),
      })
    }
  const series = recurrenceId === null && invitation.details.recurring
  const basis = invitation.request.recurrenceTimeBasis
  const floating =
    invitation.request.recurrenceKind === 'floating' || (series && basis?.kind === 'floating')
  const unmatchable = {
    kind: 'blocked',
    reason: 'Calendar cannot verify a floating recurrence',
  } as const
  const primary = await exactCopies(
    api,
    PRIMARY_EVENTS,
    identity,
    floating,
    parentContext(),
    observeCopy(PRIMARY_EVENTS),
  )
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
      !safeCalendarId(calendar.id) ||
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
    const ownedCalendar = calendar.accessRole === 'owner' ? calendar.id.toLowerCase() : undefined
    const events = await exactCopies(
      api,
      url,
      identity,
      floating,
      parentContext(ownedCalendar),
      observeCopy(url, calendar.id.toLowerCase(), calendar.accessRole === 'owner'),
    )
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
        ownedCalendar,
        calendar.accessRole === 'owner',
      )
    }
  }
  return match ?? { kind: 'absent' }
}

function uniqueSelfAttendee(event: RawEvent) {
  const attendees = event.attendees
  if (
    !Array.isArray(attendees) ||
    !attendees.every(
      (attendee) =>
        isCollectionRow(attendee) &&
        (attendee.self === undefined || typeof attendee.self === 'boolean'),
    )
  )
    return undefined
  const self = attendees.filter((attendee) => attendee.self === true)
  return self.length === 1 ? self[0] : undefined
}

/** Calendar's `self` identifies the copy; an RSVP must also identify exactly
 * one attendee for the connected mailbox, not a calendar ID or alias. */
function mailboxAttendee(event: RawEvent, mailbox: string) {
  const self = uniqueSelfAttendee(event)
  return self?.email?.toLowerCase() === mailbox &&
    !self.resource &&
    event.attendees?.filter(({ email }) => email?.toLowerCase() === mailbox).length === 1
    ? self
    : undefined
}

function calendarResponseUrl(base: string, event: RawEvent): string {
  return `${base}/${encodeURIComponent(event.id ?? '')}?sendUpdates=all`
}

function calendarCopyTarget(url: string, mailbox: string): string {
  return JSON.stringify([url, mailbox])
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
  const { details, request, material, joinOnly } = invitation
  const self = joinOnly ? uniqueSelfAttendee(event) : undefined
  const selfEmail = self?.email?.toLowerCase()
  const attendee = joinOnly
    ? selfEmail && (selfEmail === mailbox || selfEmail === ownedCalendar)
      ? self
      : undefined
    : request.attendees.includes(mailbox)
      ? mailboxAttendee(event, mailbox)
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
  if (!organizer || organizer !== details.organizer?.email)
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
  const { explicitFields } = material
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
  const expectedRoster = JSON.stringify(material.attendees)
  const requiresRoster = invitation.predecessors.some(
    (prior) => JSON.stringify(prior.material.attendees) !== expectedRoster,
  )
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
    (explicitFields.htmlLink &&
      calendarPageInMail &&
      htmlLink &&
      calendarPageInMail !== htmlLink) ||
    (!cancelled &&
      ((!joinOnly &&
        (material.status === 'CONFIRMED' || material.status === 'TENTATIVE') &&
        event.status !== undefined &&
        event.status.toUpperCase() !== material.status) ||
        (requiresRoster && calendarRoster(event) !== expectedRoster) ||
        !provesChangedMaterial(invitation, event, calendarConference, htmlLink)))
  )
    return blocked('The Calendar details do not match this revision of the invitation')
  if (joinOnly && (!start || !end || !explicitFields.start))
    return blocked('Calendar could not verify the time of this meeting')
  const etag = strongEventEtag(event.etag)
  // Only an explicit needsAction is a reset. An omitted status cannot
  // corroborate a dispatch or make that response safe to send again.
  const responseStatus = joinOnly || cancelled ? null : asRsvp(attendee?.responseStatus)
  const reason = cancelled
    ? 'This Calendar event was cancelled'
    : joinOnly
      ? null
      : responseStatus === null
        ? 'Calendar could not verify your response on this event'
        : !etag || !writable
          ? 'This Calendar copy cannot be edited'
          : null
  const url = calendarResponseUrl(base, event)
  const proof = calendarProof(event, requiresRoster)
  return {
    kind: 'verified',
    target: calendarCopyTarget(url, mailbox),
    etag,
    proof,
    matchesProof: (stored) => stored === proof || matchesCalendarProof(event, stored),
    revision: details.identity,
    title: event.summary,
    start,
    end,
    allDay,
    location: event.location,
    conferenceUrl,
    conferenceLinkSource,
    htmlLink,
    responseStatus,
    cancelled,
    unavailableReason: reason,
    upcomingLinks:
      recurrenceId === null && details.recurring && !cancelled
        ? (suppressSlot) =>
            upcomingInvitationLinks(api, base, event, details.identity.uid, organizer, suppressSlot)
        : null,
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

/** Only Join uses the ordered, expanded view. Its instances never provide
 * RSVP material, a write validator, or proof of absence for the master. */
async function upcomingInvitationLinks(
  api: GoogleApi,
  base: string,
  master: RawEvent,
  uid: string,
  organizer: string,
  suppressSlot: (slot: string) => boolean,
): Promise<InvitationLinks | null> {
  const now = Date.now()
  const timeMin = new Date(now).toISOString()
  let pageToken: string | undefined
  const seen = new Set<string>()
  try {
    for (let pageNumber = 0; pageNumber < CALENDAR_PAGE_LIMIT; pageNumber++) {
      const page = await api.get<CollectionPage<RawEvent>>(base, {
        iCalUID: uid,
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin,
        showDeleted: 'false',
        maxResults: '1',
        pageToken,
      })
      const items = invitationPageItems(page, 'calendar#events')
      pageToken = invitationPageToken(page)
      if (
        items.length > 1 ||
        !items.every(isCollectionRow) ||
        (pageToken !== undefined && seen.has(pageToken))
      )
        return null
      const instance = items[0]
      // A verified page may still contain an ineligible occurrence. None of
      // its links are usable, but a valid continuation may lead to a safe one.
      if (
        instance &&
        usableInvitationEvent(instance) &&
        instance.id !== master.id &&
        instance.iCalUID === uid &&
        instance.recurringEventId === master.id &&
        instance.organizer?.email?.toLowerCase() === organizer &&
        instance.status !== 'cancelled' &&
        coherentEventTimes(instance) &&
        (instance.start?.date !== undefined) === (master.start?.date !== undefined) &&
        // timeMin applies to the exclusive end. For DATEs Google applies its
        // calendar timezone; converting those dates ourselves would guess it.
        (instance.end?.dateTime === undefined || instant(instance.end.dateTime) > now) &&
        !suppressSlot(occurrenceSlot(instance)!)
      ) {
        const { url, source } = mailConference(instance)
        const htmlLink = googleEventUrl(instance.htmlLink)
        if (url || htmlLink) return { conferenceUrl: url, conferenceLinkSource: source, htmlLink }
      }
      if (pageToken === undefined) return null
      seen.add(pageToken)
    }
  } catch {
    // An unavailable optional link neither invalidates the verified master
    // nor changes how the invitation may be answered.
  }
  return null
}

const words = (value: string | null | undefined) =>
  value?.normalize('NFC').trim().replace(/\r\n/g, '\n') ?? ''

/** At the same sequence, omission is not proof of material that changed.
 * Demand a provider observation for each discriminator, while leaving normal
 * copy verification (including Google’s omitted optional fields) unchanged. */
function provesChangedMaterial(
  invitation: InvitationTarget,
  event: RawEvent,
  conference: string | null,
  htmlLink: string | null,
): boolean {
  const { predecessors } = invitation
  if (!predecessors.length) return true
  // A series master cannot prove changes to embedded exception rows. A
  // nonempty Calendar lookup must not authorize RSVP on that master or by mail.
  if (
    predecessors.some(
      ({ material }) => material.exceptionsKey !== invitation.material.exceptionsKey,
    )
  )
    return false
  const proves = <T>(valueOf: (revision: RevisionMaterial) => T, observed: T | undefined) => {
    const expected = valueOf(invitation)
    return observed === expected || predecessors.every((prior) => valueOf(prior) === expected)
  }
  const textOf = (value: string | undefined) => (value === undefined ? undefined : words(value))
  const timeOf = (value: string | null | undefined, allDay: boolean) => {
    if (value == null) return undefined
    const millis = allDay ? NaN : instant(value)
    return Number.isFinite(millis) ? millis : value
  }
  const prose = (copy: RevisionMaterial) => words(copy.material.description)
  const description = prose(invitation)
  // Calendar can represent a bare join URL as structured conference data.
  // That is not a substitute for changed prose, or for a URL already present
  // (in any form) in a predecessor's description.
  const structured = providerConferenceUrl(structuredConference(event))
  const confirmsDescription =
    proves(prose, textOf(event.description)) ||
    (structured &&
      providerConferenceUrl(description) === structured &&
      predecessors.every(
        (prior) => prose(prior) === description || conferenceUrlIn(prose(prior)) !== structured,
      ))
  return Boolean(
    proves(
      ({ details, material }) => (material.explicitFields.title ? words(details.title) : ''),
      textOf(event.summary),
    ) &&
    // An omitted STATUS is distinct in the mail's material hash. Neither
    // an omitted provider status nor an assumed default proves a change.
    proves(({ material }) => material.status, event.status?.toUpperCase()) &&
    proves(({ details }) => words(details.location), textOf(event.location)) &&
    confirmsDescription &&
    proves(({ details }) => details.conferenceUrl, conference ?? undefined) &&
    proves(({ details }) => googleEventUrl(details.htmlLink), htmlLink ?? undefined) &&
    proves(
      ({ details }) => timeOf(details.start, details.allDay),
      timeOf(event.start?.date ?? event.start?.dateTime, invitation.details.allDay),
    ) &&
    proves(
      ({ details }) => timeOf(details.end, details.allDay),
      timeOf(event.end?.date ?? event.end?.dateTime, invitation.details.allDay),
    ),
  )
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

/** An omitted or anonymous attendee cannot distinguish two invitation rosters.
 * Like invitation material, this is a set of addresses, not roles or RSVPs. */
function calendarRoster(event: RawEvent): string | undefined {
  if (
    (event.attendeesOmitted !== undefined && event.attendeesOmitted !== false) ||
    !event.attendees ||
    event.attendees.some(({ email }) => !email)
  )
    return undefined
  return JSON.stringify(
    [...new Set(event.attendees.map(({ email }) => email!.toLowerCase()))].sort(),
  )
}

function matchesCalendarProof(event: RawEvent, stored: string) {
  // Old journals can still prove an exact match to their recorded fields.
  // New writes also bind the event status, not just the attendee's answer.
  const rosterKnown = calendarRoster(event) !== undefined
  return (
    stored === calendarProof(event) ||
    (rosterKnown && stored === calendarProof(event, true)) ||
    stored === calendarProof(event, false, 'prose') ||
    (rosterKnown && stored === calendarProof(event, true, 'prose')) ||
    stored === calendarProof(event, false, 'canonical-v1') ||
    (event.recurrence !== undefined && stored === calendarProof(event, false, 'legacy'))
  )
}

function calendarProof(
  event: RawEvent,
  roster = false,
  version: 'status' | 'prose' | 'canonical-v1' | 'legacy' = 'status',
): string {
  const conference = httpsLink(structuredConference(event)) ?? mailConference(event).url
  const description = words(event.description)
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
        version === 'legacy'
          ? event.recurrence
          : event.recurrence?.length
            ? (recurrenceSet(event.recurrence) ?? event.recurrence)
            : undefined,
        event.organizer?.email?.toLowerCase(),
        event.summary,
        when(event.start),
        when(event.end),
        event.location,
        conference,
        googleEventUrl(event.htmlLink),
        ...(version === 'status' || version === 'prose'
          ? [conference && providerConferenceUrl(description) === conference ? '' : description]
          : []),
        // If membership was needed to identify the copy, readback must still
        // observe it even when falling back to a GET of the original resource.
        ...(roster ? [['attendees', calendarRoster(event)]] : []),
        ...(event.recurrence?.length && event.start?.timeZone !== undefined
          ? [canonicalIanaZone(event.start.timeZone) ?? event.start.timeZone]
          : []),
        ...(version === 'status' ? [['status', event.status ?? null]] : []),
      ]),
    )
    .digest('hex')
}

function safeCalendarId(id: unknown): id is string {
  return (
    typeof id === 'string' && id !== '.' && id !== '..' && /^[^\s\p{Cc}/\\?#%]{1,1024}$/u.test(id)
  )
}

function calendarTargetParts(target: string): [string, string] | null {
  try {
    const binding: unknown = JSON.parse(target)
    if (
      Array.isArray(binding) &&
      binding.length === 2 &&
      typeof binding[0] === 'string' &&
      typeof binding[1] === 'string'
    )
      return [binding[0], binding[1]]
  } catch {
    // Not a locator. No request may be made with this value.
  }
  return null
}

export function calendarTargetMailbox(target: string): string | null {
  return calendarTargetParts(target)?.[1] ?? null
}

function calendarTargetUrl(target: string, mailbox: string): string | null {
  const binding = calendarTargetParts(target)
  if (!binding || binding[1] !== mailbox) return null
  const [url] = binding
  const match =
    /^(https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/?#]+)\/events\/[\w-]+)\?sendUpdates=all$/.exec(
      url,
    )
  if (!match || match[0] !== url) return null
  try {
    const segment = match[2]!
    const id = decodeURIComponent(segment)
    return safeCalendarId(id) && encodeURIComponent(id) === segment ? match[1]! : null
  } catch {
    return null
  }
}

export function calendarTargetIsMailbox(target: string, mailbox: string): boolean {
  return calendarTargetUrl(target, mailbox) !== null
}

type CalendarResource =
  | { kind: 'gone' | 'unknown' }
  | { kind: 'present'; confirms: (proof: string, answer: InviteAnswer) => boolean }

/** Exact resources can corroborate earlier writes, and only a resource 404
 * corroborates absence for a known target. Neither authorizes a Calendar PATCH. */
export function createInvitationCalendarResourceLookup(api: GoogleApi, mailbox: string) {
  const snapshots = new Map<string, Promise<CalendarResource>>()
  async function read(url: string): Promise<CalendarResource> {
    try {
      const event = await api.get<RawEvent>(url)
      return {
        kind: 'present',
        confirms: (proof, answer) =>
          Boolean(
            event &&
            usableInvitationEvent(event) &&
            event.status !== 'cancelled' &&
            !event.organizer?.self &&
            coherentEventTimes(event) &&
            mailboxAttendee(event, mailbox)?.responseStatus === answer &&
            matchesCalendarProof(event, proof),
          ),
      }
    } catch (error) {
      if (propagateCalendarRefusal(error)) throw error
      return {
        kind: error instanceof GoogleApiError && error.status === 404 ? 'gone' : 'unknown',
      }
    }
  }
  return (target: string): Promise<CalendarResource> => {
    const url = calendarTargetUrl(target, mailbox)
    if (!url) return Promise.resolve({ kind: 'unknown' })
    let snapshot = snapshots.get(url)
    if (!snapshot) {
      // Historical targets share a bounded budget within this snapshot.
      if (snapshots.size >= 32) return Promise.resolve({ kind: 'unknown' })
      snapshot = read(url)
      snapshots.set(url, snapshot)
    }
    return snapshot
  }
}
