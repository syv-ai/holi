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

const newYork = 'America/New_York'
const googleEastern = [
  'BEGIN:STANDARD',
  'DTSTART:19701101T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZNAME:EST',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700308T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZNAME:EDT',
  'END:DAYLIGHT',
].join('\r\n')
const fixedEastern = fixed.replaceAll('+0530', '-0500')

function zone(observances: string, tzid = 'Custom Clock') {
  return ['BEGIN:VTIMEZONE', `TZID:${tzid}`, observances, 'END:VTIMEZONE'].join('\r\n')
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

function appendOccurrence(source: string, ...fields: string[]) {
  return source.replace(
    'END:VCALENDAR',
    ['BEGIN:VEVENT', 'UID:room-booking@example.net', ...fields, 'END:VEVENT', 'END:VCALENDAR'].join(
      '\r\n',
    ),
  )
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

it('checks a Google-style embedded zone against the Calendar zone, not just the first instant', () => {
  const parse = (observances: string, id = newYork) =>
    parseMailInvitation(
      'series',
      calendar(`DTSTART;TZID="${id}":20260105T110000\r\nRRULE:FREQ=WEEKLY`, {
        definition: zone(observances, id),
      }),
      'REQUEST',
    )!
  const ordinary = parse(googleEastern)
  expect(ordinary.request?.recurrenceTimeBasis).toMatchObject({ kind: 'custom', zone: newYork })
  expect(ordinary.request!.calendarRecurrenceZoneMatches(newYork)).toBe(true)
  expect(ordinary.request!.calendarRecurrenceZoneMatches('US/Eastern')).toBe(true)
  for (const other of [null, 'Etc/GMT+5', 'Not/AZone'])
    expect(ordinary.request!.calendarRecurrenceZoneMatches(other)).toBe(false)

  for (const observances of [
    fixedEastern,
    googleEastern.replace('BYDAY=2SU', 'BYDAY=3SU'),
    googleEastern.replace('BYDAY=2SU', 'BYDAY=2SU;UNTIL=20400311T070000Z'),
  ]) {
    const tampered = parse(observances)
    expect(tampered.details.start).toBe('2026-01-05T16:00:00.000Z')
    expect(tampered.request!.calendarRecurrenceZoneMatches(newYork)).toBe(false)
  }

  const custom = parse(annual, 'Custom Clock')
  expect(custom.request!.calendarRecurrenceZoneMatches(newYork)).toBe(false)
  const reply = custom.request!.reply(attendee, 'accepted')
  expect(invitationReplyStatus(reply, custom.details.identity, organizer, attendee)).toBe(
    'accepted',
  )
})

it.each(['RDATE', 'EXDATE'])('checks the embedded definition referenced only by %s', (line) => {
  const fields = [
    'DTSTART:20260105T160000Z',
    'RRULE:FREQ=WEEKLY',
    `${line};TZID=${newYork}:20260112T110000`,
  ].join('\r\n')
  const parse = (observances: string) =>
    parseMailInvitation(
      'series',
      calendar(fields, { definition: zone(observances, newYork) }),
      'REQUEST',
    )!
  const ordinary = parse(googleEastern)
  const tampered = parse(fixedEastern)
  expect(ordinary.request!.calendarRecurrenceZoneMatches('UTC')).toBe(true)
  expect(tampered.request!.calendarRecurrenceZoneMatches('UTC')).toBe(false)
  expect(tampered.request?.recurrence).toEqual(ordinary.request?.recurrence)
  expect(tampered.details.identity.materialKey).not.toBe(ordinary.details.identity.materialKey)
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
  ['UTC', 0],
  ['America/New_York', 240],
] as const)(
  'uses RFC 5545 offsets for bare IANA gaps and folds with host TZ=%s',
  (host, offset) => {
    vi.stubEnv('TZ', host)
    try {
      expect(new Date('2026-10-25T00:30:00Z').getTimezoneOffset()).toBe(offset)
      for (const [civil, instant] of [
        ['20261025T023000', '2026-10-25T00:30:00.000Z'], // First 02:30, on summer time.
        ['20260329T023000', '2026-03-29T01:30:00.000Z'], // Skipped 02:30, using winter offset.
      ]) {
        const source = calendar(
          `DTSTART;TZID=Europe/Paris:${civil}\r\nRECURRENCE-ID;TZID=Europe/Paris:${civil}`,
        )
        expect(parseMailInvitation('part', source, 'REQUEST')).toMatchObject({
          details: { start: instant, identity: { recurrenceId: instant }, unavailableReason: null },
        })
      }
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

it('refuses an email reply for an undefined zoned occurrence without blocking Calendar', () => {
  const parsed = parseMailInvitation(
    'part',
    calendar(
      'DTSTART;TZID=America/New_York:20260720T140000\r\nRECURRENCE-ID;TZID=America/New_York:20260713T110000',
    ),
    'REQUEST',
  )!
  expect(parsed).toMatchObject({
    details: { identity: { recurrenceId: '2026-07-13T15:00:00.000Z' }, unavailableReason: null },
    request: { replyUnavailableReason: expect.any(String) },
  })
  expect(parsed.request!.calendarRecurrenceZoneMatches(newYork)).toBe(true)
  expect(() => parsed.request!.reply(attendee, 'accepted')).toThrow(
    parsed.request!.replyUnavailableReason!,
  )
})

it('omits optional DTSTART with an undefined zone while preserving a valid occurrence reply', () => {
  const parsed = parseMailInvitation(
    'part',
    calendar('DTSTART;TZID=America/New_York:20260720T140000\r\nRECURRENCE-ID:20260713T150000Z'),
    'REQUEST',
  )!
  expect(parsed.request?.replyUnavailableReason).toBeNull()
  const reply = parsed.request!.reply(attendee, 'accepted')
  const decoded = ICAL.Component.fromString(reply)
  const event = decoded.getFirstSubcomponent('vevent')!
  expect(event.hasProperty('dtstart')).toBe(false)
  expect(reply.split('\r\n')).toContain('RECURRENCE-ID:20260713T150000Z')
  expect(invitationReplyStatus(reply, parsed.details.identity, organizer, attendee)).toBe(
    'accepted',
  )
})

it.each(['America/New_York', 'Asia/Tokyo'])(
  'round-trips moved DATE, floating and known-zone occurrences with host TZ=%s',
  (tz) => {
    vi.stubEnv('TZ', tz)
    try {
      for (const { fields, definition, recurrenceKind, occurrence, wire, floating, tzid } of [
        {
          fields: 'DTSTART;VALUE=DATE:20260720\r\nRECURRENCE-ID;VALUE=DATE:20260713',
          recurrenceKind: 'date',
          occurrence: '2026-07-13',
          wire: ['DTSTART;VALUE=DATE:20260720', 'RECURRENCE-ID;VALUE=DATE:20260713'],
        },
        {
          fields: 'DTSTART:20260308T023000\r\nRECURRENCE-ID:20260301T013000\r\nDURATION:PT1H',
          recurrenceKind: 'floating',
          occurrence: '2026-03-01T01:30:00',
          floating: true,
          wire: ['DTSTART:20260308T023000', 'RECURRENCE-ID:20260301T013000'],
        },
        {
          fields: 'DTSTART:20260308T063000Z\r\nRECURRENCE-ID:20260301T013000',
          recurrenceKind: 'floating',
          occurrence: '2026-03-01T01:30:00',
          wire: ['DTSTART:20260308T063000Z', 'RECURRENCE-ID:20260301T013000'],
        },
        {
          fields:
            'DTSTART;TZID=America/New_York:20260720T140000\r\nRECURRENCE-ID;TZID=America/New_York:20260713T110000',
          definition: zone(googleEastern, newYork),
          recurrenceKind: 'instant',
          occurrence: '2026-07-13T15:00:00.000Z',
          wire: [
            'DTSTART;TZID=America/New_York:20260720T140000',
            'RECURRENCE-ID;TZID=America/New_York:20260713T110000',
          ],
          tzid: newYork,
        },
        {
          fields:
            'DTSTART;TZID="Custom Clock":20260720T110000\r\nRECURRENCE-ID;TZID="Custom Clock":20260713T110000',
          definition: zone(fixed),
          recurrenceKind: 'instant',
          occurrence: '2026-07-13T05:30:00.000Z',
          wire: [
            'DTSTART;TZID=Custom Clock:20260720T110000',
            'RECURRENCE-ID;TZID=Custom Clock:20260713T110000',
          ],
          tzid: 'Custom Clock',
        },
        {
          fields: 'DTSTART:20260720T180000Z\r\nRECURRENCE-ID:20260713T150000Z',
          recurrenceKind: 'instant',
          occurrence: '2026-07-13T15:00:00.000Z',
          wire: ['DTSTART:20260720T180000Z', 'RECURRENCE-ID:20260713T150000Z'],
        },
      ]) {
        const invite = parseMailInvitation('part', calendar(fields, { definition }), 'REQUEST')!
        expect(invite).toMatchObject({
          details: {
            recurring: true,
            floating: floating ?? false,
            identity: { recurrenceId: occurrence },
          },
          request: { recurrenceKind, replyUnavailableReason: null },
        })
        if (recurrenceKind === 'date') {
          expect(invite.request?.recurrenceTimeBasis).toEqual({
            kind: 'date',
            zone: null,
            wallStart: '2026-07-20',
            customKey: null,
          })
        }
        if (floating) {
          expect(invite.request?.recurrenceTimeBasis).toEqual({
            kind: 'floating',
            zone: null,
            wallStart: '2026-03-08T02:30:00',
            customKey: null,
          })
          expect(invite.details).toMatchObject({
            start: '2026-03-08T02:30:00',
            end: '2026-03-08T03:30:00',
          })
        }
        const source = invite.request!.reply(attendee, 'tentative')
        expect(source.split('\r\n')).toEqual(expect.arrayContaining(wire))
        const decoded = ICAL.Component.fromString(source)
        const event = decoded.getFirstSubcomponent('vevent')!
        if (tzid) {
          expect(event.getFirstProperty('recurrence-id')?.getParameter('tzid')).toBe(tzid)
          expect(event.getFirstProperty('dtstart')?.getParameter('tzid')).toBe(tzid)
          const expected = ICAL.Component.fromString(calendar(fields, { definition }))
          expect(decoded.getAllSubcomponents('vtimezone').map((zone) => zone.toJSON())).toEqual(
            expected.getAllSubcomponents('vtimezone').map((zone) => zone.toJSON()),
          )
        }
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

it('preserves normalized attendee response evidence without changing event material', () => {
  const source = calendar(
    [
      'DTSTART:20260720T150000Z',
      'ATTENDEE;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:Other@example.net',
    ].join('\r\n'),
  )
  const initial = parseMailInvitation('initial', source, 'REQUEST')!
  expect(initial.request?.attendeeStates).toEqual({
    [attendee]: { responseStatus: 'needsAction', rsvp: null },
    'other@example.net': { responseStatus: 'accepted', rsvp: false },
  })
  expect(initial.details.identity.materialKey).toEqual(expect.any(String))
  const redelivery = source.replace('20260601T150000Z', '20260602T150000Z')
  const canonical = parseMailInvitation(
    'redelivery',
    redelivery.replace(
      `ATTENDEE:mailto:${attendee}`,
      `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${attendee}\r\nATTENDEE:MAILTO:${attendee.toUpperCase()}`,
    ),
    undefined,
  )!
  expect(canonical.request?.attendeeStates).toEqual(initial.request?.attendeeStates)
  expect(canonical.details.identity.materialKey).toBe(initial.details.identity.materialKey)

  for (const [parameters, state] of [
    ['PARTSTAT=tentative;RSVP=FALSE', { responseStatus: 'tentative', rsvp: false }],
    ['PARTSTAT=ACCEPTED;RSVP=true', { responseStatus: 'accepted', rsvp: true }],
    ['PARTSTAT=DECLINED', { responseStatus: 'declined', rsvp: null }],
    ['PARTSTAT=DELEGATED', { responseStatus: 'delegated', rsvp: null }],
  ] as const) {
    const reset = parseMailInvitation(
      'other-guest-update',
      redelivery.replace('PARTSTAT=ACCEPTED;RSVP=FALSE', parameters),
      'REQUEST',
    )!
    expect(reset.details.identity.materialKey).toBe(initial.details.identity.materialKey)
    expect(reset.request?.attendeeStates[attendee]).toEqual(
      initial.request?.attendeeStates[attendee],
    )
    expect(reset.request?.attendeeStates['other@example.net']).toEqual(state)
  }

  const ownReset = parseMailInvitation(
    'mailbox-reset',
    redelivery.replace(`ATTENDEE:mailto:${attendee}`, `ATTENDEE;RSVP=TRUE:mailto:${attendee}`),
    'REQUEST',
  )!
  expect(ownReset.details.identity.materialKey).toBe(initial.details.identity.materialKey)
  expect(ownReset.request?.attendeeStates[attendee]).toEqual({
    responseStatus: 'needsAction',
    rsvp: true,
  })
})

it('preserves a delegated mailbox response but sends only the chosen answer', () => {
  const source = calendar().replace(
    `ATTENDEE:mailto:${attendee}`,
    `ATTENDEE;PARTSTAT=DELEGATED;DELEGATED-TO="mailto:other@example.net":mailto:${attendee}`,
  )
  const invitation = parseMailInvitation('part', source, 'REQUEST')!
  expect(invitation.request?.attendeeStates[attendee]).toEqual({
    responseStatus: 'delegated',
    rsvp: null,
  })
  const reply = invitation.request!.reply(attendee, 'accepted')
  expect(reply.split('\r\n').filter((line) => line.startsWith('ATTENDEE'))).toEqual([
    `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${attendee}`,
  ])
  expect(reply).not.toMatch(/DELEGATED-(?:TO|FROM)|other@example.net/)
  expect(invitationReplyStatus(reply, invitation.details.identity, organizer, attendee)).toBe(
    'accepted',
  )
})

it.each([
  [`ATTENDEE;PARTSTAT=DECLINED:MAILTO:${attendee.toUpperCase()}`],
  ['ATTENDEE;PARTSTAT=UNKNOWN:mailto:other@example.net'],
  ['ATTENDEE;PARTSTAT=DELEGATED;PARTSTAT=ACCEPTED:mailto:other@example.net'],
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
    request: { recurrenceKind: null, recurrence: [] },
  })
  expect(implicit.revisionMaterial?.explicitFields).toEqual({
    title: false,
    start: true,
    end: false,
    location: false,
    conferenceUrl: false,
    htmlLink: false,
    recurrence: false,
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
    request: { recurrenceKind: null, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] },
  })
  expect(explicit.revisionMaterial?.explicitFields).toEqual({
    title: true,
    start: true,
    end: true,
    location: true,
    conferenceUrl: true,
    htmlLink: true,
    recurrence: true,
  })
  const withDtend = parseMailInvitation(
    'dtend',
    source.replace('END:VEVENT', 'DTEND;VALUE=DATE:20260721\r\nEND:VEVENT'),
    'REQUEST',
  )!
  expect(withDtend.revisionMaterial?.explicitFields.end).toBe(true)
  expect(withDtend.details.end).toBe(implicit.details.end)
  expect(withDtend.details.identity.materialKey).not.toBe(implicit.details.identity.materialKey)
})

it('preserves organizer and revision evidence for cancellations that omit DTSTART', () => {
  const master = parseMailInvitation(
    'cancel',
    calendar('STATUS:CANCELLED', { method: 'CANCEL' }),
    'CANCEL',
  )
  expect(master).toMatchObject({
    method: 'CANCEL',
    recurrenceRange: null,
    request: null,
    details: {
      cancelled: true,
      start: null,
      organizer: { email: organizer },
      identity: {
        uid: 'room-booking@example.net',
        sequence: 3,
        dtstamp: '2026-06-01T15:00:00.000Z',
        recurrenceId: null,
        materialKey: expect.any(String),
      },
    },
  })

  expect(master?.cancellations).toEqual([
    {
      identity: master?.details.identity,
      organizer: { email: organizer, name: 'Host' },
      recurrenceRange: null,
      eventCancelled: true,
      attendees: [attendee],
    },
  ])

  const occurrence = 'RECURRENCE-ID;VALUE=DATE:20260720'
  const single = parseMailInvitation('cancel', calendar(occurrence, { method: 'CANCEL' }), 'CANCEL')
  const ranged = parseMailInvitation(
    'cancel',
    calendar(occurrence.replace(';VALUE', ';RANGE=thisandfuture;VALUE'), { method: 'CANCEL' }),
    'CANCEL',
  )
  expect(single?.recurrenceRange).toBeNull()
  expect(ranged).toMatchObject({
    method: 'CANCEL',
    recurrenceRange: 'THISANDFUTURE',
    request: null,
    details: {
      cancelled: true,
      identity: { recurrenceId: '2026-07-20', materialKey: expect.any(String) },
    },
  })
  expect(ranged?.details.identity.materialKey).not.toBe(single?.details.identity.materialKey)
  expect(
    single?.cancellations.map(({ identity, recurrenceRange }) => [
      identity.recurrenceId,
      recurrenceRange,
    ]),
  ).toEqual([['2026-07-20', null]])
  expect(
    ranged?.cancellations.map(({ identity, recurrenceRange }) => [
      identity.recurrenceId,
      recurrenceRange,
    ]),
  ).toEqual([['2026-07-20', 'THISANDFUTURE']])

  for (const range of ['THISANDPRIOR', 'THISANDFUTURE;RANGE=THISANDFUTURE']) {
    const invalid = calendar(occurrence.replace(';VALUE', `;RANGE=${range};VALUE`), {
      method: 'CANCEL',
    })
    expect(parseMailInvitation('cancel', invalid, 'CANCEL')).toMatchObject({
      request: null,
      details: { identity: { materialKey: null }, unavailableReason: expect.any(String) },
    })
  }
})

it('keeps attendee removals restricted to explicitly named mailboxes', () => {
  const remove = (email: string) =>
    calendar('', { method: 'CANCEL' }).replace(
      `mailto:${attendee}`,
      `MAILTO:${email.toUpperCase()}`,
    )
  for (const email of [attendee, 'other@example.net']) {
    const parsed = parseMailInvitation('cancel', remove(email), 'CANCEL')
    expect(parsed?.cancellations).toMatchObject([
      {
        eventCancelled: false,
        attendees: [email],
        identity: {
          uid: 'room-booking@example.net',
          sequence: 3,
          dtstamp: '2026-06-01T15:00:00.000Z',
          materialKey: expect.any(String),
        },
      },
    ])
  }
  const missingAttendee = remove(attendee).replace(/^ATTENDEE:.*\r\n/m, '')
  for (const ambiguous of [missingAttendee, remove('not-an-address')]) {
    expect(parseMailInvitation('cancel', ambiguous, 'CANCEL')).toMatchObject({
      cancellations: [],
      request: null,
    })
  }
})

it.each(['CONFIRMED', 'TENTATIVE', '', ' CANCELLED ', 'CANCELLED\r\nSTATUS:CANCELLED'])(
  'does not report a cancellation or attendee removal for invalid explicit STATUS %j',
  (status) => {
    expect(
      parseMailInvitation('part', calendar(`STATUS:${status}`, { method: 'CANCEL' }), 'CANCEL'),
    ).toMatchObject({
      method: 'CANCEL',
      request: null,
      cancellations: [],
      details: { cancelled: false, unavailableReason: expect.any(String) },
    })
  },
)

it('exposes each same-UID cancellation from one MIME part without inventing a master', () => {
  const first = calendar('RECURRENCE-ID;TZID="Custom Clock":20260720T110000', {
    method: 'CANCEL',
    definition: zone(fixed),
  })
  const second = [
    'RECURRENCE-ID;TZID="Custom Clock";RANGE=THISANDFUTURE:20260727T110000',
    'SEQUENCE:4',
    'DTSTAMP:20260602T150000Z',
    `ORGANIZER:mailto:${organizer}`,
    'STATUS:CANCELLED',
  ]
  const parsed = parseMailInvitation('part', appendOccurrence(first, ...second), 'CANCEL')
  expect(parsed).toMatchObject({
    method: 'CANCEL',
    request: null,
    details: { cancelled: true, start: null },
    cancellations: [
      {
        identity: {
          uid: 'room-booking@example.net',
          sequence: 3,
          recurrenceId: '2026-07-20T05:30:00.000Z',
        },
        organizer: { email: organizer },
        recurrenceRange: null,
        eventCancelled: false,
        attendees: [attendee],
      },
      {
        identity: {
          messageId: 'part',
          uid: 'room-booking@example.net',
          sequence: 4,
          dtstamp: '2026-06-02T15:00:00.000Z',
          recurrenceId: '2026-07-27T05:30:00.000Z',
          materialKey: expect.any(String),
        },
        organizer: { email: organizer },
        recurrenceRange: 'THISANDFUTURE',
        eventCancelled: true,
        attendees: [],
      },
    ],
  })
  expect(parsed?.cancellations[0]).toEqual(
    parseMailInvitation('part', first, 'CANCEL')?.cancellations[0],
  )

  const other = appendOccurrence(first, ...second)
  for (const conflicting of [
    other.replace(
      'BEGIN:VEVENT\r\nUID:room-booking@example.net\r\nRECURRENCE-ID',
      'BEGIN:VEVENT\r\nUID:unrelated@example.net\r\nRECURRENCE-ID',
    ),
    other.replace('20260727T110000', '20260720T110000'),
    other.replace(`ORGANIZER:mailto:${organizer}`, 'ORGANIZER:mailto:other@example.net'),
    other.replace('DTSTAMP:20260602T150000Z\r\n', ''),
    other.replace('SEQUENCE:4\r\n', ''),
    other.replace('STATUS:CANCELLED', `STATUS:TENTATIVE\r\nATTENDEE:mailto:${attendee}`),
  ]) {
    expect(parseMailInvitation('part', conflicting, 'CANCEL')).toMatchObject({
      cancellations: [],
      request: null,
      details: { identity: { materialKey: null } },
    })
  }
})

it('reports a cancelled REQUEST exception with its own revision and the verified series organizer', () => {
  const series = calendar('DTSTART:20260720T150000Z\r\nRRULE:FREQ=WEEKLY')
  const source = appendOccurrence(
    series,
    'RECURRENCE-ID:20260727T150000Z',
    'SEQUENCE:4',
    'DTSTAMP:20260603T150000Z',
    'STATUS:CANCELLED',
  )
  const parsed = parseMailInvitation('part', source, 'REQUEST')
  expect(parsed).toMatchObject({
    method: 'REQUEST',
    details: { cancelled: false, identity: { recurrenceId: null, sequence: 3 } },
    request: { recurrence: ['RRULE:FREQ=WEEKLY'] },
    cancellations: [
      {
        identity: {
          messageId: 'part',
          uid: 'room-booking@example.net',
          sequence: 4,
          dtstamp: '2026-06-03T15:00:00.000Z',
          recurrenceId: '2026-07-27T15:00:00.000Z',
          materialKey: expect.any(String),
        },
        organizer: { email: organizer, name: 'Host' },
        recurrenceRange: null,
        eventCancelled: true,
        attendees: [],
      },
    ],
  })
  expect(
    parseMailInvitation('part', source.replace('STATUS:CANCELLED', 'STATUS:CONFIRMED'), 'REQUEST')
      ?.cancellations,
  ).toEqual([])
  for (const invalid of [
    source.replace('STATUS:CANCELLED', 'STATUS:CANCELLED\r\nORGANIZER:mailto:other@example.net'),
    source.replace('STATUS:CANCELLED', 'STATUS:CANCELLED\r\nORGANIZER:invalid'),
    source.replace('DTSTAMP:20260603T150000Z\r\n', ''),
  ]) {
    expect(parseMailInvitation('part', invalid, 'REQUEST')).toMatchObject({
      cancellations: [],
      request: null,
    })
  }
})

it('canonicalizes explicit recurrence without expanding rules or guessing timezones', () => {
  const fields = [
    'DTSTART:20260720T150000Z',
    'RRULE:FREQ=WEEKLY;COUNT=1000000;BYDAY=WE,MO',
    'RDATE;TZID=America/New_York:20260722T110000,20260721T110000',
    'EXDATE:20260727T150000Z',
  ] as const
  const original = parseMailInvitation('series', calendar(fields.join('\r\n')), 'REQUEST')!
  const equivalent = parseMailInvitation(
    'redelivery',
    calendar(
      [
        fields[0],
        fields[3],
        'rdate;TZID="America/New_York":20260721T110000',
        'rdate;TZID=America/New_York:20260722T110000',
        'rrule:count=1000000;byday=mo,we;freq=weekly;interval=1;wkst=MO',
      ].join('\r\n'),
    ),
    'REQUEST',
  )!
  expect(original.request?.recurrenceTimeBasis).toEqual({
    kind: 'utc',
    zone: 'UTC',
    wallStart: '2026-07-20T15:00:00',
    customKey: null,
  })
  expect(original.request?.recurrence).toEqual([
    'EXDATE:20260727T150000Z',
    'RDATE;TZID=America/New_York:20260721T110000,20260722T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=1000000',
  ])
  expect(equivalent.request?.recurrence).toEqual(original.request?.recurrence)
  expect(equivalent.details.identity.materialKey).toBe(original.details.identity.materialKey)

  const changed = parseMailInvitation(
    'edited',
    calendar(fields.join('\r\n').replace('20260727', '20260728')),
    'REQUEST',
  )!
  expect(changed.details.identity.materialKey).not.toBe(original.details.identity.materialKey)
})

it('distinguishes recurring zone rules even when the first winter instant is identical', () => {
  const parse = (tzid: string, definition = '') =>
    parseMailInvitation(
      'series',
      calendar(`DTSTART;TZID=${tzid}:20260105T110000\r\nRRULE:FREQ=WEEKLY`, { definition }),
      'REQUEST',
    )!
  const newYork = parse('America/New_York')
  const alias = parse('US/Eastern')
  const fixedZone = parse('Etc/GMT+5')
  const customDefinition = zone(fixed.replaceAll('+0530', '-0500')).replace(
    'Custom Clock',
    'America/New_York',
  )
  const customZone = parse('America/New_York', customDefinition)
  const changedFuture = parse(
    'America/New_York',
    customDefinition.replace(
      'END:VTIMEZONE',
      [
        'BEGIN:DAYLIGHT',
        'DTSTART:20400311T020000',
        'TZOFFSETFROM:-0500',
        'TZOFFSETTO:-0400',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
      ].join('\r\n'),
    ),
  )
  for (const invitation of [newYork, alias, fixedZone, customZone, changedFuture]) {
    expect(invitation.details.start).toBe('2026-01-05T16:00:00.000Z')
    expect(invitation.request?.recurrence).toEqual(['RRULE:FREQ=WEEKLY'])
  }
  expect(newYork.request?.recurrenceTimeBasis).toEqual({
    kind: 'iana',
    zone: 'America/New_York',
    wallStart: '2026-01-05T11:00:00',
    customKey: null,
  })
  expect(alias.request?.recurrenceTimeBasis).toEqual(newYork.request?.recurrenceTimeBasis)
  expect(alias.details.identity.materialKey).toBe(newYork.details.identity.materialKey)
  expect(fixedZone.request?.recurrenceTimeBasis).toMatchObject({ kind: 'iana', zone: 'Etc/GMT+5' })
  expect(customZone.request?.recurrenceTimeBasis).toMatchObject({
    kind: 'custom',
    zone: 'America/New_York',
    customKey: expect.any(String),
  })
  expect(changedFuture.request?.recurrenceTimeBasis?.customKey).not.toBe(
    customZone.request?.recurrenceTimeBasis?.customKey,
  )
  expect(
    new Set(
      [newYork, fixedZone, customZone, changedFuture].map(
        ({ details }) => details.identity.materialKey,
      ),
    ).size,
  ).toBe(4)
})

it.each(['RRULE:FREQ=WEEKLY;COUNT=3extra', 'EXDATE:20260727T150000Zextra'])(
  'does not turn a malformed recurrence line into valid overlap evidence: %s',
  (recurrence) => {
    expect(
      parseMailInvitation('part', calendar(`DTSTART:20260720T150000Z\r\n${recurrence}`), 'REQUEST'),
    ).toMatchObject({
      request: null,
      details: { identity: { materialKey: null } },
    })
  },
)

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
    expect(invitationReplyStatus(sent, identity, organizer, attendee)).toBe('unresolved')
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
      revisionMaterial: { explicitFields: { conferenceUrl: true } },
    })
  }
  expect(invites[0]!.details.identity.materialKey).toBe(invites[1]!.details.identity.materialKey)
})
