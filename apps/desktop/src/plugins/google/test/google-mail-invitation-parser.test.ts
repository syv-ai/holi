import ICAL from 'ical.js'
import { expect, it, vi } from 'vitest'
import { invitationReplyStatus, parseMailInvitation } from '../main/mail-invitation'

const organizer = 'host@example.net'
const attendee = 'guest@example.org'
const fixed = [
  'BEGIN:STANDARD',
  'DTSTART:16010101T000000',
  'TZOFFSETFROM:+0530',
  'TZOFFSETTO:+0530',
  'END:STANDARD',
].join('\r\n')
const annual = [
  'BEGIN:STANDARD',
  'DTSTART:16011104T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=SU;BYSETPOS=1',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010311T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
].join('\r\n')

function zone(observances: string) {
  return ['BEGIN:VTIMEZONE', 'TZID:Custom Clock', observances, 'END:VTIMEZONE'].join('\r\n')
}

function calendar(
  fields = 'DTSTART:20260720T150000Z',
  { method = 'REQUEST', definition = '' } = {},
) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `METHOD:${method}`,
    definition,
    'BEGIN:VEVENT',
    'UID:room-booking@example.net',
    'SEQUENCE:3',
    'DTSTAMP:20260601T150000Z',
    'SUMMARY:Room booking',
    `ORGANIZER;CN=Host:mailto:${organizer}`,
    `ATTENDEE${method === 'REPLY' ? ';PARTSTAT=ACCEPTED' : ''}:mailto:${attendee}`,
    fields,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]
    .filter(Boolean)
    .join('\r\n')
}

it('resolves custom fixed offsets and the current season of annual Outlook-style zones', () => {
  const fields = 'DTSTART;TZID="Custom Clock":20260720T110000'
  const fixedInvite = parseMailInvitation(
    'part',
    calendar(fields, { definition: zone(fixed) }),
    undefined,
  )
  expect(fixedInvite?.details.start).toBe('2026-07-20T05:30:00.000Z')
  expect(fixedInvite?.request).not.toBeNull()

  const summer = parseMailInvitation(
    'part',
    calendar(fields, { definition: zone(annual) }),
    undefined,
  )
  const winter = parseMailInvitation(
    'part',
    calendar(fields.replace('20260720', '20261120'), { definition: zone(annual) }),
    undefined,
  )
  expect(summer?.details.start).toBe('2026-07-20T15:00:00.000Z')
  expect(winter?.details.start).toBe('2026-11-20T16:00:00.000Z')
  expect(summer?.request).not.toBeNull()

  const repeatedHour = parseMailInvitation(
    'part',
    calendar('DTSTART;TZID="Custom Clock":20261101T013000', { definition: zone(annual) }),
    undefined,
  )
  expect(repeatedHour?.details.start).toBe('2026-11-01T05:30:00.000Z')

  const sent = calendar(fields, { method: 'REPLY', definition: zone(annual) })
  expect(invitationReplyStatus(sent, summer!.details.identity, organizer, attendee)).toBe(
    'accepted',
  )
})

it('uses all explicit fixed transitions in an observance, including an RDATE list', () => {
  const explicit = [
    'BEGIN:STANDARD',
    'DTSTART:20261101T020000',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'RDATE:20271107T020000,20281105T020000',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:20260308T020000',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'RDATE:20270314T020000,20280312T020000',
    'END:DAYLIGHT',
  ].join('\r\n')
  const fields = 'DTSTART;TZID="Custom Clock":20281120T110000'
  const result = parseMailInvitation(
    'part',
    calendar(fields, { definition: zone(explicit) }),
    'REQUEST',
  )
  expect(result?.details.start).toBe('2028-11-20T16:00:00.000Z')
  expect(result?.request).not.toBeNull()
})

it.each([
  { label: 'an unsupported rule', definition: zone(annual.replace('FREQ=YEARLY', 'FREQ=MONTHLY')) },
  { label: 'too many observances', definition: zone(Array<string>(30).fill(fixed).join('\r\n')) },
  {
    label: 'a zone window spanning decades',
    definition: zone(annual),
    extra: '\r\nRECURRENCE-ID;TZID="Custom Clock":20560720T110000',
  },
  {
    label: 'an oversized folded line',
    definition: zone(fixed),
    extra: `\r\nDESCRIPTION:${'é'.repeat(3000)}\r\n ${'é'.repeat(3000)}`,
  },
])(
  'fails closed on $label in both received invitations and Sent replies',
  ({ definition, extra }) => {
    const fields = 'DTSTART;TZID="Custom Clock":20260720T110000' + (extra ?? '')
    const request = parseMailInvitation('part', calendar(fields, { definition }), 'REQUEST')
    expect(request).toMatchObject({
      request: null,
      details: { unavailableReason: expect.any(String) },
    })
    const originalFields = extra?.includes('RECURRENCE-ID')
      ? 'DTSTART:20260720T150000Z\r\nRECURRENCE-ID:20560720T150000Z'
      : 'DTSTART:20260720T150000Z'
    const reference = parseMailInvitation('part', calendar(originalFields), 'REQUEST')
    const reply = calendar(fields, { method: 'REPLY', definition })
    expect(
      invitationReplyStatus(reply, reference!.details.identity, organizer, attendee),
    ).toBeNull()
  },
)

it.each(['America/New_York', 'Asia/Tokyo'])(
  'round-trips moved DATE, floating and known-zone occurrences with host TZ=%s',
  (tz) => {
    vi.stubEnv('TZ', tz)
    try {
      for (const { fields, definition, recurrenceKind, occurrence, wire } of [
        {
          fields: 'DTSTART;VALUE=DATE:20260720\r\nRECURRENCE-ID;VALUE=DATE:20260713',
          recurrenceKind: 'date',
          occurrence: '2026-07-13',
          wire: ['DTSTART;VALUE=DATE:20260720', 'RECURRENCE-ID;VALUE=DATE:20260713'],
        },
        {
          fields: 'DTSTART:20260308T013000\r\nRECURRENCE-ID:20260301T013000\r\nDURATION:PT2H',
          recurrenceKind: 'floating',
          occurrence: '2026-03-01T01:30:00',
          wire: ['DTSTART:20260308T013000', 'RECURRENCE-ID:20260301T013000'],
        },
        {
          fields: 'DTSTART:20260308T063000Z\r\nRECURRENCE-ID:20260301T013000',
          recurrenceKind: 'floating',
          occurrence: '2026-03-01T01:30:00',
          wire: ['DTSTART:20260308T063000Z', 'RECURRENCE-ID:20260301T013000'],
        },
        {
          fields:
            'DTSTART;TZID=America/New_York:20260720T110000\r\nRECURRENCE-ID;TZID=America/New_York:20260713T110000',
          recurrenceKind: 'instant',
          occurrence: '2026-07-13T15:00:00.000Z',
          wire: ['DTSTART:20260720T150000Z', 'RECURRENCE-ID:20260713T150000Z'],
        },
        {
          fields:
            'DTSTART;TZID="Custom Clock":20260720T110000\r\nRECURRENCE-ID;TZID="Custom Clock":20260713T110000',
          definition: zone(fixed),
          recurrenceKind: 'instant',
          occurrence: '2026-07-13T05:30:00.000Z',
          wire: ['DTSTART:20260720T053000Z', 'RECURRENCE-ID:20260713T053000Z'],
        },
      ]) {
        const invite = parseMailInvitation('part', calendar(fields, { definition }), 'REQUEST')!
        expect(invite).toMatchObject({
          details: { recurring: true, identity: { recurrenceId: occurrence } },
          request: { recurrenceKind },
        })
        if (fields.includes('DURATION')) {
          expect(invite.details).toMatchObject({
            start: '2026-03-08T01:30:00',
            end: '2026-03-08T03:30:00',
          })
        }
        const source = invite.request!.reply(attendee, 'tentative')
        expect(source.split('\r\n')).toEqual(expect.arrayContaining(wire))
        const event = ICAL.Component.fromString(source).getFirstSubcomponent('vevent')!
        expect(event.getFirstPropertyValue('uid')).toBe(invite.details.identity.uid)
        expect(event.getFirstPropertyValue('sequence')).toBe(3)
        expect(invitationReplyStatus(source, invite.details.identity, organizer, attendee)).toBe(
          'tentative',
        )
        if (recurrenceKind === 'floating') {
          const guessedInstant = source.replace(
            'RECURRENCE-ID:20260301T013000',
            'RECURRENCE-ID:20260301T013000Z',
          )
          expect(
            invitationReplyStatus(guessedInstant, invite.details.identity, organizer, attendee),
          ).toBeNull()
        }
      }
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

it('separates the parent message and revision from normalized invitation material', () => {
  const source = calendar('DTSTART:20260720T150000Z\r\nATTENDEE:mailto:other@example.net')
  const first = parseMailInvitation('original', source, 'REQUEST')!
  const second = parseMailInvitation(
    'duplicate',
    source
      .replace('SUMMARY:Room booking', 'summary:Room \r\n booking')
      .replace(
        `ATTENDEE:mailto:${attendee}\r\nDTSTART:20260720T150000Z\r\nATTENDEE:mailto:other@example.net`,
        `ATTENDEE:MAILTO:OTHER@example.net\r\nATTENDEE:mailto:${attendee}\r\nDTSTART;TZID=America/New_York:20260720T110000`,
      )
      .replace(/\r\n/g, '\n'),
    undefined,
  )!
  const revision = parseMailInvitation(
    'update',
    source.replace('20260601T150000Z', '20260602T150000Z'),
    'REQUEST',
  )!
  expect(first.details.identity.dtstamp).toBe('2026-06-01T15:00:00.000Z')
  expect(first.details.identity.materialKey).toEqual(expect.any(String))
  expect(second.details.identity.messageId).not.toBe(first.details.identity.messageId)
  expect(second.details.identity.materialKey).toBe(first.details.identity.materialKey)
  expect(revision.details.identity.dtstamp).not.toBe(first.details.identity.dtstamp)
  expect(revision.details.identity.materialKey).toBe(first.details.identity.materialKey)

  for (const changed of [
    source.replace('Room booking', 'Different room'),
    source.replace('other@example.net', 'different@example.net'),
    source.replace('20260720T150000Z', '20260720T160000Z'),
  ]) {
    expect(
      parseMailInvitation('update', changed, 'REQUEST')?.details.identity.materialKey,
    ).not.toBe(first.details.identity.materialKey)
  }
  const cancelled = parseMailInvitation(
    'update',
    source.replace('METHOD:REQUEST', 'METHOD:CANCEL'),
    'CANCEL',
  )!
  expect(cancelled).toMatchObject({ method: 'CANCEL', request: null, details: { cancelled: true } })
  expect(cancelled.details.identity.materialKey).not.toBe(first.details.identity.materialKey)
})

it('preserves normalized attendee response evidence and identifies reconfirmation changes', () => {
  const source = calendar(
    [
      'DTSTART:20260720T150000Z',
      'ATTENDEE;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:Accepted@example.net',
      'ATTENDEE;RSVP=true;PARTSTAT=tentative:mailto:tentative@example.net',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:declined@example.net',
    ].join('\r\n'),
  )
  const initial = parseMailInvitation('initial', source, 'REQUEST')!
  expect(initial.request?.attendeeStates).toEqual({
    [attendee]: { responseStatus: 'needsAction', rsvp: null },
    'accepted@example.net': { responseStatus: 'accepted', rsvp: false },
    'tentative@example.net': { responseStatus: 'tentative', rsvp: true },
    'declined@example.net': { responseStatus: 'declined', rsvp: null },
  })
  expect(initial.details.identity.materialKey).toEqual(expect.any(String))
  const redelivery = source
    .replace('20260601T150000Z', '20260602T150000Z')
    .replace(
      `ATTENDEE:mailto:${attendee}`,
      `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${attendee}\r\nATTENDEE:MAILTO:${attendee.toUpperCase()}`,
    )
  const canonical = parseMailInvitation('redelivery', redelivery, undefined)!
  expect(canonical.request?.attendeeStates).toEqual(initial.request?.attendeeStates)
  expect(canonical.details.identity.materialKey).toBe(initial.details.identity.materialKey)

  for (const changed of [
    source.replace('PARTSTAT=ACCEPTED', 'PARTSTAT=NEEDS-ACTION'),
    source.replace('RSVP=FALSE', 'RSVP=TRUE'),
    source.replace(';RSVP=FALSE', ''),
  ]) {
    const reset = parseMailInvitation('reset', changed, 'REQUEST')!
    expect(reset.request).not.toBeNull()
    expect(reset.details.identity.materialKey).not.toBe(initial.details.identity.materialKey)
  }
})

it.each([
  [`ATTENDEE;PARTSTAT=DECLINED:MAILTO:${attendee.toUpperCase()}`],
  [`ATTENDEE;RSVP=FALSE:mailto:${attendee}`],
  [`ATTENDEE;RSVP=TRUE;RSVP=FALSE:mailto:${attendee}`],
])('blocks ambiguous attendee response evidence: %s', (conflicting) => {
  expect(
    parseMailInvitation('part', calendar(`DTSTART:20260720T150000Z\r\n${conflicting}`), 'REQUEST'),
  ).toMatchObject({ request: null, details: { unavailableReason: expect.any(String) } })
})

it('distinguishes omitted overlap fields from explicit values even when the display defaults match', () => {
  const source = calendar('DTSTART;VALUE=DATE:20260720').replace('SUMMARY:Room booking\r\n', '')
  const implicit = parseMailInvitation('implicit', source, 'REQUEST')!
  expect(implicit).toMatchObject({
    details: { title: 'Meeting invitation', end: '2026-07-21', recurring: false },
    request: { recurrenceKind: null },
  })
  expect(implicit.request?.explicitFields).toEqual({
    title: false,
    start: true,
    end: false,
    location: false,
    conferenceUrl: false,
    htmlLink: false,
  })
  const explicit = parseMailInvitation(
    'explicit',
    source.replace(
      'DTSTART;VALUE=DATE:20260720',
      [
        'DTSTART;VALUE=DATE:20260720',
        'DURATION:P1D',
        'SUMMARY:Meeting invitation',
        'LOCATION:Room 1',
        'URL:https://calendar.google.com/calendar/event?eid=abc',
        'DESCRIPTION:Join https://meet.google.com/abc-defg-hij',
        'RRULE:FREQ=WEEKLY;COUNT=3',
      ].join('\r\n'),
    ),
    'REQUEST',
  )!
  expect(explicit).toMatchObject({
    details: {
      title: 'Meeting invitation',
      end: '2026-07-21',
      recurring: true,
      identity: { recurrenceId: null },
    },
    request: { recurrenceKind: null },
  })
  expect(explicit.request?.explicitFields).toEqual({
    title: true,
    start: true,
    end: true,
    location: true,
    conferenceUrl: true,
    htmlLink: true,
  })
  const withDtend = parseMailInvitation(
    'dtend',
    source.replace('END:VEVENT', 'DTEND;VALUE=DATE:20260721\r\nEND:VEVENT'),
    'REQUEST',
  )!
  expect(withDtend.request?.explicitFields.end).toBe(true)
  expect(withDtend.details.end).toBe(implicit.details.end)
  expect(withDtend.details.identity.materialKey).not.toBe(implicit.details.identity.materialKey)
})

it('does not treat malformed revision fields as valid or corroborating evidence', () => {
  const identity = parseMailInvitation('part', calendar(), 'REQUEST')!.details.identity
  for (const [before, after] of [
    ['SEQUENCE:3', 'SEQUENCE:3oops'],
    ['DTSTAMP:20260601T150000Z', 'DTSTAMP:20260231T150000Z'],
    ['DTSTAMP:20260601T150000Z', 'DTSTAMP:20260601T150000'],
    ['DTSTAMP:20260601T150000Z', 'DTSTAMP:20260601T150000Z\r\nDTSTAMP:20260602T150000Z'],
  ] as const) {
    expect(
      parseMailInvitation('part', calendar().replace(before, after), 'REQUEST')?.request,
    ).toBeNull()
    const sent = calendar(undefined, { method: 'REPLY' }).replace(before, after)
    expect(invitationReplyStatus(sent, identity, organizer, attendee)).toBeNull()
  }
})

it('distinguishes mail links from recognized provider links and excludes other schemes', () => {
  function links(fields: string) {
    return parseMailInvitation('part', calendar(`DTSTART:20260720T150000Z\r\n${fields}`), 'REQUEST')
      ?.details
  }
  expect(
    links(
      'CONFERENCE:https://notzoom.us/j/123\r\nURL:https://meet.google.com/abc-defg-hij/redirect',
    ),
  ).toMatchObject({
    conferenceUrl: 'https://notzoom.us/j/123',
    conferenceLinkSource: 'mail',
    htmlLink: 'https://meet.google.com/abc-defg-hij/redirect',
    htmlLinkSource: 'mail',
  })
  expect(
    links(
      'DESCRIPTION:Join https://notzoom.us/j/123 or https://meet.google.com/abc-defg-hij\r\nURL:https://calendar.google.com/calendar/event?eid=abc',
    ),
  ).toMatchObject({
    conferenceUrl: 'https://meet.google.com/abc-defg-hij',
    conferenceLinkSource: 'provider',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
    htmlLinkSource: 'provider',
  })
  expect(links('CONFERENCE:zoommtg://zoom.us/j/123\r\nURL:javascript:alert(1)')).toMatchObject({
    conferenceUrl: null,
    conferenceLinkSource: null,
    htmlLink: null,
    htmlLinkSource: null,
  })
  expect(
    links(
      'CONFERENCE:https://meet.google.com:444/abc-defg-hij\r\nURL:https://guest:pass@meet.google.com/abc-defg-hij',
    ),
  ).toMatchObject({
    conferenceUrl: null,
    conferenceLinkSource: null,
    htmlLink: null,
    htmlLinkSource: null,
  })
})

it('selects a recognized video conference over dial-in regardless of property order', () => {
  const phone = 'CONFERENCE;FEATURE=AUDIO:tel:+15550100'
  const dialIn = 'CONFERENCE;FEATURE=AUDIO:https://notzoom.us/j/123'
  const video = 'CONFERENCE;FEATURE=VIDEO:https://meet.google.com/abc-defg-hij'
  const invites = [
    [phone, dialIn, video],
    [video, dialIn, phone],
  ].map((accessPoints) =>
    parseMailInvitation(
      'part',
      calendar(['DTSTART:20260720T150000Z', ...accessPoints].join('\r\n')),
      'REQUEST',
    )!,
  )
  for (const invite of invites) {
    expect(invite).toMatchObject({
      details: {
        conferenceUrl: 'https://meet.google.com/abc-defg-hij',
        conferenceLinkSource: 'provider',
        identity: { materialKey: expect.any(String) },
      },
      request: { explicitFields: { conferenceUrl: true } },
    })
  }
  expect(invites[0]!.details.identity.materialKey).toBe(invites[1]!.details.identity.materialKey)
})
