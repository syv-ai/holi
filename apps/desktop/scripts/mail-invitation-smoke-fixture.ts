import assert from 'node:assert/strict'
import ICAL from 'ical.js'
import type { InviteAnswer } from '../src/plugins/google/main/calendar'

export const remote = 'smoke/invitations'
export const organizer = { name: 'Morgan Fixture', email: 'organizer@example.test' }
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
type Invite = typeof inline

const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me'
const googleGmail = 'https://www.googleapis.com/gmail/v1/users/me'
const calendar = 'https://www.googleapis.com/calendar/v3'
const people = 'https://people.googleapis.com/v1'
const eventId = 'fixture-event'
const wire = (text: string) => Buffer.from(text).toString('base64url')
const header = (name: string, value: string) => ({ name, value })
const mailId = (invite: Invite) => `mail-${invite.id}`
const rfcId = (invite: Invite) => `<${mailId(invite)}@example.test>`
const token = (mailbox: Mailbox) => `offline-only-${mailbox.sub}`
export { token as fixtureToken }

function invitationSource(invite: Invite, mailbox: Mailbox) {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Holi//Offline Invitation Fixture//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${invite.uid}`,
    `SEQUENCE:${sequence}`,
    'DTSTAMP:20261112T100000Z',
    'DTSTART:20261118T152000Z',
    'DTEND:20261118T160500Z',
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
    threadId: invite.id,
    internalDate: String(mailAt + (sent ? 60_000 : 0)),
    snippet: text,
    labelIds: sent ? ['SENT'] : ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        header('Content-Type', 'multipart/mixed; boundary=fixture'),
        // A local-only sender domain keeps the mail list on its initials avatar.
        header('From', sent ? mailbox.email : 'Operations Desk <dispatch@localhost>'),
        header('To', sent ? organizer.email : mailbox.email),
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
  assert.equal(field('To'), organizer.email)
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
  const attendees = event.getAllProperties('attendee')
  assert.deepEqual(
    attendees.map((p) => p.getFirstValue()),
    [`mailto:${mailbox.email}`],
  )
  const status = attendees[0]?.getParameter('partstat')
  assert(typeof status === 'string' && ['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(status))
  return {
    source,
    answer: status.toLowerCase() as InviteAnswer,
    rfcId: outgoingId,
    parent,
    references,
  }
}

/** Synthetic Google owns the authoritative attendee state and persisted Sent message.
 * The same thread ID in the other mailbox belongs to a different event. */
export function createInvitationTransport() {
  let attendee = {
    email: mailboxA.email,
    self: true,
    responseStatus: 'needsAction',
    comment: 'Fixture comment',
  }
  let version = 1
  let sent: SentReply | undefined
  let refuseNextSend = false
  let losePatchAcknowledgement = false
  let tokenRefreshes = 0
  let heldCalendarRead: { skip: number; entered: () => void; released: Promise<void> } | undefined
  const writes: {
    account: string
    method: 'PATCH' | 'POST'
    resource: string
    to: string
    answer: InviteAnswer
    status: number | 'transport error'
    uid?: string
    sendUpdates?: string
    ifMatch?: string
    messageId?: string
  }[] = []
  const rejected: string[] = []
  let attachmentReads = 0
  let sentReceiptReads = 0
  let sentIdSearches = 0
  let pendingReceiptIndex = false
  const calendarReadbackVersions = new Set<number>()
  const requestCounts: Record<string, number> = {}
  const event = () => ({
    id: eventId,
    etag: `"fixture-${version}"`,
    iCalUID: inline.uid,
    sequence,
    summary: inline.title,
    location: inline.location,
    hangoutLink: inline.join,
    htmlLink: 'https://calendar.google.com/calendar/event?eid=synthetic-fixture',
    organizer: { email: organizer.email, self: false },
    status: 'confirmed',
    start: { dateTime: start },
    end: { dateTime: end },
    attendees: [attendee, guest],
  })

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
      assert(mailbox, 'Google call did not use a fixture account')
      const key = `${mailbox.sub} ${summary}`
      requestCounts[key] = (requestCounts[key] ?? 0) + 1
      const invites = mailbox === mailboxA ? [inline, attachment] : [other]
      const query = url.searchParams
      if (method === 'GET') {
        if (resource === `${people}/people/me/connections`)
          return Response.json({ connections: [] })
        if (resource === `${people}/otherContacts`) return Response.json({ otherContacts: [] })
        if (resource === `${calendar}/users/me/calendarList`) {
          return Response.json({
            items: [{ id: mailbox.email, primary: true, selected: true, accessRole: 'owner' }],
          })
        }
        if (
          resource === `${calendar}/calendars/primary/events` ||
          resource === `${calendar}/calendars/${encodeURIComponent(mailbox.email)}/events`
        ) {
          const matched = mailbox === mailboxA && query.get('iCalUID') === inline.uid
          if (matched && version > 1) calendarReadbackVersions.add(version)
          if (matched && heldCalendarRead && heldCalendarRead.skip-- === 0) {
            const pending = heldCalendarRead
            heldCalendarRead = undefined
            pending.entered()
            await pending.released
          }
          return Response.json({ items: matched ? [event()] : [] })
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
                ? invites.filter((invite) => invite === attachment && sent)
                : invites
          return Response.json({ threads: matches.map(({ id }) => ({ id })) })
        }
        if (resource === `${api}/messages`) {
          assert.equal(query.get('labelIds'), 'SENT')
          assert.equal(query.get('maxResults'), '10')
          const q = query.get('q')
          assert.match(q ?? '', /^rfc822msgid:[a-f0-9-]{36}@holi\.invalid$/)
          sentIdSearches++
          const reply =
            mailbox === mailboxA && sent && q === `rfc822msgid:${sent.rfcId.slice(1, -1)}`
              ? sent
              : null
          return Response.json({
            messages: reply ? [{ id: reply.id, threadId: attachment.id }] : [],
          })
        }
        for (const invite of invites) {
          const incoming = message(invite, mailbox)
          const reply = invite === attachment && sent ? message(invite, mailbox, sent) : null
          const format = query.get('format')
          if (resource === `${api}/threads/${invite.id}`) {
            assert(format === 'full' || format === 'metadata')
            const messages = reply ? [incoming, reply] : [incoming]
            return Response.json({
              id: invite.id,
              historyId: '100',
              snippet: incoming.snippet,
              messages:
                format === 'metadata'
                  ? messages.map(({ payload, ...item }) => ({
                      ...item,
                      payload: { mimeType: payload.mimeType, headers: payload.headers },
                    }))
                  : messages,
            })
          }
          if (reply && resource === `${api}/messages/${reply.id}`) {
            assert.equal(format, 'full')
            assert(!query.has('fields'))
            if (pendingReceiptIndex) {
              // The accepted receipt can briefly precede the message resource.
              pendingReceiptIndex = false
              return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 })
            }
            sentReceiptReads++
            return Response.json(reply)
          }
          if (
            resource === `${api}/messages/${incoming.id}` &&
            format === 'full' &&
            query.has('fields')
          ) {
            const { payload } = incoming
            return Response.json({
              id: incoming.id,
              threadId: invite.id,
              payload: {
                mimeType: payload.mimeType,
                headers: payload.headers,
                parts: payload.parts.map(({ body: _body, ...part }) => part),
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
      if (method === 'PATCH' && resource === `${calendar}/calendars/primary/events/${eventId}`) {
        assert.equal(mailbox, mailboxA, 'must not write to a different Google account')
        const ifMatch = headers.get('If-Match') ?? ''
        assert.equal(ifMatch, event().etag)
        assert.equal(query.get('sendUpdates'), 'all')
        const body = JSON.parse(String(init?.body))
        const answer: InviteAnswer = body.attendees?.[0]?.responseStatus
        assert(['accepted', 'tentative', 'declined'].includes(answer))
        assert.deepEqual(body, {
          attendeesOmitted: true,
          attendees: [{ ...attendee, responseStatus: answer }],
        })
        writes.push({
          account: mailbox.sub,
          method,
          resource: url.pathname,
          to: organizer.email,
          answer,
          status: losePatchAcknowledgement ? 'transport error' : 200,
          ifMatch,
          sendUpdates: 'all',
          uid: inline.uid,
        })
        attendee = { ...attendee, responseStatus: answer }
        version++
        if (losePatchAcknowledgement) {
          losePatchAcknowledgement = false
          // Google applied the PATCH; the connection closed before the client saw a response.
          return Promise.reject(
            new Error('Fixture Calendar connection closed after applying PATCH'),
          )
        }
        return Response.json(event())
      }
      if (method === 'POST' && resource === `${gmail}/messages/send`) {
        assert.equal(mailbox, mailboxA, 'must not send from a different Google account')
        const body = JSON.parse(String(init?.body))
        assert.equal(
          body.threadId,
          attachment.id,
          'iTIP Reply must stay in its original Gmail thread',
        )
        const reply = readReply(body.raw, attachment, mailbox)
        const evidence = {
          account: mailbox.sub,
          method,
          resource: url.pathname,
          to: organizer.email,
          answer: reply.answer,
          uid: attachment.uid,
        } as const
        if (refuseNextSend) {
          refuseNextSend = false
          writes.push({ ...evidence, status: 403 })
          return Response.json({ error: { status: 'insufficientPermissions' } }, { status: 403 })
        }
        assert(!sent, 'the fixture should receive exactly one accepted Gmail REPLY')
        sent = { id: 'fixture-sent-reply', ...reply }
        pendingReceiptIndex = true
        writes.push({ ...evidence, status: 200, messageId: sent.id })
        return Response.json({ id: sent.id, threadId: attachment.id, labelIds: ['SENT'] })
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
    refuseNextSend: () => {
      refuseNextSend = true
    },
    loseNextPatchAcknowledgement: () => {
      losePatchAcknowledgement = true
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
      sentReceiptReads,
      sentIdSearches,
      tokenRefreshes,
      calendarReadbacks: calendarReadbackVersions.size,
      calendarResponse: attendee.responseStatus,
      otherGuest: event().attendees[1],
    }),
  }
}
