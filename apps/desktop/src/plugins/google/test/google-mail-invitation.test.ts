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
    contentTypes?: string[]
    draft?: boolean
    rfcId?: string
    parent?: string
    threadId?: string
    references?: string
    declaredSize?: number
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
                body: {
                  size: options.declaredSize ?? Buffer.byteLength(calendar ?? ''),
                  ...(options.attached ? { attachmentId: id } : { data: wire(calendar ?? '') }),
                },
                headers: (
                  options.contentTypes ??
                  (options.method ? [`text/calendar; method=${options.method}`] : [])
                ).map((value) => ({ name: 'Content-Type', value })),
              },
            ]
          : []),
      ],
    },
  }
}

function event(
  options: {
    id?: string
    occurrence?: boolean
    series?: boolean
    location?: string
    description?: string
  } = {},
) {
  return {
    id: options.id ?? 'event',
    etag: '"version"',
    iCalUID: uid,
    sequence: 3,
    summary: 'Design sync',
    location: options.location,
    description: options.description,
    status: 'confirmed',
    organizer: { email: organizer, self: false },
    start: { dateTime: start, ...(options.series ? { timeZone: 'UTC' } : {}) },
    end: { dateTime: end },
    htmlLink: 'https://calendar.google.com/calendar/event?eid=example',
    attendees: [
      { email: person, self: true, responseStatus: 'declined', comment: 'An existing comment' },
      { email: guest, self: false, responseStatus: 'tentative' },
    ],
    ...(options.series ? { recurrence: ['RRULE:FREQ=WEEKLY'] } : {}),
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
    attachmentGets: 0,
    originalGets: [] as string[],
    patchMode: 'ok' as 'ok' | 'not-found' | 'response-lost',
    primaryPages: null as unknown[] | null,
    omitAfterPatch: false,
    calendarReadback: null as ReturnType<typeof event> | null,
    primaryMissing: false,
    calendarUnavailable: false,
    instanceRefusal: null as 'forbidden' | 'scope' | null,
    instanceReads: 0,
    refreshOnQuery: false,
    onRefresh: async () => {},
    sent: new Map<string, ReturnType<typeof gmailMessage>>(),
    sentVisible: true,
    sentIndexed: true,
    receiptError: null as number | null,
    sentSearchError: null as number | null,
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
      if (state.sentSearchError) return json({}, state.sentSearchError)
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
      if (state.receiptError)
        return json(
          { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
          state.receiptError,
        )
      const message = state.sentVisible ? state.sent.get(messagePath[1]!) : undefined
      return message ? json(message) : json({}, 404)
    }
    const attachment = /\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
    if (attachment) {
      state.attachmentGets++
      const bytes = state.attachments.get(attachment[2]!)
      return bytes ? json({ data: wire(bytes), size: Buffer.byteLength(bytes) }) : json({}, 404)
    }
    if (url.pathname.endsWith('/users/me/calendarList')) {
      if (state.refreshOnQuery) now = 3_600_000
      const hidden = url.searchParams.get('showHidden') === 'true' ? state.hiddenCalendars : []
      return json({
        kind: 'calendar#calendarList',
        items: [
          { id: person, primary: true, selected: true, accessRole: 'owner' },
          ...hidden.map((id) => ({ id, selected: false, hidden: true, accessRole: 'owner' })),
        ],
      })
    }
    const instancePath = /\/calendars\/([^/]+)\/events\/([^/]+)\/instances$/.exec(url.pathname)
    if (instancePath) {
      state.instanceReads++
      if (state.instanceRefusal === 'forbidden')
        return json({ error: { errors: [{ reason: 'forbidden' }] } }, 403)
      if (state.instanceRefusal === 'scope')
        return json(
          {
            error: {
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
            },
          },
          403,
        )
      const instances = state.instances.get(decodeURIComponent(instancePath[1]!)) ?? []
      const original = url.searchParams.get('originalStart')
      return json({
        kind: 'calendar#events',
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
        if (state.patchMode === 'not-found') return json({}, 404)
        if (state.patchMode === 'response-lost') throw new TypeError('Calendar connection lost')
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
        if (state.omitAfterPatch) state.primaryPages = [{ kind: 'calendar#events' }]
        return json(currentEvent)
      }
      if (calendar[2]) {
        state.originalGets.push(calendar[2])
        const original = [...events, ...(state.instances.get(id) ?? [])].find(
          (event) => event.id === calendar[2],
        )
        return original ? json(original) : json({}, 404)
      }
      if (id === 'primary' && state.primaryPages) {
        const page = Number(url.searchParams.get('pageToken') ?? 0)
        return json(state.primaryPages[page] ?? {}, page < state.primaryPages.length ? 200 : 404)
      }
      const items = (
        state.calendarPatchAttempts && state.calendarReadback ? [state.calendarReadback] : events
      ).filter(
        (e) =>
          e.iCalUID === url.searchParams.get('iCalUID') &&
          (e.status !== 'cancelled' || url.searchParams.get('showDeleted') === 'true'),
      )
      if (state.replaceOnQuery) {
        state.replaceOnQuery = false
        state.messages.push(gmailMessage('newer', 400, invite('REQUEST', '', 4)))
      }
      return json({ kind: 'calendar#events', items })
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
    type Read = Awaited<ReturnType<ReturnType<typeof createMailInvitationSession>['read']>>
    let current: Read['invitations'][number] | null = null
    const list = async (params = thread) => (await call('mailInvitation', params)) as Read
    return {
      call,
      list,
      async read(params = thread, scope?: Read['invitations'][number]['scope']) {
        const { invitations } = await list(params)
        current =
          (scope ? invitations.find((card) => card.scope === scope) : invitations[0]) ?? null
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
  state.events.set(calendar, [event({ id: 'series', series: true })])
  state.instances.set(calendar, [event({ id: 'moved', occurrence: true })])
  const attached = invite(
    'REQUEST',
    [
      'RECURRENCE-ID;TZID=America/New_York:20240711T110000',
      'DTSTART;TZID=America/New_York:20240718T110000',
      'DTEND;TZID=America/New_York:20240718T120000',
    ].join('\r\n'),
  )
  state.messages = [gmailMessage('update', 200, attached, { attached: true })]
  state.attachments.set('update', attached)
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
  const { state, list, read, respond } = await rig()
  state.messages = [gmailMessage('not-an-invite', 100)]
  expect(await list()).toEqual({ invitations: [], recoveryReason: null })
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
  await read()
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
  const { state, accounts, read, respond, call } = await rig()
  const before = await read()
  const validate = (expectedBindingRevision: string) =>
    call('validateMailInvitationBinding', {
      expectedAccountSub: thread.expectedAccountSub,
      expectedBindingRevision,
    })
  await expect(validate(before!.bindingRevision)).resolves.toBeUndefined()
  state.refreshOnQuery = true
  state.onRefresh = async () => {
    await accounts.link(remote, 'other')
    await accounts.link(remote, 'receiver')
  }
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(validate(before!.bindingRevision)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const after = await read()
  expect(after?.bindingRevision).not.toBe(before?.bindingRevision)
  await expect(validate(after!.bindingRevision)).resolves.toBeUndefined()
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('proves the Sent parent belongs to the selected material and refuses invalid reply headers', async () => {
  const { state, read, respond, call } = await rig()
  state.messages.push(acceptedReply('<update@example.net>'))
  expect(await read()).toMatchObject({ responseStatus: 'accepted' })
  state.messages.push(gmailMessage('redelivery', 300, invite('REQUEST', '', 3, '20240701T100000Z')))
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
  state.messages = [gmailMessage('update', 200, invite(), { rfcId: '<up(date)date@example.net>' })]
  expect(await read()).toMatchObject({ canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.messages = [
    gmailMessage('update', 200, invite(), { rfcId: '(delivery) <update@example.net> (original)' }),
    acceptedReply('<up(comment)date@example.net>'),
  ]
  expect(await read()).toMatchObject({ canRespond: true, responseStatus: 'needsAction' })
  state.messages[1] = acceptedReply('<update@example.net> (original)')
  expect(await read()).toMatchObject({ canRespond: true, responseStatus: 'accepted' })
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
    state.messages.push(
      gmailMessage('redelivery', 300, invite('REQUEST', '', 3, '20240701T100000Z')),
    )
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({ responsePending: true, canRespond: false })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.sentVisible = true
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'accepted',
      responsePending: false,
    })
    state.messages = state.messages.filter(({ id }) => id !== 'update')
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

it('keeps mail details when a newer DTSTAMP changes material at the same Calendar sequence', async () => {
  const { state, read, respond } = await rig()
  state.events.set('primary', [{ ...event(), location: 'Upstairs' }])
  expect(await read()).toMatchObject({ canRespond: true, htmlLinkSource: 'calendar' })
  state.messages.push(
    gmailMessage(
      'moved',
      100,
      invite('REQUEST', '', 3, '20240702T090000Z').replace('Upstairs', 'Downstairs'),
    ),
  )
  expect(await read()).toMatchObject({
    identity: { messageId: 'moved', sequence: 3 },
    location: 'Downstairs',
    htmlLink: null,
    responseStatus: null,
    canRespond: false,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('prefers a corroborated Sent answer but honors REQUEST PARTSTAT and an explicit reset', async () => {
  const { state, read } = await rig()
  const alreadyAnswered = invite().replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:')
  state.messages = [gmailMessage('update', 200, alreadyAnswered)]
  expect(await read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  const reply = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=TENTATIVE:')
  state.messages.push(
    gmailMessage('tentative', 300, reply, { sent: true, parent: '<update@example.net>' }),
  )
  state.messages.push(
    gmailMessage(
      'redelivery',
      400,
      alreadyAnswered.replace('20240701T090000Z', '20240702T090000Z'),
    ),
  )
  expect(await read()).toMatchObject({ responseStatus: 'tentative' })
  state.messages.push(
    gmailMessage(
      'reset',
      500,
      alreadyAnswered
        .replace('20240701T090000Z', '20240703T090000Z')
        .replace('PARTSTAT=ACCEPTED', 'PARTSTAT=NEEDS-ACTION;RSVP=TRUE'),
    ),
  )
  expect(await read()).toMatchObject({ responseStatus: 'needsAction' })
  // Returning to the earlier material cannot resurrect Sent through the reset.
  state.messages.push(
    gmailMessage('new', 600, alreadyAnswered.replace('20240701T090000Z', '20240704T090000Z')),
  )
  expect(await read()).toMatchObject({ responseStatus: 'accepted' })
})

it('returns independent series and original occurrence cards and updates only the selected occurrence', async () => {
  const { state, list, read, respond } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
  )
  state.messages.push(
    gmailMessage(
      'exception',
      300,
      invite().replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT'),
    ),
  )
  const series = event({ id: 'series', series: true })
  const instance = event({ id: 'instance', occurrence: true })
  state.events.set('primary', [series])
  state.instances.set('primary', [instance])
  expect((await list()).invitations).toHaveLength(2)
  expect((await list()).invitations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'invitation',
        scope: 'series',
        responseStatus: 'declined',
        canRespond: true,
      }),
      expect.objectContaining({
        kind: 'invitation',
        scope: 'occurrence',
        responseStatus: 'declined',
        canRespond: true,
      }),
    ]),
  )
  state.instanceRefusal = 'forbidden'
  expect((await list()).invitations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: 'series', canRespond: true, responseStatus: 'declined' }),
      expect.objectContaining({
        scope: 'occurrence',
        canRespond: false,
        unavailableReason: expect.any(String),
      }),
    ]),
  )
  await read(thread, 'occurrence')
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  state.instanceRefusal = 'scope'
  await expect(list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.instanceRefusal = null
  await read(thread, 'occurrence')
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    invitation: { scope: 'occurrence', responseStatus: 'accepted' },
  })
  expect(series.attendees[0]?.responseStatus).toBe('declined')
  expect(instance.attendees[0]?.responseStatus).toBe('accepted')
  expect(state.notices).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('follows documented empty Calendar pages but never treats malformed or partial collections as absence', async () => {
  const { state, read, respond } = await rig()
  const empty = { kind: 'calendar#events' }
  state.primaryPages = [
    { ...empty, nextPageToken: '1' },
    { ...empty, items: [event()] },
  ]
  expect(await read()).toMatchObject({ responseStatus: 'declined', canRespond: true })
  state.primaryPages = [{ ...empty, nextPageToken: '1' }, empty]
  expect(await read()).toMatchObject({ responseStatus: 'needsAction', canRespond: true })
  for (const second of [
    { kind: 'calendar#calendarList' },
    { items: [] },
    { ...empty, items: null },
    { ...empty, items: [{}] },
    { ...empty, nextPageToken: '1' },
    { ...empty, nextPageToken: 1 },
  ]) {
    state.primaryPages = [{ ...empty, nextPageToken: '1' }, second]
    expect(await read()).toMatchObject({ responseStatus: null, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('reclaims inactive prepared reservations and treats an explicit PATCH 404 as a refusal', async () => {
  const { state, read, userData, restart } = await rig()
  state.events.set('primary', [event()])
  const card = await read()
  const { messageId: _messageId, ...revision } = card!.identity
  await writeFile(
    join(userData, 'google-mail-invitations.json'),
    JSON.stringify({
      version: 1,
      attempts: [
        {
          id: 'abandoned-before-dispatch',
          accountSub: 'receiver',
          threadId: 'thread',
          revision,
          answer: 'accepted',
          state: 'prepared',
          delivery: { channel: 'calendar', target: 'would-have-patched' },
        },
      ],
    }),
  )
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ canRespond: true, responsePending: false })
  state.patchMode = 'not-found'
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(await reopened.read()).toMatchObject({
    canRespond: true,
    responsePending: false,
    responseStatus: 'declined',
  })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)
})

it('keeps an unknown Calendar dispatch when the target vanishes, but permits a verified superseding revision', async () => {
  const { state, read, respond, restart } = await rig()
  const original = event()
  state.events.set('primary', [original])
  state.patchMode = 'response-lost'
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'uncertain', refreshPending: true })
  state.events.clear()
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ canRespond: false, responsePending: true })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.originalGets).toContain(original.id)
  state.messages.push(gmailMessage('cancel', 250, invite('CANCEL', 'STATUS:CANCELLED', 4)))
  expect(await reopened.read()).toMatchObject({
    cancelled: true,
    canRespond: false,
    responsePending: true,
  })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.messages.push(gmailMessage('newer', 300, invite('REQUEST', '', 5)))
  state.events.set('primary', [{ ...event({ id: 'new-event' }), sequence: 5 }])
  state.patchMode = 'ok'
  expect(await reopened.read()).toMatchObject({ canRespond: true, responsePending: false })
  expect(await reopened.respond('tentative')).toMatchObject({
    outcome: 'sent',
    refreshPending: false,
  })
  state.messages = [gmailMessage('ordinary', 400)]
  expect(await reopened.list()).toMatchObject({
    invitations: [],
    recoveryReason: expect.any(String),
  })
  original.attendees[0]!.responseStatus = 'accepted'
  state.events.set('primary', [original])
  expect(await reopened.list()).toEqual({ invitations: [], recoveryReason: null })
  expect(state.calendarPatchAttempts).toBe(2)
  expect(state.sendAttempts).toBe(0)
})

it('offers join-only for verified organizer or PUBLISH mail and rejects unverified lookalikes', async () => {
  const { state, read, respond, list } = await rig()
  const published = invite('PUBLISH').replace('METHOD:PUBLISH', 'METHOD:PUB\r\n LISH')
  state.messages = [gmailMessage('published', 200, published, { method: 'PUBLISH' })]
  state.events.set('primary', [
    { ...event(), description: 'Meeting: https://meet.google.com/abc-defg-hij' },
  ])
  expect(await read()).toMatchObject({
    kind: 'meeting',
    scope: 'single',
    canRespond: false,
    conferenceLinkSource: 'provider',
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.events.set('primary', [
    { ...event(), location: 'Wrong place', description: 'https://notzoom.us/j/12345' },
  ])
  expect((await list()).invitations).toEqual([])
  const sent = invite()
    .replace(organizer, person)
    .replace('DESCRIPTION:https://meet.google.com/abc-defg-hij', 'DESCRIPTION:Discuss work')
  state.messages = [gmailMessage('organized', 300, sent, { sent: true })]
  state.events.set('primary', [
    {
      ...event(),
      organizer: { email: person, self: true },
      attendees: [],
      description: 'https://notzoom.us/j/12345',
      htmlLink: 'https://calendar.google.com/search?eid=example',
    },
  ])
  expect(await read()).toMatchObject({
    kind: 'meeting',
    canRespond: false,
    conferenceUrl: null,
    htmlLink: null,
  })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('checks attachment metadata before fetching and shares a single scan budget across response validation', async () => {
  const { state, list, read, respond } = await rig()
  const source = invite()
  state.messages = [
    gmailMessage('large', 100, source, { attached: true, declaredSize: 256 * 1024 + 1 }),
  ]
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  expect(state.attachmentGets).toBe(0)
  state.messages = [gmailMessage('invalid-size', 100, source, { attached: true, declaredSize: -1 })]
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  expect(state.attachmentGets).toBe(0)
  const hefty = source.replace(
    'END:VEVENT',
    `${`X-PAD:${'x'.repeat(800)}\r\n`.repeat(280)}END:VEVENT`,
  )
  state.messages = Array.from({ length: 5 }, (_, index) =>
    gmailMessage(`inline-${index}`, index, hefty),
  )
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  expect(state.attachmentGets).toBe(0)

  state.messages = Array.from({ length: 5 }, (_, index) => {
    const id = `attachment-${index}`
    state.attachments.set(id, source)
    return gmailMessage(id, index, source, { attached: true })
  })
  expect(await read()).toMatchObject({ canRespond: true })
  state.attachmentGets = 0
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.attachmentGets).toBe(8)
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('applies organizer cancellations across only the affected occurrences', async () => {
  const { state, list, read, respond } = await rig()
  const occurrence = (slot: string, stamp = '20240701T090000Z') =>
    invite('REQUEST', '', 3, stamp).replace('END:VEVENT', `RECURRENCE-ID:${slot}\r\nEND:VEVENT`)
  const earlier = gmailMessage('earlier', 100, occurrence('20240711T150000Z'))
  const later = gmailMessage('later', 200, occurrence('20240725T150000Z'))
  const series = gmailMessage(
    'series',
    300,
    invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
  )
  const cancel = invite('CANCEL', 'STATUS:CANCELLED', 3, '20240703T090000Z')
  state.messages = [earlier, later, series, gmailMessage('cancel', 190, cancel)]
  expect((await list()).invitations.filter((card) => card.scope === 'occurrence')).toEqual([
    expect.objectContaining({ cancelled: true, canRespond: false }),
    expect.objectContaining({ cancelled: true, canRespond: false }),
  ])
  await read(thread, 'occurrence')
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  state.messages[3] = gmailMessage('wrong-organizer', 190, cancel.replace(organizer, guest))
  expect(await read(thread, 'occurrence')).toMatchObject({ cancelled: false, canRespond: true })
  state.messages[3] = gmailMessage(
    'range',
    190,
    cancel.replace(
      'END:VEVENT',
      'RECURRENCE-ID;RANGE=THISANDFUTURE:20240718T150000Z\r\nEND:VEVENT',
    ),
  )
  expect((await list()).invitations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: expect.objectContaining({ messageId: 'earlier' }),
        canRespond: true,
      }),
      expect.objectContaining({
        identity: expect.objectContaining({ messageId: 'later' }),
        cancelled: true,
        canRespond: false,
      }),
    ]),
  )
  state.messages.push(
    gmailMessage('reinvite', 180, occurrence('20240725T150000Z', '20240704T090000Z')),
  )
  expect((await list()).invitations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: expect.objectContaining({ messageId: 'reinvite' }),
        cancelled: false,
        canRespond: true,
      }),
    ]),
  )
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('compares explicit series recurrence before borrowing a Calendar copy or responding', async () => {
  const { state, read, respond } = await rig()
  const recurring = invite().replace(
    'END:VEVENT',
    [
      'RRULE:FREQ=WEEKLY;BYDAY=TH,FR',
      'EXDATE:20240725T150000Z,20240726T150000Z',
      'END:VEVENT',
    ].join('\r\n'),
  )
  state.messages = [gmailMessage('update', 200, recurring)]
  const series = { ...event({ id: 'series', series: true }), recurrence: ['RRULE:FREQ=DAILY'] }
  state.events.set('primary', [series])
  expect(await read()).toMatchObject({ scope: 'series', htmlLink: null, canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  series.recurrence = [
    'EXDATE:20240726T150000Z',
    'RRULE:BYDAY=FR,TH;INTERVAL=1;FREQ=WEEKLY',
    'EXDATE:20240725T150000Z',
  ]
  expect(await read()).toMatchObject({
    scope: 'series',
    responseStatus: 'declined',
    canRespond: true,
  })
})

it('proves floating-occurrence absence without guessing a time zone', async () => {
  const { state, read, respond } = await rig()
  const floating = invite()
    .replace('20240718T150000Z', '20240718T150000')
    .replace('20240718T160000Z', '20240718T160000')
    .replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000\r\nEND:VEVENT')
  state.messages = [gmailMessage('update', 200, floating)]
  const secondary = 'hidden@example.com'
  state.hiddenCalendars = [secondary]
  state.events.set(secondary, [event({ id: 'series', series: true })])
  expect(await read()).toMatchObject({ scope: 'occurrence', canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  state.events.clear()
  expect(await read()).toMatchObject({ scope: 'occurrence', floating: true, canRespond: true })
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'gmail',
    invitation: { responseStatus: 'accepted' },
  })
  const sent = state.sent.get('reply-1')?.payload.parts[1]?.body.data
  expect(Buffer.from(sent!, 'base64url').toString()).toContain('RECURRENCE-ID:20240711T150000\r\n')
  expect(state.instanceReads).toBe(0)
  expect(state.sendAttempts).toBe(1)
})

it.each(
  [
    ['text/calendar; method="REQUEST'],
    ['text/calendar; method=REQUEST; METHOD=REPLY'],
    ['text/calendar; method=REQUEST', 'text/calendar; method=REQUEST'],
  ].map((contentTypes) => ({ contentTypes })),
)('does not treat invalid MIME metadata as missing ($contentTypes)', async ({ contentTypes }) => {
  const { state, list, read, respond } = await rig()
  await read()
  state.messages.push(gmailMessage('ambiguous', 300, invite(), { contentTypes }))
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('does not corroborate an unthreaded Sent receipt with ambiguous MIME metadata', async () => {
  const { state, read, respond, restart } = await rig()
  state.sentVisible = false
  state.replyThread = 'separate-thread'
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: true })
  const part = state.sent.get('reply-1')?.payload.parts[1]!
  part.headers!.push({ name: 'Content-Type', value: 'text/calendar; method=REQUEST' })
  state.sentVisible = true
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ responsePending: true, canRespond: false })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('keeps the connected mailbox’s Sent answer when another guest changes PARTSTAT', async () => {
  const { state, read, respond } = await rig()
  const initial = invite().replace(
    'END:VEVENT',
    `ATTENDEE;PARTSTAT=DELEGATED:mailto:${guest}\r\nEND:VEVENT`,
  )
  state.messages = [gmailMessage('update', 200, initial), acceptedReply('<update@example.net>')]
  state.messages.push(
    gmailMessage(
      'redelivery',
      300,
      initial
        .replace('20240701T090000Z', '20240702T090000Z')
        .replace('PARTSTAT=DELEGATED', 'PARTSTAT=DECLINED'),
    ),
  )
  expect(await read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('ignores obsolete confirmed receipts before exhausting the shared evidence budget', async () => {
  const { state, read, respond, restart } = await rig()
  state.replyThread = 'separate-thread'
  for (let sequence = 1; sequence <= 12; sequence++) {
    state.messages = [gmailMessage(`request-${sequence}`, 200, invite('REQUEST', '', sequence))]
    expect(await read()).toMatchObject({ canRespond: true, responseStatus: 'needsAction' })
    expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: false })
  }
  for (let sequence = 1; sequence < 12; sequence++) {
    // Still indexed by exact RFC Message-ID, but GET → search → GET would no
    // longer corroborate the old parent and would cost three reads each.
    const headers = state.sent.get(`reply-${sequence}`)!.payload.headers
    for (const header of headers) {
      if (header.name === 'In-Reply-To' || header.name === 'References')
        header.value = '<different-parent@example.net>'
    }
  }
  // Keep the latest answer even though its original parent is no longer visible.
  state.messages = [gmailMessage('redelivery', 300, invite('REQUEST', '', 12, '20240702T090000Z'))]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(12)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('keeps a corroborated answer across Calendar and Gmail copies without notifying twice', async () => {
  const { state, read, respond, restart } = await rig()
  state.events.set('primary', [event()])
  state.omitAfterPatch = true
  state.replyThread = 'separate-thread'
  await read()
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
    invitation: { responseStatus: 'accepted' },
  })
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(await reopened.respond('tentative')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
    invitation: { responseStatus: 'tentative' },
  })

  const newCopy = event({ id: 'new-calendar-copy' })
  newCopy.attendees[0]!.responseStatus = 'needsAction'
  state.omitAfterPatch = false
  state.primaryPages = null
  state.events.set('primary', [newCopy])
  expect(await read()).toMatchObject({ responseStatus: 'tentative', canRespond: true })
  expect(await respond('tentative')).toMatchObject({ outcome: 'unchanged' })
  expect(await respond('declined')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
    invitation: { responseStatus: 'declined' },
  })
  expect(state.notices.map(({ status }) => status)).toEqual(['accepted', 'declined'])
  expect(state.sendAttempts).toBe(1)
})

it('does not settle a Calendar response while the matching copy still reports the previous answer', async () => {
  const { state, read, respond, restart } = await rig()
  state.events.set('primary', [event()])
  state.calendarReadback = event()
  await read()
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    refreshPending: true,
    invitation: { responsePending: true, canRespond: false },
  })
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ responsePending: true, canRespond: false })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.calendarReadback = null
  expect(await reopened.read()).toMatchObject({
    responseStatus: 'accepted',
    responsePending: false,
  })
  expect(state.notices).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('marks contradictory Sent readback instead of settling or offering to send the same answer again', async () => {
  const { state, read, respond } = await rig()
  const previous = acceptedReply('<update@example.net>')
  // Gmail reports the competing answer as later than the just-filed reply.
  state.messages.push({ ...previous, internalDate: '700' })
  expect(await read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await respond('tentative')).toMatchObject({
    outcome: 'sent',
    refreshPending: true,
    invitation: { canRespond: false, unavailableReason: expect.any(String) },
  })
  expect(await read()).toMatchObject({ canRespond: false })
  await expect(respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(1)
})

it('blocks a listed active occurrence of a verified cancelled Calendar master', async () => {
  const { state, read, respond } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT'),
  )
  state.events.set('primary', [
    { ...event({ id: 'series', series: true }), status: 'cancelled' },
    event({ id: 'active-instance', occurrence: true }),
  ])
  expect(await read()).toMatchObject({ scope: 'occurrence', cancelled: true, canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['multi-CANCEL', 'embedded exceptions'])(
  'applies every validated %s cancellation without blocking unaffected invitations',
  async (mode) => {
    const { state, list } = await rig()
    const slots = ['20240711T150000Z', '20240725T150000Z', '20240801T150000Z']
    const occurrence = (slot: string) =>
      invite().replace('END:VEVENT', `RECURRENCE-ID:${slot}\r\nEND:VEVENT`)
    const exceptions = slots
      .slice(0, 2)
      .map((slot) =>
        [
          'BEGIN:VEVENT',
          `UID:${uid}`,
          'SEQUENCE:3',
          'DTSTAMP:20240703T090000Z',
          `ORGANIZER:mailto:${organizer}`,
          `RECURRENCE-ID:${slot}`,
          'STATUS:CANCELLED',
          'END:VEVENT',
          '',
        ].join('\r\n'),
      )
      .join('')
    const cancellation =
      mode === 'multi-CANCEL'
        ? `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:CANCEL\r\n${exceptions}END:VCALENDAR\r\n`
        : invite()
            .replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')
            .replace('END:VCALENDAR', `${exceptions}END:VCALENDAR`)
    state.messages = [
      ...slots.map((slot, index) => gmailMessage(`slot-${index}`, 200 + index, occurrence(slot))),
      gmailMessage(
        'other',
        300,
        invite().replace(`UID:conference-series-1234567890-long-\r\n folded-uid`, 'UID:unrelated'),
      ),
      gmailMessage('cancellations', 400, cancellation),
    ]
    const { invitations } = await list()
    const occurrences = invitations
      .filter(({ scope }) => scope === 'occurrence')
      .sort((a, b) => a.identity.recurrenceId!.localeCompare(b.identity.recurrenceId!))
    expect(occurrences.map(({ cancelled, canRespond }) => ({ cancelled, canRespond }))).toEqual([
      { cancelled: true, canRespond: false },
      { cancelled: true, canRespond: false },
      { cancelled: false, canRespond: true },
    ])
    expect(invitations.find(({ identity }) => identity.uid === 'unrelated')).toMatchObject({
      canRespond: true,
    })
    if (mode === 'embedded exceptions')
      expect(invitations.find(({ scope }) => scope === 'series')).toMatchObject({
        canRespond: true,
      })
  },
)

it('requires the same recurrence zone, not just the same winter instant and RRULE', async () => {
  const { state, read, respond } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite(
      'REQUEST',
      [
        'DTSTART;TZID=America/New_York:20240118T110000',
        'DTEND;TZID=America/New_York:20240118T120000',
        'RRULE:FREQ=WEEKLY',
      ].join('\r\n'),
    ),
  )
  const recurring = {
    ...event({ series: true }),
    start: { dateTime: '2024-01-18T11:00:00-05:00', timeZone: 'Etc/GMT+5' },
    end: { dateTime: '2024-01-18T12:00:00-05:00' },
  }
  state.events.set('primary', [recurring])
  expect(await read()).toMatchObject({ scope: 'series', canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  recurring.start.timeZone = 'US/Eastern'
  expect(await read()).toMatchObject({ scope: 'series', canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
  expect(state.notices).toHaveLength(1)
  const custom = invite(
    'REQUEST',
    [
      'DTSTART;TZID=America/New_York:20240118T110000',
      'DTEND;TZID=America/New_York:20240118T120000',
      'RRULE:FREQ=WEEKLY',
    ].join('\r\n'),
    3,
    '20240702T090000Z',
  ).replace(
    'BEGIN:VEVENT',
    [
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
    ].join('\r\n'),
  )
  state.messages[0] = gmailMessage('custom', 300, custom)
  state.events.clear()
  expect(await read()).toMatchObject({
    scope: 'series',
    start: '2024-01-18T16:00:00.000Z',
    canRespond: false,
  })
  await expect(respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(0)
})

it('shows the connected attendee as delegated until they explicitly choose an answer', async () => {
  const { state, read, respond } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DELEGATED:'),
  )
  expect(await read()).toMatchObject({ responseStatus: 'delegated', canRespond: true })
  await expect(respond('delegated')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  expect(await respond('tentative')).toMatchObject({
    channel: 'gmail',
    refreshPending: false,
    invitation: { responseStatus: 'tentative' },
  })
  expect(state.sendAttempts).toBe(1)
})

it('keeps the latest of seventeen same-lineage answers available for an explicit change', async () => {
  const { state, read, respond, restart } = await rig()
  state.replyThread = 'separate-thread'
  await read()
  for (let index = 0; index < 17; index++) {
    const answer = index % 2 ? 'declined' : 'accepted'
    expect(await respond(answer)).toMatchObject({
      outcome: 'sent',
      refreshPending: false,
      invitation: { responseStatus: answer },
    })
  }
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(17)
  expect(await reopened.respond('tentative')).toMatchObject({
    outcome: 'sent',
    refreshPending: false,
  })
  expect(state.sendAttempts).toBe(18)
  expect(state.notices).toHaveLength(0)
})

it.each([
  { receiptError: 403, sentSearchError: null, code: 'FORBIDDEN' },
  { receiptError: 404, sentSearchError: 401, code: 'UNAUTHORIZED' },
  { receiptError: 404, sentSearchError: 404, code: 'NOT_FOUND' },
])(
  'reports Sent recovery refusals rather than treating them as absent ($code)',
  async ({ receiptError, sentSearchError, code }) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = 'separate-thread'
    state.sentVisible = false
    await read()
    expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: true })
    state.sentVisible = true
    state.receiptError = receiptError
    state.sentSearchError = sentSearchError
    const reopened = restart()
    await expect(reopened.read()).rejects.toMatchObject({
      code,
      ...(code !== 'NOT_FOUND' ? { next: expect.any(String) } : {}),
    })
    await expect(respond('tentative')).rejects.toMatchObject({ code })
    state.receiptError = 404
    state.sentSearchError = null
    // The index may return a missing individual message, not a missing collection.
    expect(await reopened.read()).toMatchObject({ responsePending: true, canRespond: false })
    state.receiptError = null
    expect(await reopened.read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
    expect(state.sendAttempts).toBe(1)
    expect(state.notices).toHaveLength(0)
  },
)

it('uses the same MIME discovery for thread hints and bounded invitation reads', async () => {
  const { state, call, list } = await rig()
  const hints = async () =>
    (
      (await call('thread', { id: 'thread' })) as {
        messages: { hasCalendarPayload: boolean }[]
      }
    ).messages.map(({ hasCalendarPayload }) => hasCalendarPayload)
  const filenameLess = gmailMessage('header-only', 200, invite(), { method: 'REQUEST' })
  filenameLess.payload.parts[1]!.mimeType = 'application/octet-stream'
  const forward = gmailMessage('forward', 300)
  const wrapped = {
    mimeType: 'application/octet-stream',
    filename: '',
    body: { size: 0, data: '' },
    headers: [{ name: 'Content-Type', value: 'message/rfc822' }],
    parts: [gmailMessage('quoted', 300, invite('CANCEL', 'STATUS:CANCELLED', 4)).payload],
  }
  forward.payload.parts.push(wrapped)
  state.messages = [filenameLess, forward]
  expect(await hints()).toEqual([true, false])
  expect((await list()).invitations).toEqual([expect.objectContaining({ canRespond: true })])

  const calendarPart = filenameLess.payload.parts[1]!
  calendarPart.headers!.push({ name: 'Content-Type', value: 'text/calendar; method=REPLY' })
  expect(await hints()).toEqual([true, false])
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })

  const large = gmailMessage('large-header-only', 250, invite(), {
    attached: true,
    method: 'REQUEST',
    declaredSize: 256 * 1024 + 1,
  })
  large.payload.parts[1]!.mimeType = 'application/octet-stream'
  large.payload.parts[1]!.filename = ''
  state.messages = [large, forward]
  expect(await hints()).toEqual([true, false])
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  expect(state.attachmentGets).toBe(0)
})
