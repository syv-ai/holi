import ICAL from 'ical.js'

export type MailInvitationIdentity = {
  messageId: string
  uid: string
  sequence: number
  recurrenceId: string | null
}

export type MailInvitationDetails = {
  identity: MailInvitationIdentity
  title: string
  start: string
  end: string
  allDay: boolean
  timezone?: string
  organizer: { email: string; name?: string }
  location: string | null
  cancelled: boolean
  unavailableReason: string | null
}

/** Parse one calendar payload from the latest incoming Gmail message. */
export function parseMailInvitation(
  messageId: string,
  source: string | null,
): MailInvitationDetails | null {
  if (source === null || !/BEGIN:VCALENDAR/i.test(source)) return null

  try {
    const component = new ICAL.Component(ICAL.parse(source))
    const method = component.getFirstPropertyValue('method')
    if (method !== 'REQUEST' && method !== 'CANCEL') return null

    const events = component.getAllSubcomponents('vevent')
    if (events.length !== 1) {
      return unavailable(messageId, null, 'Invitation contains multiple or missing events')
    }
    const event = new ICAL.Event(events[0]!)
    const uid = event.uid
    if (typeof uid !== 'string' || uid.trim() === '') {
      return unavailable(messageId, null, 'Invitation has no usable UID')
    }
    const organizerProperty = events[0]!.getFirstProperty('organizer')
    const organizerEmail = organizerProperty
      ?.getFirstValue()
      ?.toString()
      .replace(/^mailto:/i, '')
    if (!organizerEmail || !organizerEmail.includes('@')) {
      return unavailable(messageId, { uid }, 'Invitation has no verifiable organizer address')
    }

    const start = event.startDate
    const end = event.endDate
    if (!start || !end) {
      return unavailable(messageId, { uid }, 'Invitation has no usable start or end time')
    }
    const recurrence = events[0]!.getFirstPropertyValue('recurrence-id') as ICAL.Time | null
    const sequenceValue = events[0]!.getFirstPropertyValue('sequence')
    const sequence = Number(sequenceValue ?? 0)
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      return unavailable(messageId, { uid }, 'Invitation has an invalid sequence')
    }
    const name = organizerProperty?.getParameter('cn')
    const details: MailInvitationDetails = {
      identity: {
        messageId,
        uid,
        sequence,
        recurrenceId: recurrence?.toICALString() ?? null,
      },
      title: event.summary ?? '(untitled meeting)',
      start: start.toJSDate().toISOString(),
      end: end.toJSDate().toISOString(),
      allDay: start.isDate,
      ...(start.zone?.tzid ? { timezone: start.zone.tzid } : {}),
      organizer: { email: organizerEmail, ...(typeof name === 'string' ? { name } : {}) },
      location: event.location || null,
      cancelled: method === 'CANCEL' || event.status === 'CANCELLED',
      unavailableReason: null,
    }
    if (details.cancelled) details.unavailableReason = 'This invitation was cancelled'
    return details
  } catch {
    return unavailable(messageId, null, 'Calendar invitation is malformed or unsupported')
  }
}

function unavailable(
  messageId: string,
  partial: { uid?: string } | null,
  reason: string,
): MailInvitationDetails {
  return {
    identity: {
      messageId,
      uid: partial?.uid ?? '',
      sequence: 0,
      recurrenceId: null,
    },
    title: 'Meeting invitation',
    start: '',
    end: '',
    allDay: false,
    organizer: { email: '' },
    location: null,
    cancelled: false,
    unavailableReason: reason,
  }
}
