import { emptyVaultSnapshot } from '@holi/shared'
import ICAL from 'ical.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createCapabilityRegistry, type Door } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import type { GoogleAccountsManager } from '../main/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../main/capabilities'
import { GoogleSession, type AccountRef } from '../main/session'
import type { StoredGoogleAuth } from '../main/token-store'

const person = 'me@example.com'
const organizer = 'organizer@example.net'
const guest = 'guest@example.org'
const thread = { threadId: 'thread', expectedAccountSub: 'receiver' }
const uid = 'conference-series-1234567890-long-folded-uid'
const identity = { messageId: 'update', uid, sequence: 3, recurrenceId: null }
const start = '2024-07-18T15:00:00.000Z'
const end = '2024-07-18T16:00:00.000Z'

function invite(method = 'REQUEST', extra = '', sequence = 3) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'UID:conference-series-1234567890-long-\r\n folded-uid',
    `SEQUENCE:${sequence}`,
    'SUMMARY:Design sync',
    'LOCATION:Upstairs',
    'DESCRIPTION:https://meet.google.com/abc-defg-hij',
    `ORGANIZER;CN=Host:mailto:${organizer}`,
    `ATTENDEE:mailto:${person}`,
    extra || 'DTSTART:20240718T150000Z\r\nDTEND:20240718T160000Z',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

const wire = (value: string) => Buffer.from(value).toString('base64url')
const json = (body: unknown, status = 200) => Response.json(body, { status })

function gmailMessage(
  id: string,
  date: number,
  calendar?: string,
  options: {
    sent?: boolean
    attached?: boolean
    method?: string
    draft?: boolean
  } = {},
) {
  return {
    id,
    internalDate: String(date),
    labelIds: options.draft ? ['DRAFT'] : options.sent ? ['SENT'] : ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: options.sent ? person : organizer },
        { name: 'To', value: options.sent ? organizer : person },
        { name: 'Subject', value: options.sent ? 'Re: Design sync' : 'Design sync' },
        { name: 'Message-ID', value: `<${id}@example.net>` },
        { name: 'References', value: '<original@example.net>' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: wire('accepted (plain text is not an RSVP)') } },
        ...(calendar !== undefined || options.attached
          ? [
              {
                mimeType: options.attached ? 'application/ics' : 'text/calendar',
                filename: options.attached ? 'meeting.ics' : '',
                body: options.attached ? { attachmentId: id } : { data: wire(calendar ?? '') },
                headers: options.method
                  ? [{ name: 'Content-Type', value: `text/calendar; method=${options.method}` }]
                  : [],
              },
            ]
          : []),
      ],
    },
  }
}

function event(options: { id?: string; occurrence?: boolean } = {}) {
  return {
    id: options.id ?? 'event',
    etag: '"version"',
    iCalUID: uid,
    sequence: 3,
    summary: 'Design sync',
    status: 'confirmed',
    organizer: { email: organizer, self: false },
    start: { dateTime: start },
    end: { dateTime: end },
    htmlLink: 'https://calendar.google.com/calendar/event?eid=example',
    attendees: [
      { email: person, self: true, responseStatus: 'declined', comment: 'An existing comment' },
      { email: guest, self: false, responseStatus: 'tentative' },
    ],
    ...(options.occurrence
      ? { recurringEventId: 'series', originalStartTime: { dateTime: '2024-07-11T11:00:00-04:00' } }
      : {}),
  }
}

function account(sub: string, now: () => number, refresh: typeof fetch) {
  let auth: StoredGoogleAuth | null = {
    sub,
    email: person,
    refreshToken: 'refresh',
    accessToken: `token-${sub}`,
    expiresAt: 3_600_000,
    scopes: ['email'],
  }
  const ref: AccountRef = {
    read: () => auth,
    generation: () => 1,
    write: async (value) => {
      auth = value
    },
    expire: async () => {
      auth = null
    },
    remove: async () => {
      auth = null
    },
  }
  return new GoogleSession({ account: ref, now, fetch: refresh, client: () => ({ id: 'client' }) })
}

/** Models the account-scoped Google resources the UI sees. Writes update the
 * provider state (or fail) and the next UI read has to recover that state. */
function rig() {
  let now = 0
  const state = {
    messages: [gmailMessage('update', 200, invite(), { method: 'REQUEST' })],
    attachments: new Map<string, string>(),
    events: new Map<string, ReturnType<typeof event>[]>(),
    instances: new Map<string, ReturnType<typeof event>[]>(),
    hiddenCalendars: [] as string[],
    notices: [] as { calendar: string; to: string; status: string }[],
    sendAttempts: 0,
    sentMime: [] as string[],
    calendarPatchAttempts: 0,
    primaryMissing: false,
    calendarUnavailable: false,
    threadUnavailable: false,
    refreshOnQuery: false,
    relinkOnRefresh: false,
    replaceOnQuery: false,
    sendReplyMode: 'ok' as 'ok' | 'refused' | 'accepted-but-offline' | 'response-lost',
  }
  const refresh: typeof fetch = async () => {
    if (state.relinkOnRefresh) current = other
    return json({ access_token: 'refreshed-receiver', expires_in: 3600 })
  }
  const other = account('other', () => 0, refresh)
  let current = account('receiver', () => now, refresh)

  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const token = new Headers(init.headers).get('Authorization')
    if (token !== 'Bearer token-receiver' && token !== 'Bearer refreshed-receiver') {
      throw new Error('The transport received credentials for a different mailbox')
    }
    if (url.pathname.endsWith('/threads/thread') && url.searchParams.get('format') === 'full') {
      if (state.threadUnavailable) throw new TypeError('Gmail offline')
      return json({ id: 'thread', messages: state.messages })
    }
    const attachment = /\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
    if (attachment) {
      const bytes = state.attachments.get(attachment[2]!)
      return bytes ? json({ data: wire(bytes) }) : json({}, 404)
    }
    if (url.pathname.endsWith('/users/me/calendarList')) {
      const hidden = url.searchParams.get('showHidden') === 'true' ? state.hiddenCalendars : []
      return json({
        items: [
          { id: person, primary: true, selected: true, accessRole: 'owner' },
          ...hidden.map((id) => ({ id, selected: false, hidden: true, accessRole: 'owner' })),
        ],
      })
    }
    const instancePath = /\/calendars\/([^/]+)\/events\/([^/]+)\/instances$/.exec(url.pathname)
    if (instancePath) {
      const instances = state.instances.get(decodeURIComponent(instancePath[1]!)) ?? []
      const original = url.searchParams.get('originalStart')
      return json({
        items: instances.filter(
          (item) =>
            Date.parse(item.originalStartTime?.dateTime ?? '') === Date.parse(original ?? ''),
        ),
      })
    }
    const calendar = /\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname)
    if (calendar) {
      const id = decodeURIComponent(calendar[1]!)
      if (state.calendarUnavailable) throw new TypeError('Calendar offline')
      if (state.primaryMissing && id === 'primary') return json({}, 404)
      const events = state.events.get(id) ?? []
      if (init.method === 'PATCH') {
        state.calendarPatchAttempts++
        const currentEvent = [...events, ...(state.instances.get(id) ?? [])].find(
          (e) => e.id === calendar[2],
        )
        if (!currentEvent) return json({}, 404)
        if (new Headers(init.headers).get('If-Match') !== currentEvent.etag) return json({}, 412)
        const update = JSON.parse(String(init.body)) as {
          attendeesOmitted: boolean
          attendees: typeof currentEvent.attendees
        }
        if (
          !update.attendeesOmitted ||
          update.attendees.length !== 1 ||
          update.attendees[0]?.email !== person
        ) {
          return json({ error: 'Only the RSVP of the calendar attendee may change' }, 400)
        }
        currentEvent.attendees[0] = update.attendees[0]!
        if (url.searchParams.get('sendUpdates') === 'all') {
          state.notices.push({
            calendar: id,
            to: currentEvent.organizer.email,
            status: currentEvent.attendees[0].responseStatus,
          })
        }
        return json(currentEvent)
      }
      const items = events.filter(
        (e) =>
          e.iCalUID === url.searchParams.get('iCalUID') &&
          (e.status !== 'cancelled' || url.searchParams.get('showDeleted') === 'true'),
      )
      if (state.refreshOnQuery) now = 3_600_000
      if (state.replaceOnQuery)
        state.messages.push(gmailMessage('newer', 400, invite('REQUEST', '', 4)))
      return json({ items })
    }
    if (url.pathname.endsWith('/messages/send') && init.method === 'POST') {
      state.sendAttempts++
      if (state.sendReplyMode === 'refused')
        return json({ error: { status: 'insufficientPermissions' } }, 403)
      const body = JSON.parse(String(init.body)) as { raw: string; threadId: string }
      const raw = Buffer.from(body.raw, 'base64url')
        .toString('utf8')
        .replace(/\r\n[ \t]/g, ' ')
      const part =
        /^Content-Type: text\/calendar; method=REPLY[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)(?=--)/im.exec(
          raw,
        )
      if (
        body.threadId !== 'thread' ||
        !part ||
        !raw.includes('In-Reply-To: <update@example.net>') ||
        !raw.includes('Subject: Re: Design sync') ||
        !raw.includes(`To: ${organizer}\r\n`) ||
        !raw.includes(`From: ${person}\r\n`)
      ) {
        return json({ error: 'Cannot file the calendar reply in this conversation' }, 400)
      }
      state.sentMime.push(raw)
      state.messages.push(
        gmailMessage('reply', 500, Buffer.from(part[1]!, 'base64').toString(), {
          sent: true,
          method: 'REPLY',
        }),
      )
      if (state.sendReplyMode === 'response-lost') throw new TypeError('Lost the send response')
      if (state.sendReplyMode === 'accepted-but-offline') {
        state.threadUnavailable = true
        return new Response(null, { status: 200 })
      }
      return json({ id: 'reply', threadId: 'thread', labelIds: ['SENT'] })
    }
    throw new Error(`Unhandled Google request: ${init.method ?? 'GET'} ${url}`)
  })

  const caps = googleCapabilities({
    accounts: { sessionFor: async () => current } as unknown as GoogleAccountsManager,
    dataFor: async () => null,
    settings: {
      read: async () => ({
        calendars: { 'hidden@example.com': false },
        imageSenders: [],
        imagesFromAllSenders: false,
      }),
      write: async () => {},
    },
  })
  const registry = createCapabilityRegistry()
  registry.register(GOOGLE_NAMESPACES, caps)
  const call = async (name: string, params: unknown, door: Door = 'ui') =>
    (
      await registry.run(
        `google.${name}`,
        door,
        {
          remote: 'owner/vault',
          root: '/vault',
          bundle: null,
          claims: async () => [],
          snapshot: async () => emptyVaultSnapshot(),
          core: noCoreServices(),
        },
        params,
      )
    ).value
  return {
    state,
    call,
    read: (params = thread) => call('mailInvitation', params),
    respond: (answer: string, target: Record<string, unknown> = identity) =>
      call('respondToMailInvitation', { ...thread, identity: target, answer }),
  }
}

afterEach(() => vi.unstubAllGlobals())

it('shows a past, declined primary copy and sends each RSVP to its organizer only', async () => {
  const { state, read, respond } = rig()
  const primary = event()
  state.events.set('primary', [primary])
  state.hiddenCalendars = ['duplicate@example.com']
  state.events.set('duplicate@example.com', [event()])
  expect(await read()).toMatchObject({
    identity,
    title: 'Design sync',
    start,
    end,
    organizer: { email: organizer, name: 'Host' },
    location: 'Upstairs',
    conferenceUrl: 'https://meet.google.com/abc-defg-hij',
    htmlLink: primary.htmlLink,
    canRespond: true,
    responseStatus: 'declined',
    allDay: false,
  })
  for (const answer of ['accepted', 'tentative', 'declined']) {
    expect(await respond(answer)).toMatchObject({
      outcome: 'sent',
      channel: 'calendar',
      answer,
      refreshPending: false,
      invitation: { responseStatus: answer },
    })
  }
  expect(state.notices).toEqual(
    ['accepted', 'tentative', 'declined'].map((status) => ({
      calendar: 'primary',
      to: organizer,
      status,
    })),
  )
  expect(primary.attendees).toEqual(event().attendees)
  expect(state.sendAttempts).toBe(0)
})

it('uses original start and the hidden secondary calendar ID for an attached, moved occurrence', async () => {
  const { state, read, respond } = rig()
  const calendar = 'hidden@example.com'
  state.hiddenCalendars = [calendar]
  state.events.set(calendar, [
    { ...event({ id: 'series' }), recurrence: ['RRULE:FREQ=WEEKLY'] } as ReturnType<typeof event>,
  ])
  state.instances.set(calendar, [event({ id: 'moved', occurrence: true })])
  state.messages = [gmailMessage('update', 200, undefined, { attached: true })]
  state.attachments.set(
    'update',
    invite(
      'REQUEST',
      [
        'RECURRENCE-ID;TZID=America/New_York:20240711T110000',
        'DTSTART;TZID=America/New_York:20240718T110000',
        'DTEND;TZID=America/New_York:20240718T120000',
      ].join('\r\n'),
    ),
  )
  const occurrence = { ...identity, recurrenceId: '2024-07-11T15:00:00.000Z' }
  expect(await read()).toMatchObject({ identity: occurrence, start, end, canRespond: true })
  expect(await respond('accepted', occurrence)).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
  })
  expect(state.notices).toEqual([{ calendar, to: organizer, status: 'accepted' }])
  expect(state.sendAttempts).toBe(0)
})

it('uses a threaded iTIP REPLY when Calendar has no copy and recovers its response from Sent', async () => {
  const { state, read, respond } = rig()
  state.primaryMissing = true
  const allDay = 'DTSTART;VALUE=DATE:20240718\r\nRECURRENCE-ID;VALUE=DATE:20240711'
  state.messages = [
    gmailMessage('older', 100, invite('REQUEST', allDay, 2)),
    gmailMessage('update', 200, invite('REQUEST', allDay)),
    gmailMessage(
      'older-reply',
      300,
      invite('REPLY', allDay, 2).replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:'),
      { sent: true },
    ),
    gmailMessage('ordinary', 400, undefined, { sent: true }),
  ]
  const occurrence = { ...identity, recurrenceId: '2024-07-11' }
  expect(await read()).toMatchObject({
    identity: occurrence,
    start: '2024-07-18',
    end: '2024-07-19',
    allDay: true,
    responseStatus: 'needsAction',
    canRespond: true,
  })
  expect(await respond('tentative', occurrence)).toMatchObject({
    outcome: 'sent',
    channel: 'gmail',
    refreshPending: false,
  })
  expect(await read()).toMatchObject({ identity: occurrence, responseStatus: 'tentative' })
  const replySource = Buffer.from(
    state.messages.at(-1)?.payload.parts[1]?.body.data ?? '',
    'base64url',
  ).toString()
  const reply = new ICAL.Component(ICAL.parse(replySource))
  const entry = reply.getFirstSubcomponent('vevent')!
  expect(reply.getFirstPropertyValue('method')).toBe('REPLY')
  expect(entry.getFirstPropertyValue('uid')).toBe(uid)
  expect(entry.getFirstPropertyValue('sequence')).toBe(3)
  expect(entry.getFirstProperty('recurrence-id')?.getFirstValue()?.toString()).toBe('2024-07-11')
  expect(entry.getFirstPropertyValue('organizer')).toBe(`mailto:${organizer}`)
  expect(entry.getFirstPropertyValue('attendee')).toBe(`mailto:${person}`)
  expect(entry.getFirstProperty('attendee')?.getParameter('partstat')).toBe('TENTATIVE')
  expect(state.sentMime[0]).toContain('References: <original@example.net> <update@example.net>')
  expect(state.calendarPatchAttempts).toBe(0)
})

it('does not mistake ordinary mail, a draft, or sent calendar mail for the latest incoming invitation', async () => {
  const { state, read, respond } = rig()
  state.messages = [gmailMessage('not-an-invite', 100)]
  expect(await read()).toBeNull()
  state.messages.push(
    gmailMessage('update', 200, invite()),
    gmailMessage('latest', 250, invite('CANCEL', 'STATUS:CANCELLED', 4)),
    gmailMessage('sent', 300, invite('REPLY'), { sent: true }),
    gmailMessage('draft', 400, invite('REQUEST'), { draft: true }),
  )
  expect(await read()).toMatchObject({
    identity: { messageId: 'latest', uid, sequence: 4 },
    title: 'Design sync',
    cancelled: true,
    canRespond: false,
    unavailableReason: expect.any(String),
  })
  await expect(
    respond('accepted', { ...identity, messageId: 'latest', sequence: 4 }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.messages.push(gmailMessage('broken', 500, 'invalid calendar data', { method: 'REQUEST' }))
  expect(await read()).toMatchObject({
    identity: { messageId: 'broken' },
    canRespond: false,
    unavailableReason: expect.any(String),
  })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('will not answer on behalf of an organizer, a different attendee or an ambiguous Calendar copy', async () => {
  const { state, read, respond } = rig()
  state.events.set('primary', [event(), event({ id: 'another' })])
  expect(await read()).toMatchObject({ canRespond: false, unavailableReason: expect.any(String) })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.events.set('primary', [{ ...event(), organizer: { email: person, self: true } }])
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.events.set('primary', [{ ...event(), attendees: event().attendees.slice(1) }])
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.events.set('primary', [])
  state.messages = [
    gmailMessage(
      'update',
      200,
      invite().replace(`ATTENDEE:mailto:${person}`, `ATTENDEE:mailto:${guest}`),
    ),
  ]
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('refuses other accounts, non-UI doors, and an update arriving before dispatch', async () => {
  const { state, read, respond, call } = rig()
  await expect(read({ ...thread, expectedAccountSub: 'other' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  })
  await expect(
    call('respondToMailInvitation', { ...thread, identity, answer: 'accepted' }, 'cli'),
  ).rejects.toThrow()
  state.events.set('primary', [event()])
  await expect(respond('accepted', { ...identity, sequence: 2 })).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  state.replaceOnQuery = true
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('does not dispatch a response when a token refresh relinks the vault', async () => {
  const { state, read, respond } = rig()
  state.events.set('primary', [event()])
  expect(await read()).toMatchObject({ canRespond: true })
  state.refreshOnQuery = state.relinkOnRefresh = true
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('distinguishes unconfirmed delivery, a refused send and a failed post-send refresh', async () => {
  const { state, read, respond } = rig()
  state.calendarUnavailable = true
  await expect(respond('accepted')).rejects.toThrow('Calendar offline')
  expect(state.sendAttempts).toBe(0)
  state.calendarUnavailable = false
  state.sendReplyMode = 'refused'
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await read()).toMatchObject({ responseStatus: 'needsAction' })
  state.sendReplyMode = 'response-lost'
  expect(await respond('accepted')).toMatchObject({ outcome: 'uncertain', refreshPending: true })
  expect(await read()).toMatchObject({ responseStatus: 'accepted', responsePending: false })
  expect(await respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(2)
  state.sendReplyMode = 'accepted-but-offline'
  expect(await respond('declined')).toMatchObject({
    outcome: 'sent',
    refreshPending: true,
    invitation: null,
  })
  state.threadUnavailable = false
  expect(await read()).toMatchObject({ responseStatus: 'declined', responsePending: false })
  expect(state.sendAttempts).toBe(3)
})
