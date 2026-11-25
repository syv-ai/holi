import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import {
  conferenceUrlIn,
  googleEventUrl,
  httpsLink,
  providerConferenceUrl,
} from '../shared/meeting-links'
import type { InviteAnswer } from './calendar'
import {
  CalendarPartError,
  malformed,
  openCalendarPart,
  type ResolveTime,
} from './mail-invitation-zones'

export type MailInvitationIdentity = {
  /** Gmail parent locator, not part of the iTIP revision. */
  messageId: string
  uid: string
  sequence: number
  dtstamp: string | null
  /** Event material and guest membership, independent of RSVP/PARTSTAT. */
  materialKey: string | null
  /** Original occurrence: a date, floating wall clock or ISO instant, never the moved start. */
  recurrenceId: string | null
}

type LinkSource = 'mail' | 'provider' | 'calendar' | null

type MailInvitationDetails = {
  identity: MailInvitationIdentity
  title: string
  start: string | null
  end: string | null
  allDay: boolean
  /** Start/end are local ISO wall clocks, without a timezone. */
  floating: boolean
  /** An occurrence has a recurrenceId; a recurring event without one is the series. */
  recurring: boolean
  organizer: { email: string; name?: string } | null
  location: string | null
  conferenceUrl: string | null
  conferenceLinkSource: LinkSource
  htmlLink: string | null
  htmlLinkSource: LinkSource
  cancelled: boolean
  unavailableReason: string | null
}

type AttendeeState = { responseStatus: 'needsAction' | InviteAnswer; rsvp: boolean | null }

type ExplicitFields = {
  title: boolean
  start: boolean
  end: boolean
  location: boolean
  conferenceUrl: boolean
  htmlLink: boolean
  recurrence: boolean
}

type TimeKind = 'date' | 'floating' | 'instant'

type ParsedInvitation = {
  /** Validated independently of actionability (including non-answerable CANCELs). */
  method: 'REQUEST' | 'CANCEL' | null
  /** Scope of a validated RECURRENCE-ID, even when there is no usable request. */
  recurrenceRange: 'THISANDFUTURE' | null
  details: MailInvitationDetails
  /** Never crosses the capability seam. Only present for a usable REQUEST. */
  request: {
    attendees: string[]
    /** Organizer-supplied evidence, not a confirmation of the mailbox's answer. */
    attendeeStates: Record<string, AttendeeState>
    /** Canonical RRULE/RDATE/EXDATE lines, without expanding or resolving a timezone. */
    recurrence: string[]
    /** Fields supplied by the organizer, not synthesized display defaults. */
    explicitFields: ExplicitFields
    recurrenceKind: TimeKind | null
    reply: (email: string, answer: InviteAnswer) => string
  } | null
}

/** Only a single SMTP address, not a header address list or a mailto query. */
function mailbox(value: unknown): string | null {
  if (typeof value !== 'string' || !/^mailto:/i.test(value)) return null
  const email = value.slice(7)
  return /^[\w.!#$&'*+\-/=^`{|}~]+@[a-z\d-]+(?:\.[a-z\d-]+)*$/i.test(email)
    ? email.toLowerCase()
    : null
}

function methodOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toUpperCase() : undefined
}

function single(entry: ICAL.Component, key: string): ICAL.Property | null {
  const items = entry.getAllProperties(key)
  if (items.length > 1) throw new CalendarPartError('Invitation has ambiguous calendar fields')
  return items[0] ?? null
}

function timeKind(value: string): TimeKind {
  return value.length === 10 ? 'date' : value.endsWith('Z') ? 'instant' : 'floating'
}

function eventTime(property: ICAL.Property | null): ICAL.Time | null {
  if (!property) return null
  if (property.type !== 'date' && property.type !== 'date-time') malformed()
  const value = property.getFirstValue()
  if (!(value instanceof ICAL.Time) || value.isDate !== (property.type === 'date')) malformed()
  return value
}

function identityOf(
  messageId: string,
  event: ICAL.Component,
  resolveTime: ResolveTime,
): MailInvitationIdentity {
  const uid = single(event, 'uid')?.getFirstValue()
  if (typeof uid !== 'string' || !uid.trim())
    throw new CalendarPartError('Invitation has no usable UID')
  const sequence = single(event, 'sequence')?.getFirstValue() ?? 0
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)
    throw new CalendarPartError('Invitation has an invalid sequence')
  const recurrence = single(event, 'recurrence-id')
  const occurrence = eventTime(recurrence)
  const stamp = single(event, 'dtstamp')
  const dtstamp = eventTime(stamp)
  if (dtstamp && (dtstamp.isDate || dtstamp.zone !== ICAL.Timezone.utcTimezone)) malformed()
  return {
    messageId,
    uid,
    sequence,
    materialKey: null,
    dtstamp: dtstamp ? resolveTime(dtstamp, stamp) : null,
    recurrenceId: occurrence ? resolveTime(occurrence, recurrence) : null,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function attendeeState(property: ICAL.Property): AttendeeState {
  const partstat = property.getParameter('partstat')
  const rsvp = property.getParameter('rsvp')
  const status = methodOf(partstat)
  const flag = methodOf(rsvp)
  if (rsvp !== undefined && flag !== 'TRUE' && flag !== 'FALSE') malformed()
  const responseStatus =
    partstat === undefined || status === 'NEEDS-ACTION'
      ? 'needsAction'
      : (Object.keys(PARTSTAT) as InviteAnswer[]).find((answer) => PARTSTAT[answer] === status)
  // An unknown explicit response is not evidence of needsAction.
  if (!responseStatus) malformed()
  return { responseStatus, rsvp: rsvp === undefined ? null : flag === 'TRUE' }
}

function attendeeEvidence(entry: ICAL.Component) {
  const states = new Map<string, AttendeeState>()
  for (const property of entry.getAllProperties('attendee')) {
    const email = mailbox(property.getFirstValue())
    if (!email) continue
    const state = attendeeState(property)
    const previous = states.get(email)
    if (
      previous &&
      (previous.responseStatus !== state.responseStatus || previous.rsvp !== state.rsvp)
    )
      throw new CalendarPartError('Invitation has conflicting attendee responses')
    states.set(email, state)
  }
  const attendees = [...states.keys()].sort()
  return {
    attendees,
    attendeeStates: Object.fromEntries(attendees.map((email) => [email, states.get(email)!])),
  }
}

function candidate(events: ICAL.Component[]): ICAL.Component | undefined {
  if (events.length <= 1) return events[0]
  const masters = events.filter((event) => !event.hasProperty('recurrence-id'))
  const master = masters[0]
  // A series plus its exceptions is one series invitation. Independent events
  // or several instance-only updates have no single answer.
  if (
    master &&
    masters.length === 1 &&
    events.every(
      (event) => event.getFirstPropertyValue('uid') === master.getFirstPropertyValue('uid'),
    )
  )
    return master
  return undefined
}

function eventMaterial(entry: ICAL.Component, resolveTime: ResolveTime, hasExceptions = false) {
  const status = methodOf(single(entry, 'status')?.getFirstValue()) ?? null
  const summary = single(entry, 'summary')
  const locationProperty = single(entry, 'location')
  const urlProperty = single(entry, 'url')
  const conferenceProperties = entry.getAllProperties('conference')
  const title = text(summary?.getFirstValue()) ?? 'Meeting invitation'
  const location = text(locationProperty?.getFirstValue()) ?? null
  const description = text(single(entry, 'description')?.getFirstValue())
  const htmlLink = httpsLink(urlProperty?.getFirstValue())
  const urlConference = htmlLink ? providerConferenceUrl(htmlLink) : null
  const htmlLinkSource: LinkSource = !htmlLink
    ? null
    : urlConference || googleEventUrl(htmlLink)
      ? 'provider'
      : 'mail'
  // RFC 7986 permits multiple access points, including telephone dial-in.
  // Rank recognized video links first and break ties independently of wire order.
  const conferenceLinks = conferenceProperties
    .flatMap((property) => httpsLink(property.getFirstValue()) ?? [])
    .sort()
  const providerLink =
    conferenceLinks.map(providerConferenceUrl).find((link) => link !== null) ??
    urlConference ??
    conferenceUrlIn(description ?? '') ??
    conferenceUrlIn(location ?? '')
  const conferenceUrl = providerLink ?? conferenceLinks[0] ?? null
  const conferenceLinkSource: LinkSource = providerLink ? 'provider' : conferenceUrl ? 'mail' : null
  const organizerProperty = single(entry, 'organizer')
  const email = mailbox(organizerProperty?.getFirstValue())
  const name = text(organizerProperty?.getParameter('cn'))
  const organizer = email ? { email, ...(name ? { name } : {}) } : null
  const { attendees, attendeeStates } = attendeeEvidence(entry)
  const startProperty = single(entry, 'dtstart')
  const endProperty = single(entry, 'dtend')
  const duration = single(entry, 'duration')
  if ((endProperty && duration) || (duration && duration.type !== 'duration')) malformed()
  const startTime = eventTime(startProperty)
  const endTime = eventTime(endProperty)
  if (endTime && (!startTime || startTime.isDate !== endTime.isDate)) malformed()
  const start = startTime ? resolveTime(startTime, startProperty) : null
  let end = endTime ? resolveTime(endTime, endProperty) : start
  if (start && end && timeKind(start) !== timeKind(end)) malformed()
  if (startTime && !endTime && (duration || startTime.isDate)) {
    const next = startTime.clone()
    const length = duration?.getFirstValue() ?? ICAL.Duration.fromSeconds(86400)
    if (
      !(length instanceof ICAL.Duration) ||
      (next.isDate && (length.hours || length.minutes || length.seconds))
    )
      malformed()
    // Calendar days are nominal (a DST change can move the offset). Add
    // sub-day units to the instant when known, or to the wall clock otherwise.
    next.day += length.weeks * 7 + length.days
    const seconds = length.hours * 3600 + length.minutes * 60 + length.seconds
    if (!next.isDate && start && timeKind(start) === 'floating') {
      next.second += seconds
      end = resolveTime(next, startProperty)
    } else {
      end = resolveTime(next, startProperty)
      if (!next.isDate) end = new Date(Date.parse(end) + seconds * 1000).toISOString()
    }
  }
  const recurrence = single(entry, 'recurrence-id')
  if (recurrence && startTime && startTime.isDate !== (recurrence.type === 'date')) malformed()
  const rangeParam = recurrence?.getParameter('range')
  const range = typeof rangeParam === 'string' ? rangeParam.toUpperCase() : undefined
  if (rangeParam !== undefined && range !== 'THISANDFUTURE') malformed()
  const recurrenceRange: ParsedInvitation['recurrenceRange'] =
    range === 'THISANDFUTURE' ? range : null
  const rules = recurrenceLines(entry)
  const details = {
    title,
    location,
    htmlLink,
    htmlLinkSource,
    conferenceUrl,
    conferenceLinkSource,
    organizer,
    start,
    end,
    allDay: startTime?.isDate ?? false,
    floating: start !== null && timeKind(start) === 'floating',
    recurring: hasExceptions || recurrence !== null || rules.length > 0,
  }
  const explicitFields: ExplicitFields = {
    title: summary !== null,
    start: startProperty !== null,
    end: endProperty !== null || duration !== null,
    location: locationProperty !== null,
    conferenceUrl: conferenceProperties.length > 0 || conferenceUrl !== null,
    htmlLink: urlProperty !== null,
    recurrence: rules.length > 0,
  }
  // PARTSTAT/RSVP only inform continuity for the connected mailbox. They must
  // not change the event's material, even on an embedded occurrence exception.
  return {
    material: {
      details,
      explicitFields,
      attendees,
      description: description ?? null,
      status,
      recurrenceRange,
      rules,
    },
    attendeeStates,
  }
}

function orderedFields<T>(fields: Record<string, T>): [string, T][] {
  return Object.keys(fields)
    .sort()
    .map((key) => [key, fields[key]!])
}

function recurrenceLines(entry: ICAL.Component): string[] {
  const lines: string[] = []
  for (const property of entry.getAllProperties('rrule')) {
    const [, params, type, rawRule] = property.toJSON() as [
      string,
      Record<string, unknown>,
      string,
      Record<string, unknown>,
    ]
    if (type !== 'recur' || !rawRule?.freq) malformed()
    const rule: Record<string, unknown> = { freq: rawRule.freq }
    for (const [key, value] of orderedFields(rawRule)) {
      if (
        key === 'freq' ||
        (key === 'interval' && value === 1) ||
        (key === 'wkst' && value === ICAL.Time.MONDAY)
      )
        continue
      if (key === 'byday') {
        const days = Array.isArray(value) ? value : [value]
        rule[key] = [...new Set(days.map((day: string) => day.replace(/^\+/, '')))].sort()
      } else {
        rule[key] = Array.isArray(value) ? [...value].sort() : value
      }
    }
    lines.push(
      new ICAL.Property([
        'rrule',
        Object.fromEntries(orderedFields(params)),
        type,
        rule,
      ]).toICALString(),
    )
  }

  // A list may be delivered on one line or split across properties. Combine
  // only identical parameter and value types; keep the sender's TZID and values.
  const dateLists = new Map<
    string,
    { head: [string, Record<string, unknown>, string]; values: Map<string, unknown> }
  >()
  for (const name of ['rdate', 'exdate']) {
    for (const property of entry.getAllProperties(name)) {
      const [, params, type, ...values] = property.toJSON() as [
        string,
        Record<string, unknown>,
        string,
        ...unknown[],
      ]
      const head = [name, Object.fromEntries(orderedFields(params)), type] satisfies [
        string,
        Record<string, unknown>,
        string,
      ]
      const key = JSON.stringify(head)
      const group = dateLists.get(key) ?? { head, values: new Map<string, unknown>() }
      for (const value of values) group.values.set(JSON.stringify(value), value)
      dateLists.set(key, group)
    }
  }
  for (const { head, values } of dateLists.values()) {
    const dates = [...values.keys()].sort().map((key) => values.get(key))
    lines.push(new ICAL.Property([...head, ...dates]).toICALString())
  }
  return lines.sort()
}

/** Inspect only calendar MIME payloads, not prose or a quoted earlier email. */
export function parseMailInvitation(
  messageId: string,
  source: string,
  mimeMethod: string | undefined,
): ParsedInvitation | null {
  const hint = methodOf(mimeMethod)
  let method: ParsedInvitation['method'] = null
  let recurrenceRange: ParsedInvitation['recurrenceRange'] = null
  const details: MailInvitationDetails = {
    identity: {
      messageId,
      uid: '',
      sequence: 0,
      recurrenceId: null,
      dtstamp: null,
      materialKey: null,
    },
    title: 'Meeting invitation',
    start: null,
    end: null,
    allDay: false,
    floating: false,
    recurring: false,
    organizer: null,
    location: null,
    conferenceUrl: null,
    conferenceLinkSource: null,
    htmlLink: null,
    htmlLinkSource: null,
    cancelled: false,
    unavailableReason: null,
  }
  const unavailable = (reason: string): ParsedInvitation => {
    details.unavailableReason = reason
    return { method, recurrenceRange, details, request: null }
  }

  try {
    const { calendar, resolveTimes } = openCalendarPart(source)
    const payload = single(calendar, 'method')
    const parsed = payload?.type === 'text' ? methodOf(payload.getFirstValue()) : undefined
    // PUBLISH and REPLY are not invitations. A damaged calendar MIME part with
    // no usable method is still something the reader should explain.
    if (
      parsed !== 'REQUEST' &&
      parsed !== 'CANCEL' &&
      hint !== 'REQUEST' &&
      hint !== 'CANCEL' &&
      (parsed || hint)
    )
      return null
    if ((parsed !== 'REQUEST' && parsed !== 'CANCEL') || (hint && hint !== parsed))
      return unavailable('Calendar invitation has a missing or inconsistent method')
    method = parsed
    const resolveTime = resolveTimes()
    const events = calendar.getAllSubcomponents('vevent')
    const entry = candidate(events)
    if (!entry) return unavailable('Invitation does not describe a single event or series')
    const identity = identityOf(messageId, entry, resolveTime)
    const { material, attendeeStates } = eventMaterial(entry, resolveTime, events.length > 1)
    const exceptions = events
      .filter((item) => item !== entry)
      .map((item) => {
        const { recurrenceId } = identityOf(messageId, item, resolveTime)
        return JSON.stringify({ recurrenceId, ...eventMaterial(item, resolveTime).material })
      })
      .sort()
    const cancelled = method === 'CANCEL' || material.status === 'CANCELLED'
    identity.materialKey = createHash('sha256')
      .update(
        JSON.stringify({
          method,
          cancelled,
          occurrence: identity.recurrenceId,
          ...material,
          exceptions,
        }),
      )
      .digest('hex')
    recurrenceRange = material.recurrenceRange
    Object.assign(details, material.details, { identity, cancelled })
    if (cancelled) return unavailable('This invitation was cancelled')
    if (!details.organizer) return unavailable('Invitation has no usable organizer address')
    if (!details.start || !details.end || details.end < details.start)
      return unavailable('Invitation has no usable start or end time')
    if (recurrenceRange) return unavailable('This invitation changes multiple occurrences')
    const { start, organizer } = details
    return {
      method,
      recurrenceRange,
      details,
      request: {
        attendees: material.attendees,
        attendeeStates,
        recurrence: material.rules,
        explicitFields: material.explicitFields,
        recurrenceKind: identity.recurrenceId ? timeKind(identity.recurrenceId) : null,
        reply: (attendee, answer) => buildReply(identity, start, organizer.email, attendee, answer),
      },
    }
  } catch (error) {
    return unavailable(
      error instanceof CalendarPartError
        ? error.message
        : 'Calendar invitation is malformed or unsupported',
    )
  }
}

const PARTSTAT = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' } as const

function buildReply(
  identity: MailInvitationIdentity,
  start: string,
  organizer: string,
  email: string,
  answer: InviteAnswer,
): string {
  const calendar = new ICAL.Component('vcalendar')
  calendar.addPropertyWithValue('version', '2.0')
  calendar.addPropertyWithValue('prodid', '-//Holi//Mail invitation reply//EN')
  calendar.addPropertyWithValue('method', 'REPLY')
  const reply = new ICAL.Component('vevent')
  calendar.addSubcomponent(reply)
  reply.addPropertyWithValue('uid', identity.uid)
  reply.addPropertyWithValue('sequence', identity.sequence)
  reply.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  reply.addPropertyWithValue('organizer', `mailto:${organizer}`)
  const attendee = reply.addPropertyWithValue('attendee', `mailto:${email}`)
  attendee.setParameter('partstat', PARTSTAT[answer])

  // Preserve DATE and floating values. Known instants go out as UTC, never a
  // TZID without its definition. The recurrence slot is independent of moved start.
  reply.addPropertyWithValue('dtstart', replyTime(start))
  if (identity.recurrenceId)
    reply.addPropertyWithValue('recurrence-id', replyTime(identity.recurrenceId))
  return calendar.toString() + '\r\n'
}

function replyTime(value: string): ICAL.Time {
  switch (timeKind(value)) {
    case 'date':
      return ICAL.Time.fromDateString(value)
    case 'floating':
      return ICAL.Time.fromDateTimeString(value)
    case 'instant':
      return ICAL.Time.fromJSDate(new Date(value), true)
  }
}

/** A sent iTIP reply can describe only this organizer, invite sequence and occurrence.
 * Its DTSTAMP belongs to the reply, not the original invitation. */
export function invitationReplyStatus(
  source: string,
  identity: MailInvitationIdentity,
  organizer: string,
  email: string,
): InviteAnswer | null {
  try {
    const { calendar: reply, resolveTimes } = openCalendarPart(source)
    const method = single(reply, 'method')
    if (method?.type !== 'text' || methodOf(method.getFirstValue()) !== 'REPLY') return null
    const events = reply.getAllSubcomponents('vevent')
    if (events.length !== 1) return null
    const resolveTime = resolveTimes()
    const entry = events[0]!
    const sent = identityOf('', entry, resolveTime)
    const recurrence = entry.getFirstProperty('recurrence-id')
    if (recurrence?.getParameter('range') !== undefined) return null
    // Validate any supplied times even when no recurrence ID needs their zones.
    for (const key of ['dtstart', 'dtend']) {
      const property = single(entry, key)
      const time = eventTime(property)
      if (time && recurrence && property?.type !== recurrence.type) return null
      if (time) resolveTime(time, property)
    }
    if (
      sent.uid !== identity.uid ||
      sent.sequence !== identity.sequence ||
      sent.recurrenceId !== identity.recurrenceId ||
      mailbox(single(entry, 'organizer')?.getFirstValue()) !== organizer
    )
      return null
    const attendees = entry.getAllProperties('attendee')
    if (attendees.length !== 1 || mailbox(attendees[0]!.getFirstValue()) !== email) return null
    const partstat = methodOf(attendees[0]!.getParameter('partstat'))
    return (
      (['accepted', 'tentative', 'declined'] as const).find(
        (answer) => PARTSTAT[answer] === partstat,
      ) ?? null
    )
  } catch {
    return null
  }
}
