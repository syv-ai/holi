import { TZDate } from '@date-fns/tz'
import ICAL from 'ical.js'
import { joinLinkIn, type InviteAnswer } from './calendar'

export type MailInvitationIdentity = {
  messageId: string
  uid: string
  sequence: number
  /** Original occurrence: an ISO instant or an all-day date, never the moved start. */
  recurrenceId: string | null
}

type MailInvitationDetails = {
  identity: MailInvitationIdentity
  title: string
  start: string | null
  end: string | null
  allDay: boolean
  organizer: { email: string; name?: string } | null
  location: string | null
  conferenceUrl: string | null
  htmlLink: string | null
  cancelled: boolean
  unavailableReason: string | null
}

type ParsedInvitation = {
  details: MailInvitationDetails
  /** Never crosses the capability seam. Only present for a usable REQUEST. */
  request: { attendees: string[]; reply: (email: string, answer: InviteAnswer) => string } | null
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

function isInvitation(method: string | undefined): boolean {
  return method === 'REQUEST' || method === 'CANCEL'
}

function unfold(source: string): string {
  return source.replace(/\r?\n[ \t]/g, '')
}

function hasInvalidSequence(source: string): boolean {
  // ical.js accepts partial integers and turns non-numbers into zero. Do not
  // interpret a malformed revision as a valid sequence zero or match its REPLY.
  return [...source.matchAll(/^SEQUENCE(?:;(?:[^":\r\n]|"[^"\r\n]*")*)?:([^\r\n]*)/gim)].some(
    ([, value]) => !/^\+?\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)),
  )
}

function dateOf(time: ICAL.Time, property: ICAL.Property | null): string {
  if (time.isDate) return time.toString()
  const tzid = property?.getParameter('tzid')
  // Prefer the calendar's own VTIMEZONE, including Outlook's custom names.
  // Without it, accept IANA TZIDs; never quietly treat an unknown zone as local.
  if (time.zone === ICAL.Timezone.localTimezone && typeof tzid === 'string') {
    return new Date(
      new TZDate(
        time.year,
        time.month - 1,
        time.day,
        time.hour,
        time.minute,
        time.second,
        tzid,
      ).getTime(),
    ).toISOString()
  }
  // An explicitly floating time has no zone: interpret it in the reader's local time.
  return time.toJSDate().toISOString()
}

function identityOf(messageId: string, event: ICAL.Component): MailInvitationIdentity {
  const uid = event.getFirstPropertyValue('uid')
  if (typeof uid !== 'string' || !uid.trim() || event.getAllProperties('uid').length !== 1) {
    throw new Error('Invitation has no usable UID')
  }
  if (
    event.getAllProperties('sequence').length > 1 ||
    event.getAllProperties('recurrence-id').length > 1
  ) {
    throw new Error('Invitation has an ambiguous revision')
  }
  const sequence = event.getFirstPropertyValue('sequence') ?? 0
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Invitation has an invalid sequence')
  }
  const property = event.getFirstProperty('recurrence-id')
  const value = property?.getFirstValue()
  if (property && !(value instanceof ICAL.Time)) throw new Error('Invalid recurrence ID')
  return {
    messageId,
    uid,
    sequence,
    recurrenceId: value instanceof ICAL.Time ? dateOf(value, property) : null,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function httpsLink(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function candidate(calendar: ICAL.Component): ICAL.Component | undefined {
  const events = calendar.getAllSubcomponents('vevent')
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

/** Inspect only calendar MIME payloads, not prose or a quoted earlier email. */
export function parseMailInvitation(
  messageId: string,
  source: string,
  mimeMethod: string | undefined,
): ParsedInvitation | null {
  const hint = methodOf(mimeMethod)
  source = source.replace(/^\uFEFF/, '')
  const unfolded = unfold(source)
  const declared = methodOf(/^METHOD[ \t]*:([^\r\n]*)/im.exec(unfolded)?.[1])
  // PUBLISH and REPLY are not invitations. A damaged calendar MIME part
  // with no usable method is still something the reader should explain.
  if (!isInvitation(hint) && !isInvitation(declared) && (declared || hint)) return null

  const details: MailInvitationDetails = {
    identity: { messageId, uid: '', sequence: 0, recurrenceId: null },
    title: 'Meeting invitation',
    start: null,
    end: null,
    allDay: false,
    organizer: null,
    location: null,
    conferenceUrl: null,
    htmlLink: null,
    cancelled: declared === 'CANCEL' || hint === 'CANCEL',
    unavailableReason: null,
  }
  const unavailable = (reason: string): ParsedInvitation => {
    details.unavailableReason = details.cancelled ? 'This invitation was cancelled' : reason
    return { details, request: null }
  }

  try {
    const calendar = new ICAL.Component(ICAL.parse(source))
    const method = methodOf(calendar.getFirstPropertyValue('method'))
    if (
      calendar.name !== 'vcalendar' ||
      !isInvitation(method) ||
      (hint && method !== hint) ||
      calendar.getAllProperties('method').length !== 1
    ) {
      return unavailable('Calendar invitation has a missing or inconsistent method')
    }
    const entry = candidate(calendar)
    if (!entry) return unavailable('Invitation does not describe a single event or series')
    const event = new ICAL.Event(entry)
    details.cancelled ||=
      method === 'CANCEL' || methodOf(entry.getFirstPropertyValue('status')) === 'CANCELLED'
    details.title = text(event.summary) ?? details.title
    details.location = text(event.location) ?? null
    details.htmlLink = httpsLink(entry.getFirstPropertyValue('url'))
    details.conferenceUrl =
      httpsLink(entry.getFirstPropertyValue('conference')) ??
      joinLinkIn(text(entry.getFirstPropertyValue('url'))) ??
      joinLinkIn(text(event.description)) ??
      joinLinkIn(text(event.location))

    const organizer = entry.getFirstProperty('organizer')
    const email = mailbox(organizer?.getFirstValue())
    const name = text(organizer?.getParameter('cn'))
    if (email) details.organizer = { email, ...(name ? { name } : {}) }
    details.identity = identityOf(messageId, entry)
    if (hasInvalidSequence(unfolded)) return unavailable('Invitation has an invalid sequence')
    if (entry.getAllProperties('organizer').length > 1) {
      return unavailable('Invitation has more than one organizer')
    }

    const start = event.startDate
    if (start) {
      const end = event.endDate
      const startProperty = entry.getFirstProperty('dtstart')
      const endProperty = entry.getFirstProperty('dtend') ?? startProperty
      if (start.isDate !== end.isDate) return unavailable('Invitation uses inconsistent date types')
      details.allDay = start.isDate
      details.start = dateOf(start, startProperty)
      details.end = dateOf(end, endProperty)
    }
    if (details.cancelled) return unavailable('This invitation was cancelled')
    if (!email) return unavailable('Invitation has no usable organizer address')
    if (!details.start || !details.end || details.end < details.start) {
      return unavailable('Invitation has no usable start or end time')
    }
    if (entry.getFirstProperty('recurrence-id')?.getParameter('range')) {
      return unavailable('This invitation changes multiple occurrences')
    }
    const attendees = entry
      .getAllProperties('attendee')
      .map((property) => mailbox(property.getFirstValue()))
      .filter((address): address is string => address !== null)
    return {
      details,
      request: {
        attendees,
        reply: (attendee, answer) =>
          buildReply(calendar, entry, details.identity, email, attendee, answer),
      },
    }
  } catch {
    return unavailable('Calendar invitation is malformed or unsupported')
  }
}

const PARTSTAT = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' } as const

function buildReply(
  request: ICAL.Component,
  entry: ICAL.Component,
  identity: MailInvitationIdentity,
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

  // Preserve the original recurrence's value type and TZID (not just the
  // normalized lookup instant), and include only the VTIMEZONEs we refer to.
  const zones = new Set<string>()
  for (const key of ['dtstart', 'recurrence-id']) {
    const original = entry.getFirstProperty(key)
    if (!original) continue
    const value = original.getFirstValue()
    if (!(value instanceof ICAL.Time)) continue
    const copy = new ICAL.Property(key)
    copy.setValue(value.clone())
    const tzid = original.getParameter('tzid')
    if (typeof tzid === 'string') {
      zones.add(tzid)
      copy.setParameter('tzid', tzid)
    }
    reply.addProperty(copy)
  }
  for (const zone of request.getAllSubcomponents('vtimezone')) {
    const tzid = zone.getFirstPropertyValue('tzid')
    if (typeof tzid === 'string' && zones.has(tzid)) {
      calendar.addSubcomponent(new ICAL.Component(zone.toJSON()))
    }
  }
  return calendar.toString() + '\r\n'
}

/** A sent iTIP reply can describe only this organizer, invite revision and mailbox. */
export function invitationReplyStatus(
  source: string,
  identity: MailInvitationIdentity,
  organizer: string,
  email: string,
): InviteAnswer | null {
  try {
    if (hasInvalidSequence(unfold(source))) return null
    const reply = new ICAL.Component(ICAL.parse(source))
    if (reply.name !== 'vcalendar' || methodOf(reply.getFirstPropertyValue('method')) !== 'REPLY')
      return null
    const events = reply.getAllSubcomponents('vevent')
    if (events.length !== 1) return null
    const entry = events[0]!
    const sent = identityOf('', entry)
    if (
      sent.uid !== identity.uid ||
      sent.sequence !== identity.sequence ||
      sent.recurrenceId !== identity.recurrenceId ||
      mailbox(entry.getFirstPropertyValue('organizer')) !== organizer
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
