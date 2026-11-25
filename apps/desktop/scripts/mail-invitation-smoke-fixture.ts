import assert from 'node:assert/strict'
import ICAL from 'ical.js'
import type { CalendarListEntry, InviteAnswer, RawEvent } from '../src/plugins/google/main/calendar'

export const remote = 'smoke/invitations'
export const organizer = { name: 'Morgan Fixture', email: 'organizer@localhost' }
export const mailboxA = { sub: 'synthetic-a', email: 'mailbox-a@example.test' }
export const mailboxB = { sub: 'synthetic-b', email: 'mailbox-b@example.test' }
type Mailbox = typeof mailboxA

const start = '2026-11-18T15:20:00Z'
const end = '2026-11-18T16:05:00Z'
const mailAt = Date.parse('2026-11-12T10:00:00Z')
const guest = { email: 'other-guest@example.test', responseStatus: 'tentative' }
const sequence = 3

export const inline = {
  id: 'threadinline',
  subject: 'Operations mail: room booking',
  title: 'Harbor design review',
  location: 'Studio 14, Harbor House',
  join: 'https://meet.google.com/abc-defg-hij',
  uid: 'harbor-review@example.test',
  attached: false,
}
export const attachment = {
  id: 'threadattachment',
  subject: 'Operations mail: attached invitation',
  title: 'Field workshop briefing',
  location: 'Training room 5',
  join: 'https://xn--bcher-kva.example.test/meet.google.com',
  uid: 'field-workshop@example.test',
  attached: true,
}
export const other = {
  ...inline,
  subject: 'Second mailbox: its own invitation',
  title: 'Second mailbox planning',
  location: 'East Annex',
  uid: 'second-mailbox@example.test',
}
type Invite = typeof inline & { scope?: 'series' | 'occurrence' }

export const series: Invite = {
  ...inline,
  id: 'threadseries',
  subject: 'Operations mail: review series and moved occurrence',
  title: 'Harbor planning series',
  uid: 'harbor-planning@example.test',
  scope: 'series',
}
export const occurrence: Invite = {
  ...series,
  title: 'Harbor planning moved occurrence',
  scope: 'occurrence',
}

const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me'
const googleGmail = 'https://www.googleapis.com/gmail/v1/users/me'
const calendar = 'https://www.googleapis.com/calendar/v3'
const people = 'https://people.googleapis.com/v1'
const eventId = 'fixture-event'
export const attachmentEventId = 'fixture-workshop'
const seriesId = 'fixture-series'
export const occurrenceId = 'fixture-occurrence'
const occurrenceSlot = '2026-11-25T15:20:00Z'
const occurrenceStart = '2026-11-25T16:20:00Z'
const occurrenceEnd = '2026-11-25T17:05:00Z'
const primary = `${calendar}/calendars/primary/events`
const sharedCalendar = 'fixture-shared@example.test'
const sentThreadId = 'thread-sent-workshop'
const trashedReplyId = 'fixture-trashed-reply'
const trashedThreadId = 'thread-trashed-workshop'
const wire = (text: string) => Buffer.from(text).toString('base64url')
const header = (name: string, value: string) => ({ name, value })
const mailId = (invite: Invite) =>
  `mail-${invite.id}${invite.scope === 'occurrence' ? '-occurrence' : ''}`
const rfcId = (invite: Invite) => `<${mailId(invite)}@example.test>`
const token = (mailbox: Mailbox) => `offline-only-${mailbox.sub}`
export { token as fixtureToken }

type Collections = {
  'calendar#events': RawEvent
  'calendar#calendarList': CalendarListEntry
}

function calendarItems<K extends keyof Collections>(kind: K, items?: Collections[K][]) {
  return Response.json(items === undefined ? { kind } : { kind, items })
}

function googleError(code: number, status: string, reason: string, message: string) {
  return Response.json(
    { error: { code, status, message, errors: [{ message, domain: 'global', reason }] } },
    { status: code },
  )
}

function notFound() {
  return googleError(404, 'NOT_FOUND', 'notFound', 'Not Found')
}

const zoneId = 'America/New_York'
const zoneDefinition = [
  'BEGIN:VTIMEZONE',
  `TZID:${zoneId}`,
  'BEGIN:DAYLIGHT',
  'DTSTART:20070311T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'DTSTART:20071104T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
]

function invitationSource(invite: Invite, mailbox: Mailbox) {
  const zoned = invite.attached || invite.scope !== undefined
  const timeField = (name: string, wall: string, utc: string) =>
    zoned ? `${name};TZID=${zoneId}:${wall}` : `${name}:${utc}Z`
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Holi//Offline Invitation Fixture//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    ...(zoned ? zoneDefinition : []),
    'BEGIN:VEVENT',
    `UID:${invite.uid}`,
    `SEQUENCE:${sequence}`,
    'DTSTAMP:20261112T100000Z',
    ...(invite.scope === 'occurrence'
      ? [
          timeField('RECURRENCE-ID', '20261125T102000', '20261125T152000'),
          timeField('DTSTART', '20261125T112000', '20261125T162000'),
          timeField('DTEND', '20261125T120500', '20261125T170500'),
        ]
      : [
          timeField('DTSTART', '20261118T102000', '20261118T152000'),
          timeField('DTEND', '20261118T110500', '20261118T160500'),
        ]),
    ...(invite.scope === 'series' ? ['RRULE:FREQ=WEEKLY;COUNT=4'] : []),
    `SUMMARY:${invite.title}`,
    `LOCATION:${invite.location.replaceAll(',', '\\,')}`,
    ...(invite.attached ? [`URL:${invite.join}`] : [`DESCRIPTION:Join ${invite.join}`]),
    `ORGANIZER;CN=${organizer.name}:mailto:${organizer.email}`,
    `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${mailbox.email}`,
    `ATTENDEE:mailto:${guest.email}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

type SentReply = ReturnType<typeof readReply> & { id: string }

function message(invite: Invite, mailbox: Mailbox, sent?: SentReply) {
  const body = sent?.source ?? invitationSource(invite, mailbox)
  const attachmentId = !sent && invite.attached ? 'calendar-attachment' : undefined
  const method = sent ? 'REPLY' : 'REQUEST'
  const text = sent
    ? 'This message contains a calendar response.'
    : 'Details are in the calendar invitation.'
  return {
    id: sent?.id ?? mailId(invite),
    threadId: sent ? sentThreadId : invite.id,
    internalDate: String(mailAt + (sent ? 60_000 : 0)),
    snippet: text,
    labelIds: sent ? ['SENT'] : ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        header('Content-Type', 'multipart/mixed; boundary=fixture'),
        // A local-only sender domain keeps the mail list on its initials avatar.
        header('From', sent ? mailbox.email : `${organizer.name} <${organizer.email}>`),
        header('To', sent?.to ?? mailbox.email),
        header('Subject', sent ? `Re: ${invite.subject}` : invite.subject),
        header('Date', new Date(mailAt + (sent ? 60_000 : 0)).toUTCString()),
        header('Message-ID', sent?.rfcId ?? rfcId(invite)),
        ...(sent
          ? [header('In-Reply-To', sent.parent), header('References', sent.references)]
          : []),
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: wire(text), size: Buffer.byteLength(text) } },
        {
          mimeType: 'text/calendar',
          ...(attachmentId || sent ? { filename: sent ? 'invite.ics' : 'meeting.ics' } : {}),
          headers: [
            header('Content-Type', `text/calendar; method=${method}; charset=UTF-8`),
            header(
              'Content-Disposition',
              attachmentId
                ? 'attachment; filename="meeting.ics"'
                : sent
                  ? 'inline; filename="invite.ics"'
                  : 'inline',
            ),
          ],
          body: {
            size: Buffer.byteLength(body),
            ...(attachmentId ? { attachmentId } : { data: wire(body) }),
          },
        },
      ],
    },
  }
}

function readReply(raw: string, invite: Invite, mailbox: Mailbox) {
  const mime = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .replace(/\r\n[ \t]/g, ' ')
  const headers = mime.split('\r\n\r\n')[0]!
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'im').exec(headers)?.[1]?.trim()
  assert.equal(field('From'), mailbox.email)
  const to = field('To')
  assert.equal(to, organizer.email)
  assert.equal(field('Cc'), undefined)
  assert.equal(field('Bcc'), undefined)
  const outgoingId = field('Message-ID')
  const parent = field('In-Reply-To')
  const references = field('References')
  assert(outgoingId && /^<[a-f0-9-]{36}@holi\.invalid>$/.test(outgoingId))
  assert.equal(parent, rfcId(invite))
  assert(references && references.split(' ').includes(parent))
  assert.equal(field('Subject'), `Re: ${invite.subject}`)
  const part =
    /^Content-Type: text\/calendar; method=REPLY[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)(?=--)/im.exec(
      mime,
    )
  assert(part?.[1], 'the outgoing message must contain a base64 text/calendar REPLY part')
  assert.match(part[0], /^Content-Transfer-Encoding: base64\s*$/im)
  const source = Buffer.from(part[1], 'base64').toString('utf8')
  const reply = new ICAL.Component(ICAL.parse(source))
  assert.equal(reply.getFirstPropertyValue('method'), 'REPLY')
  assert.equal(reply.getAllSubcomponents('vevent').length, 1)
  const event = reply.getFirstSubcomponent('vevent')!
  assert.equal(event.getFirstPropertyValue('uid'), invite.uid)
  assert.equal(event.getFirstPropertyValue('sequence'), sequence)
  assert.equal(event.getFirstPropertyValue('organizer'), `mailto:${organizer.email}`)
  assert(!event.hasProperty('recurrence-id'), 'this invitation is not a recurring occurrence')
  const repliedStart = event.getFirstProperty('dtstart')
  if (repliedStart) {
    assert.equal(repliedStart.getParameter('tzid'), zoneId)
    assert.equal(repliedStart.getFirstValue()?.toString(), '2026-11-18T10:20:00')
    assert(
      reply
        .getAllSubcomponents('vtimezone')
        .some((definition) => definition.getFirstPropertyValue('tzid') === zoneId),
      'a zoned DTSTART in the reply requires its VTIMEZONE',
    )
  }
  const attendees = event.getAllProperties('attendee')
  assert.deepEqual(
    attendees.map((p) => p.getFirstValue()),
    [`mailto:${mailbox.email}`],
  )
  const status = attendees[0]?.getParameter('partstat')
  assert(typeof status === 'string' && ['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(status))
  return {
    source,
    to,
    answer: status.toLowerCase() as InviteAnswer,
    rfcId: outgoingId,
    parent,
    references,
  }
}

/** Synthetic Google owns the authoritative attendee state and persisted Sent message.
 * The same thread ID in the other mailbox belongs to a different event. */
export function createInvitationTransport() {
  const originalAttendee = {
    email: mailboxA.email,
    self: true,
    responseStatus: 'needsAction',
    comment: 'Fixture comment',
  }
  const targets = new Map([
    [eventId, { invite: inline as Invite, version: 1, attendee: { ...originalAttendee } }],
    [seriesId, { invite: series, version: 1, attendee: { ...originalAttendee } }],
    [occurrenceId, { invite: occurrence, version: 1, attendee: { ...originalAttendee } }],
  ])
  let sent: SentReply | undefined
  let collideNextSend = false
  let trashedReply: ReturnType<typeof message> | undefined
  let refuseNextSend = false
  let missNextAttachmentCollection = false
  let losePatchAcknowledgement = false
  let tokenRefreshes = 0
  let heldCalendarRead: { skip: number; entered: () => void; released: Promise<void> } | undefined
  let heldSentAcknowledgement: Promise<void> | undefined
  const writes: ({
    account: string
    resource: string
    answer: InviteAnswer
    status: number | 'transport error'
    uid: string
  } &
    // Calendar's organizer identifies the event; the fixture does not observe notifications.
    (
      | { method: 'PATCH'; organizerEmail: string; sendUpdates: 'all'; ifMatch: string }
      | { method: 'POST'; to: string; messageId?: string }
    ))[] = []
  const rejected: string[] = []
  let attachmentReads = 0
  let sentReceiptMisses = 0
  let sentReceiptReads = 0
  let sentIdSearches = 0
  let trashedReplyIndexHits = 0
  let trashedReplyReads = 0
  let attachmentCopyReads = 0
  let pendingReceiptIndex = false
  const calendarReadbackVersions = new Set<number>()
  const requestCounts: Record<string, number> = {}
  const event = (id: string) => {
    const { invite, version, attendee } = targets.get(id)!
    // Calendar serializes instants and separately names the series expansion zone.
    const zone = invite.attached || invite.scope ? { timeZone: zoneId } : {}
    return {
      kind: 'calendar#event',
      id,
      etag: `"${id}-${version}"`,
      iCalUID: invite.uid,
      sequence,
      summary: invite.title,
      location: invite.location,
      ...(invite.attached ? {} : { hangoutLink: invite.join }),
      htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
      organizer: { email: organizer.email, self: false },
      status: 'confirmed',
      start: { dateTime: id === occurrenceId ? occurrenceStart : start, ...zone },
      end: { dateTime: id === occurrenceId ? occurrenceEnd : end, ...zone },
      attendees: [attendee, guest],
      ...(id === seriesId ? { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] } : {}),
      ...(id === occurrenceId
        ? { recurringEventId: seriesId, originalStartTime: { dateTime: occurrenceSlot, ...zone } }
        : {}),
    } satisfies RawEvent
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const resource = `${url.origin}${url.pathname}`
    const summary = `${method} ${resource}`
    try {
      if (method === 'POST' && resource === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(String(init?.body))
        assert.equal(form.get('client_id'), 'offline-fixture')
        assert.equal(form.get('grant_type'), 'refresh_token')
        assert.equal(form.get('refresh_token'), `refresh-${mailboxA.sub}`)
        tokenRefreshes++
        return Response.json({ access_token: token(mailboxA), expires_in: 3600 })
      }
      const mailbox = [mailboxA, mailboxB].find(
        (item) => headers.get('Authorization') === `Bearer ${token(item)}`,
      )
      if (!mailbox) {
        rejected.push(`${summary}: Google call did not use a fixture account`)
        return googleError(401, 'UNAUTHENTICATED', 'authError', 'Invalid Credentials')
      }
      const key = `${mailbox.sub} ${summary}`
      requestCounts[key] = (requestCounts[key] ?? 0) + 1
      const invites = mailbox === mailboxA ? [inline, attachment, series] : [other]
      const query = url.searchParams
      if (method === 'GET') {
        if (resource === `${people}/people/me/connections`)
          return Response.json({ connections: [] })
        if (resource === `${people}/otherContacts`) return Response.json({ otherContacts: [] })
        const calendarList = `${calendar}/users/me/calendarList`
        if (resource === calendarList || resource.startsWith(`${calendarList}/`)) {
          const calendars: CalendarListEntry[] = [
            {
              kind: 'calendar#calendarListEntry',
              id: mailbox.email,
              summary: 'Operations Calendar',
              primary: true,
              selected: true,
              accessRole: 'owner',
            },
          ]
          if (mailbox === mailboxA)
            calendars.push({
              kind: 'calendar#calendarListEntry',
              id: sharedCalendar,
              summary: 'Shared Calendar',
              accessRole: 'reader',
            })
          if (resource === calendarList) return calendarItems('calendar#calendarList', calendars)
          const id = decodeURIComponent(resource.slice(calendarList.length + 1))
          const entry = calendars.find((row) => (id === 'primary' ? row.primary : row.id === id))
          return entry ? Response.json(entry) : notFound()
        }
        if (
          resource === primary ||
          resource === `${calendar}/calendars/${encodeURIComponent(mailbox.email)}/events`
        ) {
          const uid = query.get('iCalUID')
          assert(uid, 'invitation reads must select an iCalUID')
          if (query.get('singleEvents') === 'true') {
            assert.equal(mailbox, mailboxA)
            assert.equal(uid, series.uid)
            assert.equal(query.get('orderBy'), 'startTime')
            assert.equal(query.get('maxResults'), '1')
            assert.equal(query.get('showDeleted'), 'false')
            const from = Date.parse(query.get('timeMin') ?? '')
            assert(Number.isFinite(from))
            const { recurrence: _recurrence, ...master } = event(seriesId)
            const upcoming = [0, 1, 2, 3]
              .map((week) => {
                if (week === 1) return event(occurrenceId)
                const shift = (value: string) =>
                  new Date(Date.parse(value) + week * 604_800_000).toISOString()
                const dateTime = shift(start)
                const id = `${seriesId}-${week}`
                return {
                  ...master,
                  id,
                  htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
                  recurringEventId: seriesId,
                  originalStartTime: { ...master.start, dateTime },
                  start: { ...master.start, dateTime },
                  end: { ...master.end, dateTime: shift(end) },
                }
              })
              .filter((item) => Date.parse(item.end.dateTime) > from)
            const offset = Number(query.get('pageToken') ?? '0')
            assert(Number.isInteger(offset) && offset >= 0)
            return Response.json({
              kind: 'calendar#events',
              items: upcoming.slice(offset, offset + 1),
              nextPageToken: offset + 1 < upcoming.length ? String(offset + 1) : undefined,
            })
          }
          assert.equal(query.get('singleEvents'), 'false')
          assert.equal(query.get('showDeleted'), 'true')
          const matched = mailbox === mailboxA && uid === inline.uid
          if (matched) {
            const version = targets.get(eventId)!.version
            if (version > 1) calendarReadbackVersions.add(version)
            if (heldCalendarRead && heldCalendarRead.skip-- === 0) {
              const pending = heldCalendarRead
              heldCalendarRead = undefined
              pending.entered()
              await pending.released
            }
            return calendarItems('calendar#events', [event(eventId)])
          }
          if (mailbox === mailboxA && uid === series.uid)
            return calendarItems('calendar#events', [event(seriesId)])
          if (mailbox === mailboxA && uid === attachment.uid && missNextAttachmentCollection) {
            missNextAttachmentCollection = false
            return notFound()
          }
          if (mailbox === mailboxA && uid === attachment.uid && targets.has(attachmentEventId)) {
            attachmentCopyReads++
            return calendarItems('calendar#events', [event(attachmentEventId)])
          }
          return calendarItems('calendar#events')
        }
        if (resource === `${calendar}/calendars/${encodeURIComponent(sharedCalendar)}/events`) {
          if (mailbox !== mailboxA) return notFound()
          return calendarItems('calendar#events', [])
        }
        if (resource === `${primary}/${seriesId}/instances`) {
          if (mailbox !== mailboxA) return notFound()
          assert.equal(query.get('showDeleted'), 'true')
          assert.equal(Date.parse(query.get('originalStart') ?? ''), Date.parse(occurrenceSlot))
          return calendarItems('calendar#events', [event(occurrenceId)])
        }
        // A collection denial isn't an empty list; a missing exact event isn't
        // a collection response at all. Keep both distinct from typed empties.
        if (resource.startsWith(`${calendar}/calendars/`) && resource.endsWith('/events'))
          return notFound()
        if (resource.startsWith(`${primary}/`)) {
          const id = resource.slice(primary.length + 1)
          if (!id.includes('/'))
            return mailbox === mailboxA && targets.has(id) ? Response.json(event(id)) : notFound()
        }
        const api = resource.startsWith(`${gmail}/`) ? gmail : googleGmail
        if (resource === `${api}/settings/sendAs`)
          return Response.json({ sendAs: [{ sendAsEmail: mailbox.email, isPrimary: true }] })
        if (resource === `${api}/profile`)
          return Response.json({ emailAddress: mailbox.email, historyId: '100' })
        if (resource === `${api}/history`) return Response.json({ historyId: '100', history: [] })
        if (resource === `${api}/labels/INBOX`)
          return Response.json({ threadsTotal: invites.length, threadsUnread: 0 })
        if (resource === `${api}/labels`) return Response.json({ labels: [] })
        if (resource === `${api}/drafts`) return Response.json({ drafts: [] })
        const reply = mailbox === mailboxA && sent ? message(attachment, mailbox, sent) : null
        if (resource === `${api}/threads`) {
          const q = query.get('q') ?? ''
          const window = /^has:attachment filename:ics after:(\d+) before:(\d+)$/.exec(q)
          const matches = window
            ? invites.filter((invite) => {
                const incoming = message(invite, mailbox)
                const time = Number(incoming.internalDate) / 1000
                return (
                  time >= Number(window[1]) &&
                  time < Number(window[2]) &&
                  incoming.payload.parts.some(
                    (part) => 'filename' in part && part.filename?.endsWith('.ics'),
                  )
                )
              })
            : q.includes('is:unread') || q.includes('is:starred')
              ? []
              : q.includes('in:sent')
                ? reply
                  ? [{ id: reply.threadId }]
                  : []
                : invites
          return Response.json({ threads: matches.map(({ id }) => ({ id })) })
        }
        const collider = mailbox === mailboxA ? trashedReply : undefined
        if (resource === `${api}/messages`) {
          assert.equal(query.get('maxResults'), '10')
          const q = query.get('q')
          assert.match(q ?? '', /^rfc822msgid:[a-f0-9-]{36}@holi\.invalid$/)
          sentIdSearches++
          const includeSpamTrash = query.get('includeSpamTrash') === 'true'
          const requiredLabels = query.getAll('labelIds')
          const owned = [
            ...invites.flatMap((invite) =>
              invite === series
                ? [message(invite, mailbox), message(occurrence, mailbox)]
                : [message(invite, mailbox)],
            ),
            ...(reply ? [reply] : []),
            ...(collider ? [collider] : []),
          ].filter(
            ({ labelIds, payload }) =>
              requiredLabels.every((label) => labelIds.includes(label)) &&
              (includeSpamTrash || (!labelIds.includes('SPAM') && !labelIds.includes('TRASH'))) &&
              payload.headers.some(
                ({ name, value }) =>
                  name === 'Message-ID' && q === `rfc822msgid:${value.slice(1, -1)}`,
              ),
          )
          if (owned.some(({ id }) => id === collider?.id)) trashedReplyIndexHits++
          return Response.json({ messages: owned.map(({ id, threadId }) => ({ id, threadId })) })
        }
        const format = query.get('format')
        if (reply && resource === `${api}/messages/${reply.id}`) {
          assert.equal(format, 'full')
          assert(!query.has('fields'))
          if (pendingReceiptIndex) {
            // The accepted receipt can briefly precede the message resource.
            pendingReceiptIndex = false
            sentReceiptMisses++
            return notFound()
          }
          sentReceiptReads++
          return Response.json(reply)
        }
        if (resource === `${api}/messages/${trashedReplyId}`) {
          assert.equal(format, 'full')
          assert(!query.has('fields'))
          if (!collider) return notFound()
          trashedReplyReads++
          return Response.json(collider)
        }
        const threadResource = (id: string, messages: ReturnType<typeof message>[]) => {
          assert(format === 'full' || format === 'metadata')
          assert(!query.has('fields'))
          const requested = new Set(
            query.getAll('metadataHeaders').map((name) => name.toLowerCase()),
          )
          return Response.json({
            id,
            historyId: '100',
            snippet: messages[0]?.snippet,
            messages:
              format === 'metadata'
                ? messages.map(({ payload, ...item }) => ({
                    ...item,
                    payload: {
                      mimeType: payload.mimeType,
                      headers: payload.headers.filter(
                        ({ name }) => requested.size === 0 || requested.has(name.toLowerCase()),
                      ),
                    },
                  }))
                : messages,
          })
        }
        if (reply && resource === `${api}/threads/${reply.threadId}`)
          return threadResource(reply.threadId, [reply])
        if (resource === `${api}/threads/${trashedThreadId}`)
          return collider ? threadResource(collider.threadId, [collider]) : notFound()
        for (const invite of invites) {
          const incoming = message(invite, mailbox)
          if (resource === `${api}/threads/${invite.id}`)
            return threadResource(
              invite.id,
              invite === series ? [incoming, message(occurrence, mailbox)] : [incoming],
            )
          const selected =
            resource === `${api}/messages/${incoming.id}`
              ? incoming
              : invite === series && resource === `${api}/messages/${mailId(occurrence)}`
                ? message(occurrence, mailbox)
                : null
          if (selected && format === 'full') {
            const fields = query.get('fields')
            if (fields === null) return Response.json(selected)
            // This fixture only serves the production headers-only MIME probe.
            // Do not invent support for other field masks, or return fields
            // (e.g. filename/body) the probe could not obtain from Gmail.
            const headersOnly = 'mimeType,headers(name,value)'
            assert.equal(
              fields,
              `id,threadId,payload(${'mimeType,headers(name,value),parts('.repeat(8)}${headersOnly},parts(mimeType)${')'.repeat(9)}`,
            )
            const { id, threadId, payload } = selected
            return Response.json({
              id,
              threadId,
              payload: {
                mimeType: payload.mimeType,
                headers: payload.headers,
                parts: payload.parts.map((part) => ({
                  mimeType: part.mimeType,
                  ...('headers' in part ? { headers: part.headers } : {}),
                })),
              },
            })
          }
          if (
            invite.attached &&
            resource === `${api}/messages/${incoming.id}/attachments/calendar-attachment`
          ) {
            attachmentReads++
            const source = invitationSource(invite, mailbox)
            return Response.json({ data: wire(source), size: Buffer.byteLength(source) })
          }
        }
      }
      if (method === 'PATCH' && resource.startsWith(`${primary}/`)) {
        const id = resource.slice(primary.length + 1)
        const target = targets.get(id)
        if (!target && !id.includes('/')) return notFound()
        assert(
          target && (id === eventId || id === occurrenceId || id === attachmentEventId),
          'must only write to the selected event or occurrence',
        )
        if (mailbox !== mailboxA) {
          rejected.push(`${summary}: must not write to a different Google account`)
          return notFound()
        }
        const copy = event(id)
        const ifMatch = headers.get('If-Match') ?? ''
        const sendUpdates = query.get('sendUpdates')
        assert.equal(ifMatch, copy.etag)
        assert.equal(sendUpdates, 'all')
        const body = JSON.parse(String(init?.body))
        const answer: InviteAnswer = body.attendees?.[0]?.responseStatus
        assert(['accepted', 'tentative', 'declined'].includes(answer))
        assert.deepEqual(body, {
          attendeesOmitted: true,
          attendees: [{ ...target.attendee, responseStatus: answer }],
        })
        writes.push({
          account: mailbox.sub,
          method,
          resource: url.pathname,
          organizerEmail: copy.organizer.email,
          answer,
          status: losePatchAcknowledgement ? 'transport error' : 200,
          ifMatch,
          sendUpdates,
          uid: target.invite.uid,
        })
        target.attendee = { ...target.attendee, responseStatus: answer }
        target.version++
        if (losePatchAcknowledgement) {
          losePatchAcknowledgement = false
          // Google applied the PATCH; the connection closed before the client saw a response.
          return Promise.reject(
            new Error('Fixture Calendar connection closed after applying PATCH'),
          )
        }
        return Response.json(event(id))
      }
      if (method === 'POST' && resource === `${gmail}/messages/send`) {
        if (mailbox !== mailboxA) {
          rejected.push(`${summary}: must not send from a different Google account`)
          return googleError(403, 'PERMISSION_DENIED', 'forbidden', 'Forbidden')
        }
        const body = JSON.parse(String(init?.body))
        assert.equal(
          body.threadId,
          attachment.id,
          'iTIP Reply must request threading with the original invitation',
        )
        const reply = readReply(body.raw, attachment, mailbox)
        const evidence = {
          account: mailbox.sub,
          method,
          resource: url.pathname,
          to: reply.to,
          answer: reply.answer,
          uid: attachment.uid,
        } as const
        if (refuseNextSend) {
          refuseNextSend = false
          writes.push({ ...evidence, status: 403 })
          return googleError(
            403,
            'PERMISSION_DENIED',
            'insufficientPermissions',
            'Request had insufficient authentication scopes.',
          )
        }
        assert(!sent, 'the fixture should receive exactly one accepted Gmail REPLY')
        sent = { id: 'fixture-sent-reply', ...reply }
        if (collideNextSend) {
          collideNextSend = false
          trashedReply = {
            ...message(attachment, mailbox, sent),
            id: trashedReplyId,
            threadId: trashedThreadId,
            labelIds: ['SENT', 'TRASH'],
          }
        }
        pendingReceiptIndex = true
        writes.push({ ...evidence, status: 200, messageId: sent.id })
        await heldSentAcknowledgement
        // Gmail owns the final grouping. The reply still references the original
        // invitation but its message is never available from that thread's GET.
        return Response.json({ id: sent.id, threadId: sentThreadId, labelIds: ['SENT'] })
      }
      throw new Error('Unhandled fixture endpoint')
    } catch (error) {
      // Even helpers that catch Google read errors must not hide an unsupported request.
      rejected.push(`${summary}: ${String(error)}`)
      throw error
    }
  }
  return {
    fetch,
    writes,
    rejected,
    requestCounts,
    missAttachmentCollection: () => {
      missNextAttachmentCollection = true
    },
    refuseNextSend: () => {
      refuseNextSend = true
    },
    collideNextSendInTrash: () => {
      collideNextSend = true
    },
    removeTrashedReply: () => {
      trashedReply = undefined
    },
    setCalendarCopyOfAttachment(responseStatus: InviteAnswer | 'needsAction') {
      targets.set(attachmentEventId, {
        invite: attachment,
        version: (targets.get(attachmentEventId)?.version ?? 0) + 1,
        attendee: { ...originalAttendee, responseStatus },
      })
    },
    loseNextPatchAcknowledgement: () => {
      losePatchAcknowledgement = true
    },
    holdSentAcknowledgement() {
      let release!: () => void
      heldSentAcknowledgement = new Promise<void>((resolve) => (release = resolve))
      return release
    },
    holdCalendarRead(skip = 0) {
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      heldCalendarRead = { skip, entered: enter, released }
      return { entered, release }
    },
    snapshot: () => ({
      attachmentReads,
      sentReceiptMisses,
      sentReceiptReads,
      sentIdSearches,
      trashedReplyIndexHits,
      trashedReplyReads,
      attachmentCopyReads,
      tokenRefreshes,
      calendarReadbacks: calendarReadbackVersions.size,
      calendarResponse: targets.get(eventId)!.attendee.responseStatus,
      attachmentResponse: targets.get(attachmentEventId)?.attendee.responseStatus ?? null,
      seriesResponse: targets.get(seriesId)!.attendee.responseStatus,
      occurrenceResponse: targets.get(occurrenceId)!.attendee.responseStatus,
      otherGuest: event(eventId).attendees[1],
    }),
  }
}
