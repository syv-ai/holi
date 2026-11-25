import ICAL from 'ical.js'
import { expect, it } from 'vitest'
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

it.each([
  {
    fields:
      'DTSTART;TZID=America/New_York:20260720T110000\r\nRECURRENCE-ID;TZID=America/New_York:20260713T110000',
    start: '2026-07-20T15:00:00Z',
    occurrence: '2026-07-13T15:00:00Z',
    type: 'date-time',
  },
  {
    fields: 'DTSTART;VALUE=DATE:20260720\r\nRECURRENCE-ID;VALUE=DATE:20260713',
    start: '2026-07-20',
    occurrence: '2026-07-13',
    type: 'date',
  },
])(
  'round-trips a moved $type occurrence as a self-contained reply',
  ({ fields, start, occurrence, type }) => {
    const request = parseMailInvitation('part', calendar(fields), 'REQUEST')!
    const source = request.request!.reply(attendee, 'tentative')
    const event = ICAL.Component.fromString(source).getFirstSubcomponent('vevent')!
    expect(event.getFirstPropertyValue('uid')).toBe(request.details.identity.uid)
    expect(event.getFirstPropertyValue('sequence')).toBe(3)
    for (const [name, value] of [
      ['dtstart', start],
      ['recurrence-id', occurrence],
    ] as const) {
      const time = event.getFirstProperty(name)!
      expect(time.type).toBe(type)
      expect(time.getFirstValue()?.toString()).toBe(value)
    }
    expect(invitationReplyStatus(source, request.details.identity, organizer, attendee)).toBe(
      'tentative',
    )
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
})
