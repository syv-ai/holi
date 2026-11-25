import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyVaultSnapshot } from '@holi/shared'
import ICAL from 'ical.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createCapabilityRegistry, type Door } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createGoogleAccounts } from '../main/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../main/capabilities'
import { createMailInvitationSession } from '../main/mail-invitation-session'
import { createMailInvitationStore } from '../main/mail-invitation-store'
import { createVaultAccounts } from '../main/vault-accounts'
import { GoogleTokenStore, type StoredGoogleAuth } from '../main/token-store'

const person = 'me@example.com'
const organizer = 'organizer@example.net'
const guest = 'guest@example.org'
const remote = 'owner/vault'
const thread = { threadId: 'thread', expectedAccountSub: 'receiver' }
const uid = 'conference-series-1234567890-long-folded-uid'
const identity = { messageId: 'update', uid, sequence: 3, recurrenceId: null }
const start = '2024-07-18T15:00:00.000Z'
const end = '2024-07-18T16:00:00.000Z'

function invite(method = 'REQUEST', extra = '', sequence = 3, stamp = '20240701T090000Z') {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'UID:conference-series-1234567890-long-\r\n folded-uid',
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${stamp}`,
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
    rfcId?: string
    parent?: string
    threadId?: string
    references?: string
  } = {},
) {
  return {
    id,
    threadId: options.threadId ?? 'thread',
    internalDate: String(date),
    labelIds: options.draft ? ['DRAFT'] : options.sent ? ['SENT'] : ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: options.sent ? person : organizer },
        { name: 'To', value: options.sent ? organizer : person },
        { name: 'Subject', value: options.sent ? 'Re: Design sync' : 'Design sync' },
        { name: 'Message-ID', value: options.rfcId ?? `<${id}@example.net>` },
        {
          name: 'References',
          value: options.references ?? options.parent ?? '<original@example.net>',
        },
        ...(options.parent ? [{ name: 'In-Reply-To', value: options.parent }] : []),
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

function account(sub: string): StoredGoogleAuth {
  return {
    sub,
    email: person,
    refreshToken: 'refresh',
    accessToken: `token-${sub}`,
    expiresAt: 3_600_000,
    scopes: ['email'],
  }
}

const tempDirs: string[] = []

/** Models the account-scoped Google resources the UI sees. Writes update the
 * provider state (or fail) and the next UI read has to recover that state. */
async function rig() {
  const userData = await mkdtemp(join(tmpdir(), 'holi-invitation-'))
  tempDirs.push(userData)
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
    refreshOnQuery: false,
    onRefresh: async () => {},
    sent: new Map<string, ReturnType<typeof gmailMessage>>(),
    sentVisible: true,
    sentIndexed: true,
    replyThread: 'thread',
    replaceOnQuery: false,
    sendReplyMode: 'ok' as 'ok' | 'refused' | 'empty' | 'response-lost',
  }
  const refresh: typeof fetch = async () => {
    await state.onRefresh()
    return json({ access_token: 'refreshed-receiver', expires_in: 3600 })
  }
  const store = new GoogleTokenStore(join(userData, 'tokens.enc'), {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`fake:${value}`),
    decryptString: (value) => value.toString().slice(5),
  })
  await store.write({ receiver: account('receiver'), other: account('other') })
  const vaults = createVaultAccounts(join(userData, 'vault-links.json'))
  const accounts = await createGoogleAccounts({
    vaults,
    store,
    fetch: refresh,
    now: () => now,
    listen: async () => {
      throw new Error('Consent is not part of this fixture')
    },
    openBrowser: async () => {
      throw new Error('Consent is not part of this fixture')
    },
  })
  await accounts.link(remote, 'receiver')

  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const token = new Headers(init.headers).get('Authorization')
    if (token !== 'Bearer token-receiver' && token !== 'Bearer refreshed-receiver') {
      throw new Error('The transport received credentials for a different mailbox')
    }
    if (url.pathname.endsWith('/threads/thread') && url.searchParams.get('format') === 'full') {
      return json({ id: 'thread', messages: state.messages })
    }
    if (url.pathname.endsWith('/messages') && url.searchParams.get('labelIds') === 'SENT') {
      const query = url.searchParams.get('q')
      const matching =
        state.sentVisible && state.sentIndexed
          ? [...state.sent.values()].filter(({ payload }) =>
              payload.headers.some(
                ({ name, value }) =>
                  name === 'Message-ID' && query === `rfc822msgid:${value.slice(1, -1)}`,
              ),
            )
          : []
      return json({ messages: matching.map(({ id, threadId }) => ({ id, threadId })) })
    }
    const messagePath = /\/messages\/([^/]+)$/.exec(url.pathname)
    if (messagePath && url.searchParams.get('format') === 'full') {
      const message = state.sentVisible ? state.sent.get(messagePath[1]!) : undefined
      return message ? json(message) : json({}, 404)
    }
    const attachment = /\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
    if (attachment) {
      const bytes = state.attachments.get(attachment[2]!)
      return bytes ? json({ data: wire(bytes) }) : json({}, 404)
    }
    if (url.pathname.endsWith('/users/me/calendarList')) {
      if (state.refreshOnQuery) now = 3_600_000
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
        currentEvent.etag = `"version-${state.calendarPatchAttempts}"`
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
      if (state.replaceOnQuery) {
        state.replaceOnQuery = false
        state.messages.push(gmailMessage('newer', 400, invite('REQUEST', '', 4)))
      }
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
      const rfcId = /^Message-ID: (<[^>]+>)$/im.exec(raw)?.[1]
      const parent = /^In-Reply-To: (<[^>]+>)$/im.exec(raw)?.[1]
      const part =
        /^Content-Type: text\/calendar; method=REPLY[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)(?=--)/im.exec(
          raw,
        )
      if (
        body.threadId !== 'thread' ||
        !part ||
        !rfcId ||
        !parent ||
        !state.messages.some(({ payload }) =>
          payload.headers.some(({ name, value }) => name === 'Message-ID' && value === parent),
        ) ||
        !raw.includes('Subject: Re: Design sync') ||
        !raw.includes(`To: ${organizer}\r\n`) ||
        !raw.includes(`From: ${person}\r\n`)
      ) {
        return json({ error: 'Cannot file the calendar reply in this conversation' }, 400)
      }
      state.sentMime.push(raw)
      const reply = gmailMessage(
        `reply-${state.sendAttempts}`,
        500 + state.sendAttempts,
        Buffer.from(part[1]!, 'base64').toString(),
        {
          sent: true,
          method: 'REPLY',
          rfcId,
          parent,
          threadId: state.replyThread,
        },
      )
      state.sent.set(reply.id, reply)
      if (state.replyThread === 'thread') state.messages.push(reply)
      if (state.sendReplyMode === 'response-lost') throw new TypeError('Lost the send response')
      if (state.sendReplyMode === 'empty') return new Response(null, { status: 200 })
      return json({ id: reply.id, threadId: state.replyThread, labelIds: ['SENT'] })
    }
    throw new Error(`Unhandled Google request: ${init.method ?? 'GET'} ${url}`)
  })

  const service = () => {
    const caps = googleCapabilities({
      accounts,
      mailInvitations: createMailInvitationSession(createMailInvitationStore(userData)),
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
            remote,
            root: '/vault',
            bundle: null,
            claims: async () => [],
            snapshot: async () => emptyVaultSnapshot(),
            core: noCoreServices(),
          },
          params,
        )
      ).value
    let current: { bindingRevision: string; identity: Record<string, unknown> } | null = null
    return {
      call,
      async read(params = thread) {
        current = (await call('mailInvitation', params)) as typeof current
        return current
      },
      respond: (answer: string, override?: Record<string, unknown>) =>
        call('respondToMailInvitation', {
          ...thread,
          identity: { ...current?.identity, ...override },
          expectedBindingRevision: current?.bindingRevision,
          answer,
        }),
    }
  }
  return { userData, state, accounts, restart: service, ...service() }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('shows a past, declined primary copy and sends each RSVP to its organizer only', async () => {
  const { state, read, respond } = await rig()
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
  const { state, read, respond } = await rig()
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
  const { state, read, respond } = await rig()
  const allDay = 'DTSTART;VALUE=DATE:20240718\r\nRECURRENCE-ID;VALUE=DATE:20240711'
  state.messages = [
    gmailMessage('older', 100, invite('REQUEST', allDay, 2)),
    gmailMessage('update', 200, invite('REQUEST', allDay)),
    gmailMessage(
      'older-reply',
      300,
      invite('REPLY', allDay, 2).replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:'),
      { sent: true, parent: '<older@example.net>' },
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
  const { state, read, respond } = await rig()
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
  const { state, read, respond } = await rig()
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
  const { state, read, respond, call } = await rig()
  await expect(read({ ...thread, expectedAccountSub: 'other' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  })
  await expect(
    call('respondToMailInvitation', { ...thread, identity, answer: 'accepted' }, 'cli'),
  ).rejects.toThrow()
  state.events.set('primary', [event()])
  await read()
  await expect(respond('accepted', { ...identity, sequence: 2 })).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  state.replaceOnQuery = true
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('orders revisions by sequence and DTSTAMP and refuses conflicting MIME', async () => {
  const { state, read, respond } = await rig()
  state.messages.push(
    gmailMessage('cancel', 100, invite('CANCEL', 'STATUS:CANCELLED', 3, '20240703T090000Z')),
    gmailMessage('delayed', 300, invite('REQUEST', '', 3, '20240702T090000Z')),
    gmailMessage('old-sequence', 500, invite('REQUEST', '', 2, '20240704T090000Z')),
  )
  expect(await read()).toMatchObject({ identity: { messageId: 'cancel' }, cancelled: true })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  const newer = invite('REQUEST', '', 4)
  const multipart = gmailMessage('newer', 600, newer)
  multipart.payload.parts.push(gmailMessage('duplicate', 600, newer).payload.parts[1]!)
  state.messages.push(multipart)
  expect(await read()).toMatchObject({ identity: { messageId: 'newer' }, canRespond: true })
  multipart.payload.parts.push(
    gmailMessage('conflict', 600, newer.replace('Upstairs', 'Downstairs')).payload.parts[1]!,
  )
  expect(await read()).toMatchObject({ canRespond: false, unavailableReason: expect.any(String) })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('does not borrow Calendar details or fall back to Gmail when verification is blocked', async () => {
  const { state, read, respond } = await rig()
  const rejected = {
    ...event(),
    summary: 'Unrelated copy',
    location: 'Private place',
    hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
  }
  for (const copy of [
    { ...rejected, organizer: { email: guest, self: false } },
    { ...rejected, attendees: rejected.attendees.slice(1) },
  ]) {
    state.events.set('primary', [copy])
    expect(await read()).toMatchObject({
      title: 'Design sync',
      location: 'Upstairs',
      htmlLink: null,
      conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      responseStatus: null,
      canRespond: false,
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  state.events.clear()
  for (const failure of ['primaryMissing', 'calendarUnavailable'] as const) {
    state[failure] = true
    expect(await read()).toMatchObject({ canRespond: false, responseStatus: null })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state[failure] = false
  }
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

function acceptedReply(parent: string, stamp = '20240706T090000Z') {
  return gmailMessage(
    'sent-elsewhere',
    100,
    invite('REPLY', '', 3, stamp).replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:'),
    { sent: true, parent },
  )
}

it.each(['calendar copy', 'sent answer'])(
  'does not dispatch Gmail when a %s appears during token refresh',
  async (change) => {
    const { state, read, respond } = await rig()
    expect(await read()).toMatchObject({ responseStatus: 'needsAction' })
    state.refreshOnQuery = true
    state.onRefresh = async () => {
      if (change === 'calendar copy') state.events.set('primary', [event()])
      else state.messages.push(acceptedReply('<update@example.net>'))
    }
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await read()).toMatchObject({
      responseStatus: change === 'calendar copy' ? 'declined' : 'accepted',
    })
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  },
)

it('rejects an old binding after the real vault mapping switches A → B → A during refresh', async () => {
  const { state, accounts, read, respond } = await rig()
  const before = await read()
  state.refreshOnQuery = true
  state.onRefresh = async () => {
    await accounts.link(remote, 'other')
    await accounts.link(remote, 'receiver')
  }
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect((await read())?.bindingRevision).not.toBe(before?.bindingRevision)
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('proves the Sent parent belongs to the selected material and refuses invalid reply headers', async () => {
  const { state, read, respond, call } = await rig()
  state.messages.push(acceptedReply('<update@example.net>'))
  expect(await read()).toMatchObject({ responseStatus: 'accepted' })
  state.messages.push(gmailMessage('redelivery', 300, invite()))
  expect(await read()).toMatchObject({ responseStatus: 'accepted' })
  state.messages.push(
    gmailMessage(
      'changed',
      400,
      invite('REQUEST', '', 3, '20240702T090000Z').replace('Upstairs', 'Downstairs'),
    ),
  )
  expect(await read()).toMatchObject({ responseStatus: 'needsAction' })
  state.messages = [gmailMessage('update', 200, invite(), { rfcId: 'junk <update@example.net>' })]
  const invalid = await read()
  expect(invalid).toMatchObject({ canRespond: false })
  await expect(
    call('respondToMailInvitation', { ...thread, identity: invalid?.identity, answer: 'accepted' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.messages = [
    gmailMessage('update', 200, invite(), { references: '<original@example.net> junk' }),
  ]
  expect(await read()).toMatchObject({ canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(0)
})

it.each(['ok', 'empty', 'response-lost'] as const)(
  'keeps a %s unthreaded send reserved across reconstruction and recovers the actual Sent answer',
  async (mode) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = 'separate-thread'
    state.sentVisible = false
    state.sentIndexed = mode !== 'ok'
    await read()
    state.sendReplyMode = 'refused'
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.sendReplyMode = mode
    expect(await respond('accepted')).toMatchObject({
      outcome: mode === 'response-lost' ? 'uncertain' : 'sent',
      refreshPending: true,
    })
    state.messages.push(gmailMessage('redelivery', 300, invite()))
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({ responsePending: true, canRespond: false })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.sentVisible = true
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'accepted',
      responsePending: false,
    })
    const again = restart()
    expect(await again.read()).toMatchObject({ responseStatus: 'accepted', responsePending: false })
    expect(await again.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
    expect(state.sendAttempts).toBe(2)
    expect(state.sentMime).toHaveLength(1)
  },
)

it('fails closed on a damaged invitation response journal', async () => {
  const { userData, state, read, respond } = await rig()
  await read()
  await writeFile(join(userData, 'google-mail-invitations.json'), '{"version":1,"attempts":[{}]}')
  await expect(respond('accepted')).rejects.toThrow()
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})
