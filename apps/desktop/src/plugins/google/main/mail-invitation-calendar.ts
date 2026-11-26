import { createHash } from 'node:crypto'
import { canonicalIanaZone } from '../shared/time-zones'
import {
  GoogleApiError,
  GoogleResourceDecodeError,
  GoogleResourceTimeoutError,
  type GoogleApi,
  type GoogleParams,
} from './api'
import {
  asRsvp,
  BASE,
  calendarIsEnabledForLegacyMail,
  isAgendaEventVisible,
  PRIMARY_EVENTS,
  structuredConference,
  type CalendarListEntry,
  type CalendarOverrides,
  type InviteAnswer,
  type RawEvent,
  type RsvpStatus,
} from './calendar'
import type { CalendarRevisionFields, parseMailInvitation } from './mail-invitation'
import type { CalendarLocator, CalendarMaterialEvidence } from './mail-invitation-store'
import {
  conferenceUrlIn,
  googleEventUrl,
  httpsLink,
  providerConferenceUrl,
} from '../shared/meeting-links'

type CalendarReadApi = Pick<GoogleApi, 'get'>

type CalendarMeetingFacts = {
  title?: string
  start?: string
  end?: string
  allDay: boolean
  location?: string
  conferenceUrl: string | null
  conferenceLinkSource: 'calendar' | 'provider' | null
  htmlLink: string | null
}

type InvitationCalendarCopy = CalendarMeetingFacts & {
  kind: 'verified'
  target: string
  etag: string | null
  proof: string
  matchesProof: (proof: string) => boolean
  revision: Parsed['details']['identity']
  responseStatus: RsvpStatus | null
  canEdit: boolean
  canNavigate: boolean
  unavailableReason: string | null
  reply: { url: string; etag: string; attendee: NonNullable<RawEvent['attendees']>[number] } | null
  navigation: (selectSlot: SelectNavigationSlot) => Promise<InvitationNavigation>
}

type SelectNavigationSlot = (slot: string) => false | InvitationRevision | null

export type InvitationLinks = Pick<
  InvitationCalendarCopy,
  'conferenceUrl' | 'conferenceLinkSource' | 'htmlLink'
>

export type InvitationNavigation =
  | { kind: 'default' }
  | { kind: 'withheld' }
  /** Calendar read access alone cannot vouch for links from the mail. */
  | { kind: 'calendar'; links: InvitationLinks }
  /** Use the occurrence's links with a master page fallback, never the master’s room. */
  | { kind: 'series'; links?: InvitationLinks }

type CalendarLookup =
  | InvitationCalendarCopy
  | { kind: 'absent' }
  | {
      kind: 'blocked'
      reason: string
      cancelled?: true
      navigationUnverified?: true
    }

type Parsed = NonNullable<ReturnType<typeof parseMailInvitation>>
type RevisionMaterial = {
  details: Parsed['details']
  material: NonNullable<Parsed['revisionMaterial']>
}
export type InvitationRevision = RevisionMaterial & {
  fields: CalendarRevisionFields
  joinOnly: boolean
  evidence: CalendarMaterialEvidence
  predecessors: CalendarMaterialEvidence[]
  unknownPredecessor: boolean
}
export type InvitationTarget = InvitationRevision & { legacyJoinOnly: boolean }
type LegacyMeetingHint = {
  navigationOnly: true
  legacyJoinOnly: true
  joinOnly: true
  details: Parsed['details']
  embeddedSlots: readonly string[]
}
type CalendarSubject = InvitationTarget | LegacyMeetingHint
type LegacyMeeting = CalendarMeetingFacts & {
  kind: 'meeting'
  organizer: NonNullable<Parsed['details']['organizer']>
  recurring: boolean
  onCalendar: (locator: string) => boolean
  canNavigate: () => boolean
  navigation: () => Promise<InvitationNavigation>
}
type CalendarRefusal = Exclude<CalendarLookup, InvitationCalendarCopy>

type NavigationProof = {
  uid: string
  organizer: string
  classify: (event: RawEvent) => CancellationClassification
  legacyJoinOnly?: boolean
}

const CALENDAR_PAGE_LIMIT = 10

type CollectionKind = 'calendar#events' | 'calendar#calendarList'
type CollectionPage<T> = { items?: T[]; nextPageToken?: string; accessRole?: unknown }

class InvalidCalendarCollection extends Error {}

type ReadableCalendarRole = 'reader' | 'writer' | 'owner'
type CalendarRole = ReadableCalendarRole | 'unreadable'
type CalendarAccess = {
  readonly role: CalendarRole | undefined
  constrain: (role: CalendarRole) => void
}

function writableRole(role: CalendarAccess['role']): boolean {
  return role === 'writer' || role === 'owner'
}

async function invitationPageItems<T>(
  page: CollectionPage<T>,
  kind: CollectionKind,
  observe?: (item: T) => Promise<void>,
  access?: CalendarAccess,
): Promise<T[]> {
  if (
    !page ||
    typeof page !== 'object' ||
    Array.isArray(page) ||
    !('kind' in page) ||
    page.kind !== kind ||
    (page.items !== undefined && !Array.isArray(page.items))
  )
    throw new InvalidCalendarCollection('Invalid Calendar collection')
  const items = page.items ?? []
  // Independently identified resources remain existence evidence even if a
  // sibling, page token, or later request prevents using the collection.
  if (observe) for (const item of items) if (isCollectionRow(item)) await observe(item)
  // An omitted role supplies no permission evidence. An explicit role on the
  // Events page can show that access was lost since CalendarList was read.
  if (kind === 'calendar#events' && 'accessRole' in page) {
    const role = readableRole(page.accessRole) ? page.accessRole : 'unreadable'
    access?.constrain(role)
    if (role === 'unreadable')
      throw new InvalidCalendarCollection('Calendar page does not establish event read access')
  }
  return items
}

function invitationPageToken(page: CollectionPage<unknown>): string | undefined {
  const token = page.nextPageToken
  if (token !== undefined && (typeof token !== 'string' || !/^[^\s\p{Cc}]{1,4096}$/u.test(token)))
    throw new InvalidCalendarCollection('Invalid Calendar page token')
  return token
}

function isCollectionRow(item: unknown): boolean {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item))
}

async function invitationPages<T>(
  api: CalendarReadApi,
  url: string,
  kind: CollectionKind,
  params: GoogleParams,
  observe?: (item: T) => Promise<void>,
  access?: CalendarAccess,
): Promise<T[]> {
  const all: T[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  for (let index = 0; index < CALENDAR_PAGE_LIMIT; index++) {
    const page = await api.get<CollectionPage<T>>(url, { ...params, pageToken })
    const items = await invitationPageItems(page, kind, observe, access)
    if (!items.every(isCollectionRow))
      throw new InvalidCalendarCollection('Invalid Calendar collection row')
    all.push(...items)
    pageToken = invitationPageToken(page)
    if (pageToken === undefined) return all
    if (seen.has(pageToken)) throw new InvalidCalendarCollection('Calendar repeated a page token')
    seen.add(pageToken)
  }
  throw new InvalidCalendarCollection('Calendar returned too many pages')
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
function calendarLocatorMayMatchScope(
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

export function relevantCalendarTargets(
  locators: CalendarLocator[],
  target: { accountSub: string; email: string },
  details: Parsed['details'],
): Set<string> {
  const { uid } = details.identity
  return new Set(
    locators.flatMap((copy) =>
      copy.accountSub === target.accountSub &&
      copy.uid === uid &&
      (copy.organizer === undefined || copy.organizer === details.organizer?.email) &&
      calendarLocatorMayMatchScope(copy, details.identity) &&
      (calendarTargetMailbox(copy.target) ?? target.email) === target.email
        ? [copy.target]
        : [],
    ),
  )
}

class UnverifiedCalendarCancellation extends Error {}

function isUidlessCancellation(event: RawEvent): boolean {
  return event.iCalUID === undefined && event.status === 'cancelled'
}

// A bound query can associate a sparse row with an invitation for
// absence checks, but never supplies fields to the event itself.
type QueryAssociation = { uid: string; mailbox: string } & (
  { kind: 'uid' } | { kind: 'parent'; parentId: string }
)

type ObserveEvent = (event: RawEvent, association?: QueryAssociation) => Promise<void>
type CancellationObservation = 'association-only' | 'legacy-association-only'

function observeUidQuery(
  uid: string,
  observe: ObserveEvent,
  binding?: { mailbox: string; primary: boolean; parentId?: string },
) {
  return async (event: RawEvent) => {
    if (event.iCalUID === uid) return observe(event)
    if (!binding || event.iCalUID !== undefined) return
    const { mailbox, primary, parentId } = binding
    // Expanded UID queries can omit the UID of an active child. A verified
    // parent binds that row only as a possible copy.
    if (parentId !== undefined && event.recurringEventId === parentId)
      await observe(event, { kind: 'parent', uid, mailbox, parentId })
    else if (primary && isUidlessCancellation(event))
      await observe(event, { kind: 'uid', uid, mailbox })
  }
}

async function exactCopies(
  api: CalendarReadApi,
  url: string,
  identity: Parsed['details']['identity'],
  floating: boolean,
  context: {
    organizer: string | undefined
    bindsResponseParent: (event: RawEvent) => boolean
    bindsLegacyParent: ((event: RawEvent) => boolean) | null
    navigationOnly: boolean
    mailbox: string
    primary: boolean
    includeHiddenInvitations: boolean
    classifyCancellation: (event: RawEvent) => CancellationClassification
    observeCancellation: (event: RawEvent, proof?: CancellationObservation) => void
  },
  observe: ObserveEvent,
  access: CalendarAccess,
) {
  let verifiedParent: RawEvent | undefined
  let verifiedResponseParentId: string | undefined
  const result = (events: RawEvent[]) => ({ events, verifiedParent, verifiedResponseParentId })
  const { uid, recurrenceId, sequence } = identity
  let sawCancellation = false
  const observeCandidate = (event: RawEvent) => {
    if (sawCancellation) return
    const classification = context.classifyCancellation(event)
    sawCancellation = classification === 'current' || classification === 'unverified'
  }
  const invalid = (message: string): never => {
    if (sawCancellation) throw new UnverifiedCalendarCancellation()
    throw new InvalidCalendarCollection(message)
  }
  const incomplete = (error: unknown): never => {
    if (
      sawCancellation &&
      !(error instanceof CalendarObservationError) &&
      !propagateCalendarRefusal(error)
    )
      throw new UnverifiedCalendarCancellation()
    throw error
  }
  const observeListed = observeUidQuery(uid, observe, context)
  const events = await invitationPages<RawEvent>(
    api,
    url,
    'calendar#events',
    {
      iCalUID: uid,
      singleEvents: 'false',
      showDeleted: 'true',
      // events.list hides invitations by default, even on a visible calendar.
      // RSVP needs those copies; legacy navigation keeps the provider default.
      showHiddenInvitations: context.includeHiddenInvitations ? 'true' : undefined,
    },
    async (event) => {
      await observeListed(event)
      observeCandidate(event)
    },
    access,
  ).catch(incomplete)
  if (
    events.some(
      (event) =>
        !usableInvitationEvent(event) || (event.iCalUID !== uid && !isUidlessCancellation(event)),
    )
  )
    invalid('Invalid Calendar events for this invitation')
  const listedIds = new Set(events.map(({ id }) => id))
  if (listedIds.size !== events.length) invalid('Calendar returned duplicate event rows')
  if (!readableRole(access.role)) invalid('Calendar could not verify event read access')
  // Do not discard exception tombstones when preferring a master for RSVP.
  // Only validated collection rows qualify here. Observation above retains
  // possible locators without using the query itself as cancellation proof.
  for (const event of events) context.observeCancellation(event)
  // The unexpanded list contains the series master and sometimes exception
  // rows. No recurrence ID means the master, not any expanded occurrence.
  const possible = events.filter((event) =>
    calendarLocatorMayMatchScope(eventLocatorScope(event), identity),
  )
  const roots = possible.filter((event) => !event.recurringEventId && !event.originalStartTime)
  // Any row for a floating series could occupy this wall-clock slot. An
  // empty UID collection is still meaningful; never query instances in a guessed zone.
  if (floating) return result(possible)
  const requireScope = (copies: RawEvent[]) => {
    // Even rows ruled out as locators don't make a nonempty list proof of absence.
    if (events.length && !copies.length)
      throw new Error('Calendar returned events but could not verify this recurrence scope')
    return copies
  }
  if (recurrenceId === null) return result(requireScope(roots))
  const cancelledRoots = roots.filter(
    (root) => root.status === 'cancelled' && context.classifyCancellation(root) !== 'irrelevant',
  )
  const activeRoots = roots.filter((root) => root.status !== 'cancelled')
  if (activeRoots.length > 1) invalid('Calendar returned ambiguous series rows')
  const verifiedInstances = new Set<string | undefined>()
  const matching = new Map(
    possible
      .filter((event) => sameOccurrence(event, recurrenceId))
      .map((event) => [event.id, event]),
  )
  for (const series of activeRoots) {
    if (!series.id || !series.recurrence?.length) continue
    const coherentParent =
      series.iCalUID === uid &&
      coherentEventTimes(series) &&
      (series.start?.date !== undefined) === date(recurrenceId) &&
      recurrenceSet(series.recurrence) !== null
    const responseParent = coherentParent && context.bindsResponseParent(series)
    const legacyParent = coherentParent && context.bindsLegacyParent?.(series)
    const responseParentVerified = responseParent && (series.sequence ?? 0) === sequence
    // Read access can prove a legacy parent for navigation, not a response locator.
    const parentVerified =
      responseParentVerified ||
      (legacyParent && (context.navigationOnly || (series.sequence ?? 0) === sequence))
    // Unmodified instances do not appear in events.list. Query for the original
    // start (not timeMin or the displayed start, which miss moved occurrences).
    const parentId = series.id
    if (parentVerified) verifiedParent = series
    if (responseParentVerified) verifiedResponseParentId = parentId
    const instances = await invitationPages<RawEvent>(
      api,
      `${url}/${encodeURIComponent(parentId)}/instances`,
      'calendar#events',
      {
        originalStart: recurrenceId,
        showDeleted: 'true',
      },
      async (event) => {
        if (event.recurringEventId === parentId) {
          observeCandidate(event)
          // The row must match this exact original-slot request. Its parent
          // still has to be independently verified before it can affect Join.
          const original = event.originalStartTime
          if (
            (responseParent || legacyParent) &&
            validTime(original) &&
            sameOccurrence(event, recurrenceId)
          )
            context.observeCancellation(
              event,
              responseParent ? 'association-only' : 'legacy-association-only',
            )
        }
        // A fully identified child proves possible existence independently of
        // the queried parent. Record the row's own scope before validating the
        // collection; a wrong parent still makes this read inconclusive.
        const address = event.organizer?.email
        const organizer =
          typeof address === 'string' && address.trim() ? address.toLowerCase() : undefined
        if (
          event.iCalUID === uid &&
          organizer !== undefined &&
          organizer === context.organizer &&
          mailboxAttendee(event, context.mailbox)
        )
          return observe(event)
        if (event.recurringEventId !== parentId) return
        if (event.iCalUID === uid && organizer !== undefined) await observe(event)
        else if (
          (event.iCalUID === undefined || event.iCalUID === uid) &&
          ((responseParentVerified && mailboxAttendee(event, context.mailbox)) ||
            (responseParent &&
              context.primary &&
              event.attendees === undefined &&
              event.status === 'cancelled'))
        )
          await observe(event, {
            kind: 'parent',
            uid,
            mailbox: context.mailbox,
            parentId,
          })
      },
      access,
    ).catch(incomplete)
    if (new Set(instances.map(({ id }) => id)).size !== instances.length)
      invalid('Calendar returned duplicate instance rows')
    if (
      instances.some(
        (event) =>
          !usableInvitationEvent(event) ||
          (event.iCalUID !== undefined && event.iCalUID !== uid) ||
          event.recurringEventId !== series.id ||
          !sameOccurrence(event, recurrenceId),
      )
    ) {
      // Wrong-parent rows were observed as locators but cannot prove a
      // cancellation (or a live instance) of this parent.
      invalid('Invalid Calendar instance for this invitation')
    }
    for (const event of instances) context.observeCancellation(event)
    for (const event of instances) {
      const listed = matching.get(event.id)
      if (
        listedIds.has(event.id) &&
        (!listed || listed.etag !== event.etag || calendarProof(listed) !== calendarProof(event))
      )
        invalid('Calendar returned conflicting instance rows')
      matching.set(event.id, event)
      if (parentVerified) verifiedInstances.add(event.id)
    }
  }
  const matches = [...matching.values()]
  // A root may cover an occurrence even when Google removed its recurrence
  // rules. A different recurringEventId on a listed row is not evidence that
  // the cancellation is unrelated. Only a corroborated current parent and
  // older, distinct tombstones can disambiguate it for RSVP or navigation.
  if (!matches.length) return result(requireScope(cancelledRoots))
  const cancelledParents = cancelledRoots.filter((root) =>
    matches.some((instance) => instance.recurringEventId === root.id),
  )
  if (cancelledParents.length) return result([...cancelledParents, ...matches])
  if (
    cancelledRoots.length &&
    (matches.length !== 1 ||
      !verifiedInstances.has(matches[0]!.id) ||
      cancelledRoots.some((root) => context.classifyCancellation(root) !== 'older'))
  )
    throw new UnverifiedCalendarCancellation()
  return result(matches)
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

/** CalendarList (including exact rechecks) and Events pages constrain access
 * within this read. Later evidence cannot restore permissions in the same snapshot. */
export function createInvitationCalendarDiscovery(api: CalendarReadApi, mailbox: string) {
  let snapshot: Promise<CalendarListEntry[]> | undefined
  const roles = new Map<string, CalendarRole>()
  const order: CalendarRole[] = ['unreadable', 'reader', 'writer', 'owner']
  let primaryBase: string | undefined
  const key = (base: string) => (base === primaryBase ? PRIMARY_EVENTS : base)
  // Current-read negative evidence only. Keep the newest bound tombstone per
  // original slot, and keep sparse uncertainty separate: no revision order
  // can be inferred for a row that cannot prove its own cancellation.
  const cancellationEvidence = () => ({
    full: new Map<string, RawEvent>(),
    sparse: new Set<string>(),
  })
  const responseCancellations = cancellationEvidence()
  const legacyCancellations = cancellationEvidence()
  const occurrenceKey = (
    base: string,
    parentId: string,
    uid: string | undefined,
    organizer: string | undefined,
    slot: string,
  ) => JSON.stringify([key(base), parentId, uid, organizer, slot])
  function observeOccurrenceCancellation(
    base: string,
    row: RawEvent,
    proof?: CancellationObservation,
  ) {
    if (
      !row.recurringEventId ||
      !validCancellation(row) ||
      (row.iCalUID !== undefined && typeof row.iCalUID !== 'string')
    )
      return
    const { iCalUID: uid, sequence, attendees } = row
    const organizer = row.organizer?.email?.toLowerCase()
    const slot = occurrenceKey(base, row.recurringEventId, uid, organizer, occurrenceSlot(row)!)
    const sparse = uid === undefined || organizer === undefined || sequence === undefined
    const keepNewest = (full: Map<string, RawEvent>) => {
      // A verified newer live occurrence can supersede an older full tombstone.
      const prior = full.get(slot)
      if (!prior || sequence! > prior.sequence!) full.set(slot, row)
    }
    // A legacy read compares Calendar's own resources, not a received iTIP actor.
    // Even then, a sparse row can only withhold a verified parent's original slot.
    if (sparse) legacyCancellations.sparse.add(slot)
    else if (!proof) keepNewest(legacyCancellations.full)

    if (proof === 'legacy-association-only' || row.organizer?.self === true) return
    if (sparse || attendees === undefined) {
      if (attendees === undefined || mailboxAttendee(row, mailbox))
        responseCancellations.sparse.add(slot)
    } else if (!proof && provesCancellationActor(row, mailbox)) {
      keepNewest(responseCancellations.full)
    }
  }
  function access(base: string): CalendarAccess {
    return {
      get role() {
        return roles.get(key(base))
      },
      constrain(role) {
        const previous = this.role
        if (previous === undefined || order.indexOf(role) < order.indexOf(previous))
          roles.set(key(base), role)
      },
    }
  }
  function observeEntry(calendar: CalendarListEntry): CalendarAccess | null {
    const base = calendarEventsUrl(calendar.id)
    if (calendar.primary) {
      if (primaryBase && primaryBase !== base) return null
      const previous = roles.get(base)
      primaryBase = base
      if (previous !== undefined) access(PRIMARY_EVENTS).constrain(previous)
    }
    const observation = access(base)
    constrainCalendarEntry(observation, calendar)
    return observation
  }
  return {
    access,
    observeEntry,
    observeOccurrenceCancellation,
    suppressesOccurrence(
      base: string,
      parentId: string,
      slot: string,
      { uid, organizer, classify, legacyJoinOnly }: NavigationProof,
      bindsSparseChild: boolean,
    ) {
      const evidence = legacyJoinOnly ? legacyCancellations : responseCancellations
      // Only the verified master associates sparse rows with this invitation,
      // and only for navigation. Do not infer UID, organizer, self or revision
      // for the child resource, even if the expanded view still shows it live.
      if (bindsSparseChild) {
        for (const childUid of [uid, undefined]) {
          for (const address of [organizer, undefined]) {
            if (evidence.sparse.has(occurrenceKey(base, parentId, childUid, address, slot)))
              return true
          }
        }
      }
      const event = evidence.full.get(occurrenceKey(base, parentId, uid, organizer, slot))
      if (!event) return false
      const cancellation = classify(event)
      return cancellation === 'current' || cancellation === 'unverified'
    },
    onCalendar(target: string, base: string) {
      const resource = calendarTargetResource(target, mailbox)
      return resource !== null && key(calendarEventsUrl(resource.id)) === key(base)
    },
    sameCalendar(first: string, second: string) {
      const a = calendarTargetResource(first, mailbox)
      const b = calendarTargetResource(second, mailbox)
      return (
        a !== null && b !== null && key(calendarEventsUrl(a.id)) === key(calendarEventsUrl(b.id))
      )
    },
    canEditTarget(target: string, mailbox: string) {
      const resource = calendarTargetResource(target, mailbox)
      return resource !== null && writableRole(access(calendarEventsUrl(resource.id)).role)
    },
    calendars() {
      return (snapshot ??= invitationPages<CalendarListEntry>(
        api,
        `${BASE}/users/me/calendarList`,
        'calendar#calendarList',
        { minAccessRole: 'reader', showDeleted: 'false', showHidden: 'true' },
      ))
    },
  }
}

type CalendarDiscovery = ReturnType<typeof createInvitationCalendarDiscovery>

function calendarEventsUrl(id: string): string {
  return `${BASE}/calendars/${encodeURIComponent(id)}/events`
}

function constrainCalendarEntry(access: CalendarAccess, calendar: CalendarListEntry) {
  access.constrain(
    calendar.deleted !== true && readableRole(calendar.accessRole)
      ? calendar.accessRole
      : 'unreadable',
  )
}

function validCalendar(calendar: CalendarListEntry): boolean {
  return (
    (calendar.kind === undefined || calendar.kind === 'calendar#calendarListEntry') &&
    safeCalendarId(calendar.id) &&
    (calendar.primary === undefined || typeof calendar.primary === 'boolean') &&
    (calendar.deleted === undefined || typeof calendar.deleted === 'boolean') &&
    (calendar.deleted === true ||
      readableCalendar(calendar) ||
      calendar.accessRole === 'freeBusyReader')
  )
}

function readableRole(accessRole: unknown): accessRole is ReadableCalendarRole {
  return accessRole === 'owner' || accessRole === 'writer' || accessRole === 'reader'
}

function readableCalendar({ deleted, accessRole }: CalendarListEntry): boolean {
  return deleted !== true && readableRole(accessRole)
}

function primaryCalendar(calendars: CalendarListEntry[]): CalendarListEntry | undefined {
  const primary = calendars.filter(({ primary }) => primary === true)
  const [entry] = primary
  if (
    primary.length > 1 ||
    (entry && (!validCalendar(entry) || calendars.filter(({ id }) => id === entry.id).length !== 1))
  )
    throw new InvalidCalendarCollection('Invalid primary Calendar list entry')
  return entry
}

/** RSVP lookup is independent of agenda visibility, dates and RSVP state. */
export function findInvitationCalendarCopy(
  api: CalendarReadApi,
  invitation: LegacyMeetingHint,
  mailbox: string,
  remember: null,
  readCalendarOverrides: () => Promise<CalendarOverrides>,
  discovery: CalendarDiscovery,
): Promise<LegacyMeeting | CalendarRefusal>
export function findInvitationCalendarCopy(
  api: CalendarReadApi,
  invitation: InvitationTarget,
  mailbox: string,
  remember: (locator: Omit<CalendarLocator, 'accountSub'>) => Promise<void>,
  readCalendarOverrides: () => Promise<CalendarOverrides>,
  discovery: CalendarDiscovery,
): Promise<CalendarLookup>
export async function findInvitationCalendarCopy(
  api: CalendarReadApi,
  invitation: CalendarSubject,
  mailbox: string,
  remember: ((locator: Omit<CalendarLocator, 'accountSub'>) => Promise<void>) | null,
  readCalendarOverrides: () => Promise<CalendarOverrides>,
  discovery: CalendarDiscovery,
): Promise<CalendarLookup | LegacyMeeting> {
  try {
    return await lookupInvitationCalendarCopy(
      api,
      invitation,
      mailbox,
      async (locator) => {
        try {
          await remember?.(locator)
        } catch (cause) {
          throw new CalendarObservationError('Could not retain a Calendar locator', { cause })
        }
      },
      readCalendarOverrides,
      discovery,
    )
  } catch (error) {
    if (error instanceof CalendarObservationError) throw error.cause
    if (error instanceof UnverifiedCalendarCancellation) return unverifiedCancellation()
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
  api: CalendarReadApi,
  invitation: CalendarSubject,
  mailbox: string,
  remember: (locator: Omit<CalendarLocator, 'accountSub'>) => Promise<void>,
  readCalendarOverrides: () => Promise<CalendarOverrides>,
  discovery: CalendarDiscovery,
): Promise<CalendarLookup | LegacyMeeting> {
  const navigationOnly = 'navigationOnly' in invitation
  const { legacyJoinOnly } = invitation
  const { identity } = invitation.details
  const { uid, recurrenceId } = identity
  const organizer = invitation.details.organizer?.email
  const classify = (event: RawEvent) =>
    navigationOnly
      ? classifyLegacyCancellation(event, identity, organizer)
      : legacyJoinOnly
        ? classifyLegacyCancellation(event, identity, organizer, identity.sequence)
        : classifyCancellation(event, invitation, mailbox)
  const lookupContext = (base: string, ownedCalendar?: () => string | undefined) => ({
    organizer,
    mailbox,
    primary: base === PRIMARY_EVENTS,
    classifyCancellation: classify,
    observeCancellation: (event: RawEvent, proof?: CancellationObservation) =>
      discovery.observeOccurrenceCancellation(base, event, proof),
    includeHiddenInvitations: !legacyJoinOnly,
    navigationOnly,
    bindsLegacyParent: legacyJoinOnly
      ? (event: RawEvent) =>
          readableRole(discovery.access(base).role) && Boolean(legacyOrganizer(event, organizer))
      : null,
    bindsResponseParent: (event: RawEvent) =>
      !navigationOnly &&
      Boolean(
        organizer &&
        event.organizer?.email?.toLowerCase() === organizer &&
        (mailboxAttendee(event, mailbox) ||
          (invitation.joinOnly &&
            event.organizer?.self &&
            (organizer === mailbox || organizer === ownedCalendar?.()))),
      ),
  })
  const observeCopy =
    (base: string, calendarId?: string, owned = false) =>
    async (event: RawEvent, association?: QueryAssociation) => {
      if (navigationOnly || !hasEventResourceId(event)) return
      const observedAddress = event.organizer?.email
      const observedOrganizer =
        typeof observedAddress === 'string' && observedAddress.trim()
          ? observedAddress.toLowerCase()
          : undefined
      // On the authenticated primary calendar, an exact-UID row with no
      // organizer address is possible existence evidence, whatever its status.
      // For a UID-less row, only the bound query can attest possible existence.
      const associated =
        event.iCalUID === undefined &&
        association?.uid === uid &&
        association.mailbox === mailbox &&
        (association.kind === 'uid'
          ? isUidlessCancellation(event)
          : association.parentId === event.recurringEventId)
      if (observedOrganizer !== undefined && observedOrganizer !== organizer) return
      // The authenticated primary collection itself binds the resource to the
      // mailbox. Elsewhere, require the provider's self marker, not just an
      // attendee address on a shared calendar's copy.
      if (base === PRIMARY_EVENTS) {
        if (event.iCalUID !== uid && !associated) return
      } else if (!observedOrganizer || event.iCalUID === undefined) {
        // Sparse secondary rows need both a UID (or verified parent association)
        // and an unambiguous self attendee for the authenticated mailbox. An
        // owned calendar ID is not in itself an alias for that mailbox.
        if (
          (event.iCalUID !== uid && !(associated && association.kind === 'parent')) ||
          !mailboxAttendee(event, mailbox)
        )
          return
      } else {
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
      // Retain the event's own scope, even if the current request is for a
      // different occurrence. Filter by scope when using the locator instead.
      await remember({
        uid,
        // For a sparse secondary child this is the scope of the negative
        // association, not a claim about the organizer in the event payload.
        organizer:
          observedOrganizer ?? (associated && base !== PRIMARY_EVENTS ? organizer : undefined),
        ...eventLocatorScope(event),
        series,
        target: calendarCopyTarget(calendarResponseUrl(base, event), mailbox),
      })
    }
  const series = recurrenceId === null && invitation.details.recurring
  const fields = navigationOnly ? null : invitation.fields
  const floating =
    fields?.recurrenceKind === 'floating' ||
    (series && fields?.recurrenceTimeBasis?.kind === 'floating')
  const unmatchable = {
    kind: 'blocked',
    reason: 'Calendar cannot verify a floating recurrence',
  } as const
  const ambiguous = {
    kind: 'blocked',
    reason: 'More than one Calendar event matches this invitation',
  } as const
  const overrides = legacyJoinOnly ? await readCalendarOverrides() : null
  const enabled = (calendar: CalendarListEntry) => {
    if (overrides === null) return true
    if (
      (calendar.selected !== undefined && typeof calendar.selected !== 'boolean') ||
      (calendar.hidden !== undefined && typeof calendar.hidden !== 'boolean')
    )
      throw new InvalidCalendarCollection('Invalid Calendar visibility')
    return calendarIsEnabledForLegacyMail(calendar, overrides)
  }
  let sawIneligibleCopy = false
  const navigationCandidates = (events: RawEvent[]) => {
    if (!legacyJoinOnly) return events
    // exactCopies has already observed resources, including those that will
    // never supply links. Ineligibility is not proof of absence.
    const candidates = events.filter(
      (event) =>
        isAgendaEventVisible(event) ||
        // A master still binds expanded occurrences. Their self status
        // determines Join, not the status on the series template.
        ((series || (navigationOnly && recurrenceId === null)) &&
          event.status !== 'cancelled' &&
          event.recurrence?.length),
    )
    if (candidates.length !== events.length) sawIneligibleCopy = true
    return candidates
  }
  function selectCopy(
    { events, verifiedParent, verifiedResponseParentId }: Awaited<ReturnType<typeof exactCopies>>,
    base: string,
    access: CalendarAccess,
    observe: ObserveEvent,
    calendar?: CalendarListEntry,
  ): CalendarLookup | LegacyMeeting | undefined {
    const calendarId = base === PRIMARY_EVENTS ? undefined : calendar?.id.toLowerCase()
    const canRead = () =>
      readableRole(access.role) &&
      (!legacyJoinOnly || (calendar && enabled({ ...calendar, accessRole: access.role })) === true)
    if (legacyJoinOnly && !canRead()) return undefined
    // Classify negative evidence independently of the preference for a live
    // resource. An older or unrelated tombstone conveys no current status.
    const live = events.filter(({ status }) => status !== 'cancelled')
    const boundChild =
      legacyJoinOnly &&
      verifiedParent?.id &&
      live.length === 1 &&
      live[0]?.recurringEventId === verifiedParent.id
        ? live[0]
        : undefined
    let unverified = false
    for (const event of events) {
      if (boundChild && event.recurringEventId && event.recurringEventId !== verifiedParent?.id)
        continue
      const cancellation = boundChild
        ? classifyLegacyCancellation(
            event,
            identity,
            organizer ?? calendarOrganizer(boundChild),
            boundChild.sequence ?? 0,
          )
        : classify(event)
      if (cancellation === 'current')
        return {
          kind: 'blocked',
          reason: 'This Calendar event was cancelled',
          cancelled: true,
          navigationUnverified: true,
        }
      if (cancellation === 'unverified') unverified = true
    }
    if (unverified) return unverifiedCancellation()
    const candidates = navigationCandidates(events)
    const active = candidates.filter(({ status }) => status !== 'cancelled')
    if (floating && active.length) return unmatchable
    if (active.length > 1) return ambiguous
    if (active[0])
      return navigationOnly
        ? legacyMeeting(
            api,
            base,
            active[0],
            invitation,
            access,
            canRead,
            discovery,
            verifiedParent,
          )
        : invitationCopy(api, base, active[0], invitation, mailbox, access, observe, discovery, {
            calendarId,
            canRead,
            verifiedParent,
            verifiedResponseParentId,
          })
    if (candidates.length)
      return { kind: 'blocked', reason: 'Calendar could not verify a current invitation copy' }
  }
  const calendars = await discovery.calendars()
  const declaredPrimary = primaryCalendar(calendars)
  // The primary alias binds the mailbox, not a permission level.
  // Apply CalendarList evidence even when the primary query finds the copy.
  if (declaredPrimary) discovery.observeEntry(declaredPrimary)
  if (
    !legacyJoinOnly ||
    (declaredPrimary && readableCalendar(declaredPrimary) && enabled(declaredPrimary))
  ) {
    const access = discovery.access(PRIMARY_EVENTS)
    const observePrimary = observeCopy(PRIMARY_EVENTS)
    const primary = await exactCopies(
      api,
      PRIMARY_EVENTS,
      identity,
      floating,
      lookupContext(PRIMARY_EVENTS),
      observePrimary,
      access,
    )
    const found = selectCopy(primary, PRIMARY_EVENTS, access, observePrimary, declaredPrimary)
    if (found) return found
  }

  let match: CalendarLookup | LegacyMeeting | undefined
  const seen = new Set<string>()
  for (const calendar of calendars) {
    if (!validCalendar(calendar) || seen.has(calendar.id))
      throw new Error('Invalid Calendar list entry')
    seen.add(calendar.id)
    if (calendar.primary || !readableCalendar(calendar) || !enabled(calendar)) continue
    const url = calendarEventsUrl(calendar.id)
    const access = discovery.access(url)
    discovery.observeEntry(calendar)
    const calendarId = calendar.id.toLowerCase()
    const ownedCalendar = () => (access.role === 'owner' ? calendarId : undefined)
    const observe = observeCopy(url, calendar.id.toLowerCase(), calendar.accessRole === 'owner')
    const copies = await exactCopies(
      api,
      url,
      identity,
      floating,
      lookupContext(url, ownedCalendar),
      observe,
      access,
    )
    const found = selectCopy(copies, url, access, observe, calendar)
    if (found && match) {
      if ([match, found].some((copy) => copy.kind === 'blocked' && copy.navigationUnverified))
        return { ...ambiguous, navigationUnverified: true }
      return ambiguous
    }
    if (found) match = found
  }
  return (
    match ??
    (sawIneligibleCopy
      ? { kind: 'blocked', reason: 'This Calendar copy is not visible for this meeting' }
      : { kind: 'absent' })
  )
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
  return typeof self?.email === 'string' &&
    self.email.toLowerCase() === mailbox &&
    (self.resource === undefined || self.resource === false) &&
    event.attendees?.filter(
      ({ email }) => typeof email === 'string' && email.toLowerCase() === mailbox,
    ).length === 1
    ? self
    : undefined
}

type CancellationClassification = 'irrelevant' | 'unverified' | 'older' | 'current'

function unverifiedCancellation(): CalendarLookup {
  return {
    kind: 'blocked',
    reason: 'Calendar could not verify the cancellation of this invitation',
    navigationUnverified: true,
  }
}

function validCancellationTimes(event: RawEvent): boolean {
  return (
    (event.start === undefined &&
      event.end === undefined &&
      (event.endTimeUnspecified === undefined || event.endTimeUnspecified === false)) ||
    coherentEventTimes(event)
  )
}

/** A tombstone may omit start/end and recurrence rules, but anything supplied
 * must be consistent with its own scope. */
function validCancellation(event: RawEvent): boolean {
  return (
    event.status === 'cancelled' &&
    usableInvitationEvent(event) &&
    (!event.recurrence?.length ||
      (event.recurringEventId === undefined && recurrenceSet(event.recurrence) !== null)) &&
    validCancellationTimes(event)
  )
}

/** Query associations, calendar IDs and shared visibility do not establish
 * whose cancellation this is. Require the actual mailbox's self attendee. */
function provesCancellationActor(event: RawEvent, mailbox: string): boolean {
  return (
    mailbox !== event.organizer?.email?.toLowerCase() &&
    Boolean(mailboxAttendee(event, mailbox)) &&
    (event.attendeesOmitted === undefined || event.attendeesOmitted === false)
  )
}

function boundCancellation(event: RawEvent, { details }: InvitationRevision, mailbox: string) {
  return (
    validCancellation(event) &&
    event.organizer?.self !== true &&
    event.iCalUID === details.identity.uid &&
    Boolean(details.organizer?.email) &&
    event.organizer?.email?.toLowerCase() === details.organizer?.email &&
    event.sequence !== undefined &&
    provesCancellationActor(event, mailbox)
  )
}

function classifyCancellation(
  event: RawEvent,
  invitation: InvitationRevision,
  mailbox: string,
  expandedSlot?: string,
): CancellationClassification {
  const { details } = invitation
  const { uid, recurrenceId, sequence } = details.identity
  const expectedSlot = expandedSlot ?? recurrenceId
  const { recurrenceId: actualSlot, occurrenceUnverified } = eventLocatorScope(event)
  const isOccurrence = actualSlot !== null || occurrenceUnverified === true
  const organizer = event.organizer?.email
  const self = uniqueSelfAttendee(event)?.email
  if (
    event.status !== 'cancelled' ||
    (event.iCalUID !== undefined && event.iCalUID !== uid) ||
    (typeof organizer === 'string' &&
      organizer.trim() &&
      organizer.toLowerCase() !== details.organizer?.email) ||
    (typeof self === 'string' && self.trim() && self.toLowerCase() !== mailbox) ||
    (expectedSlot === null && isOccurrence) ||
    (expectedSlot !== null && actualSlot !== null && distinctSlots(actualSlot, expectedSlot))
  )
    return 'irrelevant'
  if (
    !boundCancellation(event, invitation, mailbox) ||
    (isOccurrence && (expectedSlot === null || !sameOccurrence(event, expectedSlot)))
  )
    return 'unverified'
  // Roots also cover their occurrences. A missing RRULE on a deleted root
  // cannot distinguish a standalone tombstone from a cancelled series.
  if (expectedSlot === null && !details.recurring && event.recurrence?.length) return 'irrelevant'
  if (event.sequence! < sequence) return 'older'
  // Calendar's `updated` is not an iTIP stamp. A strictly newer cancellation
  // need not match obsolete live material. At the same sequence, compare
  // only like scopes; master details do not describe a child's material.
  if (
    event.sequence === sequence &&
    (isOccurrence ? recurrenceId !== null : recurrenceId === null) &&
    calendarRevisionMismatch(event, invitation, invitationEventLinks(event))
  )
    return 'unverified'
  return 'current'
}

function calendarOrganizer(event: RawEvent) {
  return typeof event.organizer?.email === 'string' && event.organizer.email.trim()
    ? event.organizer.email.toLowerCase()
    : undefined
}

function legacyOrganizer(event: RawEvent, expected?: string) {
  const actual = calendarOrganizer(event)
  return expected === undefined || actual === expected ? actual : undefined
}

function legacySlotIsSuppressed(
  discovery: CalendarDiscovery,
  base: string,
  parentId: string,
  slot: string,
  live: RawEvent,
  uid: string,
  organizer: string,
): boolean {
  return discovery.suppressesOccurrence(
    base,
    parentId,
    slot,
    {
      uid,
      organizer,
      legacyJoinOnly: true,
      // Compare Calendar revisions, never the stamp in a UID-only export.
      classify: (row) => ((row.sequence ?? 0) < (live.sequence ?? 0) ? 'older' : 'unverified'),
    },
    true,
  )
}

function classifyLegacyCancellation(
  event: RawEvent,
  { uid, recurrenceId }: Parsed['details']['identity'],
  organizer?: string,
  sequence?: number,
): CancellationClassification {
  const { recurrenceId: slot, occurrenceUnverified } = eventLocatorScope(event)
  const address = calendarOrganizer(event)
  if (
    event.status !== 'cancelled' ||
    (event.iCalUID !== undefined && event.iCalUID !== uid) ||
    (organizer !== undefined && address !== undefined && address !== organizer) ||
    (recurrenceId === null
      ? slot !== null || occurrenceUnverified
      : slot !== null && distinctSlots(slot, recurrenceId))
  )
    return 'irrelevant'
  // Legacy mail cannot establish an attendee cancellation. A full tombstone
  // can age out, but any applicable newer or sparse row only withholds links.
  return sequence !== undefined &&
    event.sequence !== undefined &&
    event.sequence < sequence &&
    event.iCalUID === uid &&
    organizer !== undefined &&
    address === organizer &&
    validCancellation(event)
    ? 'older'
    : 'unverified'
}

function legacyMeeting(
  api: CalendarReadApi,
  base: string,
  event: RawEvent,
  hint: LegacyMeetingHint,
  access: CalendarAccess,
  canNavigate: () => boolean,
  discovery: CalendarDiscovery,
  verifiedParent?: RawEvent,
): LegacyMeeting | CalendarRefusal {
  const { uid, recurrenceId } = hint.details.identity
  const organizer = legacyOrganizer(event, hint.details.organizer?.email)
  const recurring = recurrenceId === null && Boolean(event.recurrence?.length)
  const parentId = verifiedParent?.id
  if (
    event.iCalUID !== uid ||
    !organizer ||
    !coherentEventTimes(event) ||
    (recurring && recurrenceSet(event.recurrence!) === null) ||
    (recurrenceId === null && hint.details.recurring && !recurring) ||
    (recurrenceId !== null &&
      (!verifiedParent ||
        !parentId ||
        event.recurringEventId !== parentId ||
        calendarOrganizer(verifiedParent) !== organizer))
  )
    return { kind: 'blocked', reason: 'Calendar could not verify this meeting' }

  const observe = async () => {} // A navigation hint must not register durable response locators.
  const suppressed = (master: string, slot: string, live: RawEvent) =>
    legacySlotIsSuppressed(discovery, base, master, slot, live, uid, organizer)
  const name = event.organizer?.displayName
  const links = invitationEventLinks(event)
  return {
    kind: 'meeting',
    organizer: { email: organizer, ...(typeof name === 'string' && name.trim() ? { name } : {}) },
    recurring,
    title: event.summary,
    start: event.start?.date ?? event.start?.dateTime,
    end: event.end?.date ?? event.end?.dateTime,
    allDay: event.start?.date !== undefined,
    location: event.location,
    ...links,
    htmlLink: isAgendaEventVisible(event) ? links.htmlLink : null,
    onCalendar: (locator) => discovery.onCalendar(locator, base),
    canNavigate,
    navigation: async () => {
      if (!canNavigate()) return { kind: 'withheld' }
      if (recurring) {
        const upcoming = await upcomingInvitationLinks(
          api,
          base,
          event,
          uid,
          organizer,
          true,
          observe,
          access,
          (instance, slot) =>
            !hint.embeddedSlots.some((embedded) => !distinctSlots(embedded, slot)) &&
            !suppressed(event.id!, slot, instance),
        )
        return upcoming ? { kind: 'series', links: upcoming } : { kind: 'withheld' }
      }
      if (parentId && recurrenceId && suppressed(parentId, recurrenceId, event))
        return { kind: 'withheld' }
      return (await legacyMeetingIsCurrent(api, base, event, uid, recurrenceId, observe, access))
        ? { kind: 'default' }
        : { kind: 'withheld' }
    },
  }
}

function calendarResponseUrl(base: string, event: RawEvent): string {
  return `${base}/${encodeURIComponent(event.id ?? '')}?sendUpdates=all`
}

function calendarCopyTarget(url: string, mailbox: string): string {
  return JSON.stringify([url, mailbox])
}

function invitationMembership(
  event: RawEvent,
  { fields, joinOnly }: { fields?: CalendarRevisionFields; joinOnly: boolean },
  mailbox: string,
  owned: boolean,
  ownedCalendar?: string,
) {
  const organizer = event.organizer?.email?.toLowerCase()
  const organizes =
    event.organizer?.self === true && (organizer === mailbox || organizer === ownedCalendar)
  const self = joinOnly ? uniqueSelfAttendee(event) : undefined
  const selfEmail = self?.email?.toLowerCase()
  const attendee = joinOnly
    ? selfEmail && (selfEmail === mailbox || selfEmail === ownedCalendar)
      ? self
      : undefined
    : fields?.attendees.includes(mailbox)
      ? mailboxAttendee(event, mailbox)
      : undefined
  return {
    attendee,
    organizes,
    allowed: joinOnly
      ? owned && (organizes || Boolean(attendee && !attendee.resource))
      : !!attendee,
    organizerConflict:
      !joinOnly && (event.organizer?.self || organizer === mailbox || organizer === ownedCalendar),
  }
}

function invitationCopy(
  api: CalendarReadApi,
  base: string,
  event: RawEvent,
  invitation: InvitationTarget,
  mailbox: string,
  access: CalendarAccess,
  observe: ObserveEvent,
  discovery: CalendarDiscovery,
  {
    calendarId,
    canRead,
    verifiedParent,
    verifiedResponseParentId,
  }: {
    calendarId?: string
    canRead: () => boolean
    verifiedParent?: RawEvent
    verifiedResponseParentId?: string
  },
): CalendarLookup {
  const { details, joinOnly, legacyJoinOnly } = invitation
  const ownedCalendar = () => (access.role === 'owner' ? calendarId : undefined)
  const canNavigate = () => canRead() && (legacyJoinOnly || !joinOnly || access.role === 'owner')
  const { attendee, allowed, organizes, organizerConflict } = invitationMembership(
    event,
    invitation,
    mailbox,
    access.role === 'owner',
    ownedCalendar(),
  )
  const organizer = event.organizer?.email?.toLowerCase()
  const { uid, recurrenceId } = details.identity
  const blocked = (reason: string): CalendarLookup => ({ kind: 'blocked', reason })
  if (event.iCalUID !== uid)
    return {
      kind: 'blocked',
      reason: 'Calendar could not verify the identity of this occurrence',
      navigationUnverified: true,
    }
  if (!organizer || organizer !== details.organizer?.email)
    return blocked('The Calendar organizer does not match this invitation')
  if (!legacyJoinOnly && !allowed)
    return blocked('This account cannot verify its place on this Calendar event')
  if (organizerConflict) return blocked('You organize this event')
  const links = invitationEventLinks(event)
  const requiresRoster = rosterChanged(invitation)
  const mismatch = calendarRevisionMismatch(event, invitation, links, { requiresRoster })
  if (mismatch) return blocked(mismatch)
  const etag = strongEventEtag(event.etag)
  // Only an explicit needsAction is a reset. An omitted status cannot
  // corroborate a dispatch or make that response safe to send again.
  const responseStatus = joinOnly ? null : asRsvp(attendee?.responseStatus)
  const reason = joinOnly
    ? null
    : responseStatus === null
      ? 'Calendar could not verify your response on this event'
      : !etag
        ? 'This Calendar copy cannot be edited'
        : null
  const url = calendarResponseUrl(base, event)
  const proof = calendarProof(event, requiresRoster)
  // Preserve previously authorized existence observations. Newly readable
  // legacy copies do not add response locators through deferred navigation.
  const observeNavigation = legacyJoinOnly && !allowed ? async () => {} : observe
  return {
    kind: 'verified',
    target: calendarCopyTarget(url, mailbox),
    etag,
    proof,
    matchesProof: (stored) => stored === proof || matchesCalendarProof(event, stored),
    revision: details.identity,
    title: event.summary,
    start: event.start?.date ?? event.start?.dateTime,
    end: event.end?.date ?? event.end?.dateTime,
    allDay: event.start?.date !== undefined,
    location: event.location,
    ...links,
    // Never fall back from an eligible legacy instance to a declined master.
    htmlLink: legacyJoinOnly && !isAgendaEventVisible(event) ? null : links.htmlLink,
    responseStatus,
    get canEdit() {
      return !legacyJoinOnly && writableRole(access.role)
    },
    get canNavigate() {
      return canNavigate()
    },
    get unavailableReason() {
      return reason ?? (!joinOnly && !this.canEdit ? 'This Calendar copy cannot be edited' : null)
    },
    navigation: async (selectSlot) => {
      if (!canNavigate()) return { kind: 'withheld' }
      const primary = base === PRIMARY_EVENTS
      if (recurrenceId === null && details.recurring) {
        const upcoming = await upcomingInvitationLinks(
          api,
          base,
          event,
          uid,
          organizer,
          legacyJoinOnly,
          observeUidQuery(uid, observeNavigation, { mailbox, primary, parentId: event.id }),
          access,
          (instance, original, links) => {
            const slot = selectSlot(original)
            if (slot === false) return false
            const revision = slot ?? invitation
            const address = revision.details.organizer?.email
            if (legacyJoinOnly)
              return (
                address === organizer &&
                !legacySlotIsSuppressed(
                  discovery,
                  base,
                  event.id!,
                  original,
                  instance,
                  uid,
                  organizer,
                ) &&
                !calendarRevisionMismatch(instance, revision, links, {
                  expanded: slot === null,
                  navigationOnly: true,
                })
              )
            const membership = invitationMembership(
              instance,
              revision,
              mailbox,
              access.role === 'owner',
              ownedCalendar(),
            )
            return (
              (!address ||
                !discovery.suppressesOccurrence(
                  base,
                  event.id!,
                  original,
                  {
                    uid: revision.details.identity.uid,
                    organizer: address,
                    classify: (row) => classifyCancellation(row, revision, mailbox, original),
                  },
                  Boolean(mailboxAttendee(event, mailbox) || (joinOnly && organizes)),
                )) &&
              (instance.attendeesOmitted === undefined || instance.attendeesOmitted === false) &&
              membership.allowed &&
              !membership.organizerConflict &&
              (Boolean(mailboxAttendee(instance, mailbox)) ||
                (revision.joinOnly && membership.organizes)) &&
              // A master establishes a baseline, not the actual date or room.
              // A mailed slot instead supplies exact occurrence material.
              !calendarRevisionMismatch(instance, revision, links, {
                expanded: slot === null,
                navigationOnly: true,
              })
            )
          },
        )
        if (upcoming) return { kind: 'series', links: upcoming }
        return legacyJoinOnly ? { kind: 'withheld' } : { kind: 'series' }
      }
      if (!legacyJoinOnly) return { kind: 'default' }
      if (
        recurrenceId &&
        verifiedParent?.id &&
        event.recurringEventId === verifiedParent.id &&
        legacySlotIsSuppressed(
          discovery,
          base,
          verifiedParent.id,
          recurrenceId,
          event,
          uid,
          organizer,
        )
      )
        return { kind: 'withheld' }
      const current = await legacyMeetingIsCurrent(
        api,
        base,
        event,
        uid,
        recurrenceId,
        observeUidQuery(uid, observeNavigation, {
          mailbox,
          primary,
          parentId:
            primary || event.recurringEventId === verifiedResponseParentId
              ? event.recurringEventId
              : undefined,
        }),
        access,
      )
      if (!current) return { kind: 'withheld' }
      return allowed && access.role === 'owner' ? { kind: 'default' } : { kind: 'calendar', links }
    },
    get reply() {
      return !joinOnly && this.canEdit && reason === null && etag && attendee
        ? { url, etag, attendee }
        : null
    },
  }
}

function invitationEventLinks(event: RawEvent): InvitationLinks {
  const { url, source } = mailConference(event)
  return {
    conferenceUrl: url,
    conferenceLinkSource: source,
    htmlLink: googleEventUrl(event.htmlLink),
  }
}

function rosterChanged({ evidence, predecessors }: InvitationRevision) {
  return predecessors.some((prior) => prior.attendees !== evidence.attendees)
}

/** Both an occurrence card and a series' Join must verify the same mail material.
 * Membership and permission to respond are separate from this comparison. */
function calendarRevisionMismatch(
  event: RawEvent,
  invitation: InvitationRevision,
  { conferenceUrl, htmlLink }: InvitationLinks,
  { requiresRoster = rosterChanged(invitation), expanded = false, navigationOnly = false } = {},
): string | null {
  const { details, fields, material, joinOnly } = invitation
  const { sequence, recurrenceId } = details.identity
  const cancelled = event.status === 'cancelled'
  if ((event.sequence ?? 0) !== sequence)
    return (event.sequence ?? 0) > sequence
      ? 'Calendar has a newer revision of this event'
      : 'Calendar has not received this revision of the invitation yet'
  const recurrenceKnown = !cancelled || Boolean(event.recurrence?.length)
  if (
    !expanded &&
    recurrenceKnown &&
    recurrenceId === null &&
    Boolean(event.recurrence?.length) !== details.recurring
  )
    return 'The Calendar recurrence scope does not match this invitation'
  if (
    !expanded &&
    recurrenceId === null &&
    details.recurring &&
    (!cancelled || event.start !== undefined) &&
    !sameRecurrenceStart(fields, event.start)
  )
    return 'The Calendar time zone does not match this series invitation'
  const { explicitFields } = material
  if (!expanded && recurrenceKnown && explicitFields.recurrence) {
    const expected = recurrenceSet(fields.recurrence)
    const actual = recurrenceSet(event.recurrence ?? [])
    if (expected === null || actual === null || expected !== actual)
      return 'Calendar could not verify the recurrence of this invitation'
  }
  const start = event.start?.date ?? event.start?.dateTime
  const end = event.end?.date ?? event.end?.dateTime
  const allDay = event.start?.date !== undefined
  if (!cancelled && (!coherentEventTimes(event) || allDay !== details.allDay))
    return 'Calendar could not verify the start and end of this event'
  const calendarConference = httpsLink(structuredConference(event)) ?? conferenceUrl
  const calendarPageInMail = googleEventUrl(details.htmlLink)
  const timeMatches = (mail: string | null, calendar: string) =>
    mail !== null && (details.allDay ? mail === calendar : instant(mail) === instant(calendar))
  const observedRoster = requiresRoster ? calendarRoster(event) : undefined
  // An omitted DTEND/DURATION still gives an active REQUEST an effective end.
  // Series Join's separate link lookup keeps its existing material requirements.
  const compareEnd =
    !expanded && (joinOnly || explicitFields.end || (!cancelled && !navigationOnly))
  if (
    (explicitFields.title &&
      event.summary !== undefined &&
      words(event.summary) !== words(details.title)) ||
    (!expanded &&
      (joinOnly || explicitFields.start) &&
      start !== undefined &&
      !timeMatches(details.start, start)) ||
    (compareEnd && end !== undefined && !timeMatches(details.end, end)) ||
    (explicitFields.location &&
      event.location !== undefined &&
      words(event.location) !== words(details.location)) ||
    (!expanded &&
      explicitFields.conferenceUrl &&
      details.conferenceUrl &&
      calendarConference &&
      details.conferenceUrl !== calendarConference) ||
    (!expanded &&
      explicitFields.htmlLink &&
      calendarPageInMail &&
      htmlLink &&
      calendarPageInMail !== htmlLink) ||
    (!cancelled &&
      ((!joinOnly &&
        (material.status === 'CONFIRMED' || material.status === 'TENTATIVE') &&
        event.status !== undefined &&
        event.status.toUpperCase() !== material.status) ||
        (requiresRoster &&
          (observedRoster === undefined ||
            materialDigest(observedRoster) !== invitation.evidence.attendees)) ||
        !provesChangedMaterial(invitation, event, calendarConference, htmlLink, expanded)))
  )
    return 'The Calendar details do not match this revision of the invitation'
  if (joinOnly && (!start || !end || !explicitFields.start))
    return 'Calendar could not verify the time of this meeting'
  if (!cancelled && invitation.unknownPredecessor)
    return 'Calendar could not distinguish this revision from an earlier invitation'
  return null
}

/** Calendar applies timeMin to the exclusive end in the calendar's zone.
 * Also check timed events against the precise cutoff; never guess a DATE's zone.
 * Only publications and exports get the legacy reader's one-hour grace. */
function navigationWindow(legacyJoinOnly: boolean) {
  const cutoff = Date.now() - (legacyJoinOnly ? 60 * 60 * 1000 : 0)
  return {
    timeMin: new Date(cutoff).toISOString(),
    includesEnd: (event: RawEvent) =>
      event.end?.dateTime === undefined || instant(event.end.dateTime) > cutoff,
  }
}

async function legacyMeetingIsCurrent(
  api: CalendarReadApi,
  base: string,
  event: RawEvent,
  uid: string,
  recurrenceId: string | null,
  observe: (event: RawEvent) => Promise<void>,
  access: CalendarAccess,
): Promise<boolean> {
  const { timeMin, includesEnd } = navigationWindow(true)
  if (event.end?.dateTime !== undefined) return includesEnd(event)
  try {
    if (recurrenceId !== null)
      return await currentDateOccurrence(
        api,
        base,
        event,
        uid,
        recurrenceId,
        timeMin,
        observe,
        access,
      )
    const rows = await invitationPages<RawEvent>(
      api,
      base,
      'calendar#events',
      {
        iCalUID: uid,
        singleEvents: 'false',
        showDeleted: 'false',
        timeMin,
      },
      observe,
      access,
    )
    return (
      rows.length === 1 &&
      rows.every(
        (row) =>
          row.id === event.id &&
          usableInvitationEvent(row) &&
          isAgendaEventVisible(row) &&
          coherentEventTimes(row) &&
          calendarProof(row) === calendarProof(event),
      )
    )
  } catch (error) {
    requireLocalNavigationFailure(error)
    return false
  }
}

/** Ask events.list to apply its exclusive end filter in the calendar's zone.
 * This read can corroborate the selected DATE occurrence, never replace it. */
async function currentDateOccurrence(
  api: CalendarReadApi,
  base: string,
  selected: RawEvent,
  uid: string,
  recurrenceId: string,
  timeMin: string,
  observe: (event: RawEvent) => Promise<void>,
  access: CalendarAccess,
): Promise<boolean> {
  const end = selected.end?.date
  if (!end) return false
  // DATE ends are at midnight in the calendar's zone, less than a day
  // either side of UTC midnight. Bound the search without choosing a zone.
  const latestEnd = Date.parse(end) + 24 * 60 * 60 * 1000
  if (Date.parse(timeMin) >= latestEnd) return false
  const rows = await invitationPages<RawEvent>(
    api,
    base,
    'calendar#events',
    {
      iCalUID: uid,
      singleEvents: 'true',
      orderBy: 'startTime',
      showDeleted: 'false',
      timeMin,
      timeMax: new Date(latestEnd).toISOString(),
    },
    observe,
    access,
  )
  const matches = rows.filter(({ id }) => id === selected.id)
  const [row] = matches
  return Boolean(
    matches.length === 1 &&
    row &&
    usableInvitationEvent(row) &&
    coherentEventTimes(row) &&
    isAgendaEventVisible(row) &&
    row.start?.date !== undefined &&
    row.iCalUID === uid &&
    row.recurringEventId === selected.recurringEventId &&
    sameOccurrence(row, recurrenceId) &&
    calendarProof(row) === calendarProof(selected),
  )
}

/** Series Join uses the ordered, expanded view. Its instances never provide
 * RSVP material, a write validator, or proof of absence for the master. */
async function upcomingInvitationLinks(
  api: CalendarReadApi,
  base: string,
  master: RawEvent,
  uid: string,
  organizer: string,
  legacyJoinOnly: boolean,
  observe: (event: RawEvent) => Promise<void>,
  access: CalendarAccess,
  matchesSlot: (instance: RawEvent, original: string, links: InvitationLinks) => boolean,
): Promise<InvitationLinks | null> {
  if (!master.id) return null
  const { timeMin, includesEnd } = navigationWindow(legacyJoinOnly)
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
        showHiddenInvitations: legacyJoinOnly ? undefined : 'true',
        maxResults: '1',
        pageToken,
      })
      const items = await invitationPageItems(page, 'calendar#events', observe, access)
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
        (!legacyJoinOnly || isAgendaEventVisible(instance)) &&
        coherentEventTimes(instance) &&
        (instance.start?.date !== undefined) === (master.start?.date !== undefined) &&
        includesEnd(instance)
      ) {
        const original = occurrenceSlot(instance)!
        const links = invitationEventLinks(instance)
        if ((links.conferenceUrl || links.htmlLink) && matchesSlot(instance, original, links))
          return links
      }
      if (pageToken === undefined) return null
      seen.add(pageToken)
    }
  } catch (error) {
    requireLocalNavigationFailure(error)
  }
  return null
}

const words = (value: string | null | undefined) =>
  value?.normalize('NFC').trim().replace(/\r\n/g, '\n') ?? ''

const textOf = (value: string | undefined) => (value === undefined ? undefined : words(value))

function materialTime(value: string | null | undefined, allDay: boolean) {
  if (value == null) return null
  const millis = allDay ? NaN : instant(value)
  return Number.isFinite(millis) ? millis : value
}

function materialDigest(value: string | number | null): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The same canonical comparison inputs for visible and durable predecessors.
 * Keep per-field digests so a material change can require the relevant Google
 * observation without persisting prose, guest addresses or exception rows. */
export function invitationMaterialEvidence({
  details,
  material,
}: RevisionMaterial): CalendarMaterialEvidence {
  const description = words(material.description)
  return {
    version: 1,
    attendees: materialDigest(JSON.stringify(material.attendees)),
    exceptions: materialDigest(material.exceptionsKey),
    title: materialDigest(material.explicitFields.title ? words(details.title) : ''),
    status: materialDigest(material.status),
    location: materialDigest(words(details.location)),
    description: materialDigest(description),
    descriptionConference: materialDigest(conferenceUrlIn(description)),
    conference: materialDigest(details.conferenceUrl),
    htmlLink: materialDigest(googleEventUrl(details.htmlLink)),
    start: materialDigest(materialTime(details.start, details.allDay)),
    end: materialDigest(materialTime(details.end, details.allDay)),
  }
}

/** At the same sequence, omission is not proof of material that changed.
 * Demand a provider observation for each discriminator, while leaving normal
 * copy verification (including Google’s omitted optional fields) unchanged. */
function provesChangedMaterial(
  { predecessors, evidence, details, material }: InvitationRevision,
  event: RawEvent,
  conference: string | null,
  htmlLink: string | null,
  expanded: boolean,
): boolean {
  if (!predecessors.length) return true
  // A series master cannot prove changes to embedded exception rows. A
  // nonempty Calendar lookup must not authorize RSVP on that master or by mail.
  if (predecessors.some((prior) => prior.exceptions !== evidence.exceptions)) return false
  const proves = (
    field: Exclude<keyof CalendarMaterialEvidence, 'version'>,
    observed: string | number | undefined,
  ) =>
    predecessors.every((prior) => prior[field] === evidence[field]) ||
    (observed !== undefined && materialDigest(observed) === evidence[field])
  // Calendar can represent a bare join URL as structured conference data.
  // That is not a substitute for changed prose, or for a URL already present
  // (in any form) in a predecessor's description.
  const structured = providerConferenceUrl(structuredConference(event))
  const confirmsDescription =
    proves('description', textOf(event.description)) ||
    (structured &&
      providerConferenceUrl(words(material.description)) === structured &&
      predecessors.every(
        (prior) =>
          prior.description === evidence.description ||
          prior.descriptionConference !== materialDigest(structured),
      ))
  return Boolean(
    proves('title', textOf(event.summary)) &&
    // An omitted STATUS is distinct in the mail's material hash. Neither
    // an omitted provider status nor an assumed default proves a change.
    proves('status', event.status?.toUpperCase()) &&
    proves('location', textOf(event.location)) &&
    confirmsDescription &&
    proves('conference', conference ?? undefined) &&
    proves('htmlLink', htmlLink ?? undefined) &&
    proves(
      'start',
      expanded
        ? undefined
        : (materialTime(event.start?.date ?? event.start?.dateTime, details.allDay) ?? undefined),
    ) &&
    proves(
      'end',
      expanded
        ? undefined
        : (materialTime(event.end?.date ?? event.end?.dateTime, details.allDay) ?? undefined),
    ),
  )
}

function sameRecurrenceStart(fields: CalendarRevisionFields, start: RawEvent['start']): boolean {
  const basis = fields.recurrenceTimeBasis
  if (!start || !basis) return false
  if (basis.kind === 'date')
    return (
      start.date === basis.wallStart && fields.calendarRecurrenceZoneMatches(start.timeZone ?? null)
    )
  if (!start.dateTime || !fields.calendarRecurrenceZoneMatches(start.timeZone ?? null)) return false
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

/** A malformed or unavailable optional collection can withhold its links.
 * Account refusals and failures recording shared evidence fail the read. */
function requireLocalNavigationFailure(error: unknown): void {
  if (error instanceof CalendarObservationError) throw error.cause
  if (
    error instanceof InvalidCalendarCollection ||
    error instanceof GoogleResourceTimeoutError ||
    error instanceof GoogleResourceDecodeError ||
    (error instanceof GoogleApiError && !propagateCalendarRefusal(error))
  )
    return
  throw error
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

function calendarTargetMailbox(target: string): string | null {
  return calendarTargetParts(target)?.[1] ?? null
}

function calendarTargetResource(target: string, mailbox: string) {
  const binding = calendarTargetParts(target)
  if (!binding || binding[1] !== mailbox) return null
  const [url] = binding
  const match =
    /^(https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/?#]+)\/events\/([\w-]+))\?sendUpdates=all$/.exec(
      url,
    )
  if (!match || match[0] !== url) return null
  try {
    const segment = match[2]!
    const id = decodeURIComponent(segment)
    return safeCalendarId(id) && encodeURIComponent(id) === segment
      ? { url: match[1]!, id, eventId: match[3]! }
      : null
  } catch {
    return null
  }
}

export function calendarTargetIsMailbox(target: string, mailbox: string): boolean {
  return calendarTargetResource(target, mailbox) !== null
}

type CalendarResource =
  | { kind: 'gone' | 'unknown' }
  | {
      kind: 'present'
      confirms: (proof: string, answer: InviteAnswer, revision?: InvitationRevision) => boolean
    }

/** Exact resources can corroborate earlier writes. A 404 proves absence
 * only with current read access to the containing calendar. Neither fact
 * authorizes a Calendar PATCH. */
export function createInvitationCalendarResourceLookup(
  api: CalendarReadApi,
  mailbox: string,
  discovery: CalendarDiscovery,
) {
  const snapshots = new Map<string, Promise<CalendarResource>>()
  async function hasReadAccess(id: string): Promise<boolean> {
    try {
      // Calendar masks some inaccessible events as 404. Recheck the exact
      // subscription after the event read, never against the discovery snapshot.
      const entry = await api.get<CalendarListEntry>(
        `${BASE}/users/me/calendarList/${encodeURIComponent(id)}`,
      )
      if (
        !isCollectionRow(entry) ||
        entry.kind !== 'calendar#calendarListEntry' ||
        !validCalendar(entry) ||
        (id === 'primary' ? entry.primary !== true : entry.id !== id)
      )
        return false
      return readableRole(discovery.observeEntry(entry)?.role)
    } catch (error) {
      if (propagateCalendarRefusal(error)) throw error
      return false
    }
  }
  async function read({
    url,
    id,
    eventId,
  }: NonNullable<ReturnType<typeof calendarTargetResource>>): Promise<CalendarResource> {
    try {
      const event = await api.get<RawEvent>(url)
      // The locator cannot grant write authority. The matching payload can
      // contribute the same negative slot evidence as a collection row.
      if (event?.id === eventId)
        discovery.observeOccurrenceCancellation(calendarEventsUrl(id), event)
      return {
        kind: 'present',
        confirms: (proof, answer, revision) =>
          Boolean(
            event &&
            usableInvitationEvent(event) &&
            event.status !== 'cancelled' &&
            !event.organizer?.self &&
            coherentEventTimes(event) &&
            mailboxAttendee(event, mailbox)?.responseStatus === answer &&
            matchesCalendarProof(event, proof) &&
            (!revision || !calendarRevisionMismatch(event, revision, invitationEventLinks(event))),
          ),
      }
    } catch (error) {
      if (propagateCalendarRefusal(error)) throw error
      return {
        kind:
          error instanceof GoogleApiError && error.status === 404 && (await hasReadAccess(id))
            ? 'gone'
            : 'unknown',
      }
    }
  }
  return (target: string): Promise<CalendarResource> => {
    const resource = calendarTargetResource(target, mailbox)
    if (!resource) return Promise.resolve({ kind: 'unknown' })
    const { url } = resource
    let snapshot = snapshots.get(url)
    if (!snapshot) {
      // Historical targets share a bounded budget within this snapshot.
      if (snapshots.size >= 32) return Promise.resolve({ kind: 'unknown' })
      snapshot = read(resource)
      snapshots.set(url, snapshot)
    }
    return snapshot
  }
}
