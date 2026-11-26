import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyVaultSnapshot } from '@holi/shared'
import ICAL from 'ical.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createCapabilityRegistry, type Door } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createGoogleAccounts } from '../main/accounts'
import { GoogleApi } from '../main/api'
import { openGoogleCache, type GoogleCache } from '../main/cache'
import {
  disposeGoogleCapabilities,
  googleCapabilities,
  GOOGLE_NAMESPACES,
} from '../main/capabilities'
import { createClientStore } from '../main/credentials'
import { createGoogleData } from '../main/data'
import { createMailInvitationSession } from '../main/mail-invitation-session'
import { createMailInvitationStore } from '../main/mail-invitation-store'
import { createVaultAccounts } from '../main/vault-accounts'
import { GoogleTokenStore, type StoredGoogleAuth } from '../main/token-store'

// Exercise a concurrent observation while the real journal has written its
// pending file but has not atomically published the reservation.
let onReservationPublication: (() => Promise<void>) | undefined
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async chmod(...args: Parameters<typeof fs.chmod>) {
      await fs.chmod(...args)
      if (
        !onReservationPublication ||
        !String(args[0]).endsWith('google-mail-invitations.json.tmp')
      )
        return
      const pending: { attempts: { state: string }[] } = JSON.parse(
        await fs.readFile(args[0], 'utf8'),
      )
      if (!pending.attempts.some(({ state }) => state === 'unresolved')) return
      const observe = onReservationPublication
      onReservationPublication = undefined
      await observe()
    },
  }
})

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

const unicodeUid = 'réunion-�'
const withUnicodeUid = (source: string) =>
  source.replace('conference-series-1234567890-long-\r\n folded-uid', unicodeUid)

/** A real invalid byte in place of the correctly encoded replacement character. */
function invalidUidBytes(source: string): Buffer {
  const [prefix, suffix] = withUnicodeUid(source).split('�')
  return Buffer.concat([Buffer.from(prefix!), Buffer.from([0xff]), Buffer.from(suffix!)])
}

const wire = (value: string | Buffer) =>
  (typeof value === 'string' ? Buffer.from(value) : value).toString('base64url')
const json = (body: unknown, status = 200) => Response.json(body, { status })

function gmailMessage(
  id: string,
  date: number,
  calendar?: string | Buffer,
  options: {
    sent?: boolean
    from?: string
    to?: string
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
    internalDate: String(date) as string | undefined,
    labelIds: options.draft ? ['DRAFT'] : options.sent ? ['SENT'] : ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: options.from ?? (options.sent ? person : organizer) },
        { name: 'To', value: options.to ?? (options.sent ? organizer : person) },
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
    allDay?: boolean
    zeroDuration?: boolean
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
    hangoutLink: undefined as string | undefined,
    status: 'confirmed' as string | undefined,
    organizer: { email: organizer, self: false },
    start: options.allDay
      ? { date: '2024-07-18' }
      : { dateTime: start, ...(options.series ? { timeZone: 'UTC' } : {}) },
    end: options.allDay ? { date: '2024-07-19' } : { dateTime: options.zeroDuration ? start : end },
    attendeesOmitted: undefined as boolean | undefined,
    endTimeUnspecified: undefined as boolean | undefined,
    htmlLink: 'https://calendar.google.com/calendar/event?eid=example',
    attendees: [
      {
        email: person,
        self: true,
        responseStatus: 'declined' as string | undefined,
        comment: 'An existing comment',
      },
      { email: guest, self: false, responseStatus: 'tentative' },
    ],
    ...(options.series ? { recurrence: ['RRULE:FREQ=WEEKLY'] } : {}),
    ...(options.occurrence
      ? {
          recurringEventId: 'series',
          originalStartTime: options.allDay
            ? { date: '2024-07-11' }
            : { dateTime: '2024-07-11T11:00:00-04:00' },
        }
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
const closeFixtures: (() => void)[] = []
type SparseCancellation = {
  id: string
  status: 'cancelled'
  recurringEventId: string
  originalStartTime: NonNullable<ReturnType<typeof event>['originalStartTime']>
}

/** Models the account-scoped Google resources the UI sees. Writes update the
 * provider state (or fail) and the next UI read has to recover that state. */
async function rig(agendaCache?: GoogleCache, secondMailbox?: { userData: string; email: string }) {
  const userData = secondMailbox?.userData ?? (await mkdtemp(join(tmpdir(), 'holi-invitation-')))
  if (!secondMailbox) tempDirs.push(userData)
  const sub = secondMailbox ? 'other' : 'receiver'
  const mailbox = secondMailbox?.email ?? person
  const vault = secondMailbox ? 'owner/second' : remote
  const request = { ...thread, expectedAccountSub: sub }
  let now = 0
  const state = {
    messages: [
      gmailMessage('update', 200, invite().replaceAll(person, mailbox), {
        method: 'REQUEST',
        to: mailbox,
      }),
    ],
    fullThreadOverride: undefined as unknown,
    attachments: new Map<string, string | Buffer>(),
    attachmentErrors: new Map<string, number>(),
    calendarUidQueries: [] as string[],
    events: new Map<string, ReturnType<typeof event>[]>(),
    hiddenInvitationIds: new Set<string>(),
    // CalendarList can report a readable subscription while events.list sees
    // a later ACL downgrade. An exact get with this role still masks the event.
    freeBusyEventCollections: new Set<string>(),
    eventRoleOverrides: new Map<string, 'reader' | 'writer'>(),
    instanceRoleOverrides: new Map<string, 'reader'>(),
    rawInstancePage: null as unknown,
    sparseInstanceRows: new Map<string, SparseCancellation[]>(),
    instances: new Map<
      string,
      (Omit<ReturnType<typeof event>, 'iCalUID' | 'organizer'> & {
        iCalUID?: string
        organizer?: ReturnType<typeof event>['organizer']
      })[]
    >(),
    primaryCalendarId: mailbox,
    primaryCalendarRole: 'owner' as 'owner' | 'writer' | 'reader',
    secondaryCalendars: [] as {
      id: string
      selected: boolean
      hidden?: boolean
      accessRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader'
      deleted?: boolean
    }[],
    secondaryUidItems: new Map<string, unknown[]>(),
    eventCollectionErrors: new Map<string, number>(),
    hiddenCalendars: [] as string[],
    calendarOverrides: { 'hidden@example.com': false } as Record<string, boolean>,
    // Applied PATCHes requesting Calendar updates, not notification receipts.
    calendarUpdateRequests: [] as {
      calendar: string
      eventId: string
      sendUpdates: 'all'
      status: string
    }[],
    sendAttempts: 0,
    sentMime: [] as string[],
    calendarPatchAttempts: 0,
    attachmentGets: 0,
    originalGets: [] as string[],
    patchMode: 'ok' as 'ok' | 'not-found' | 'response-lost',
    primaryPages: null as unknown[] | null,
    primaryPageErrors: new Map<number, number>(),
    expandedEmptyFirstPage: false,
    expandedPages: null as unknown[] | null,
    navigationRefusal: null as { status: number; reason?: string } | null,
    navigationFetch: null as ((signal: AbortSignal) => Promise<Response | void>) | null,
    // These fixture calendars have fixed UTC offsets over the dates under test.
    calendarDateOffsets: new Map<string, string>(),
    exactCalendarError: null as number | 'non-json' | null,
    exactCalendarRows: new Map<
      string,
      Map<string, SparseCancellation & Partial<ReturnType<typeof event>>>
    >(),
    afterExactCalendarMiss: () => {},
    afterSecondaryUidRead: () => {},
    omitAfterPatch: false,
    afterPatch: () => {},
    calendarReadback: null as ReturnType<typeof event> | null,
    primaryMissing: false,
    calendarUnavailable: false,
    instanceRefusal: null as 'forbidden' | 'scope' | null,
    instanceContinuationUnavailable: false,
    instanceReads: 0,
    refreshOnQuery: false,
    refreshOnPrimaryCopy: false,
    refreshOnInstanceCopy: false,
    onRefresh: async (): Promise<Response | void> => {},
    onRevoke: async () => {},
    // Exact Gmail resources and index entries can differ from threads.get.
    sent: new Map<string, ReturnType<typeof gmailMessage>>(),
    fullSentMessage: (message: ReturnType<typeof gmailMessage>) => message,
    sentVisible: true,
    sentIndexed: true,
    sentInternalDate: null as number | null,
    receiptError: null as number | null,
    receiptErrors: new Map<string, number>(),
    receiptMissOnce: false,
    sentSearchError: null as number | null,
    sentSearchErrors: new Map<string, number>(),
    sentSearchBody: undefined as unknown,
    replyThread: 'thread',
    sendReceiptId: undefined as string | undefined,
    beforeSendAcknowledgement: async () => {},
    replaceOnQuery: false,
    sendReplyMode: 'ok' as 'ok' | 'refused' | 'empty' | 'response-lost',
  }
  const oauth: typeof fetch = async (url) => {
    if (String(url) === 'https://oauth2.googleapis.com/revoke') {
      await state.onRevoke()
      return json({})
    }
    return (await state.onRefresh()) ?? json({ access_token: `refreshed-${sub}`, expires_in: 3600 })
  }
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`fake:${value}`),
    decryptString: (value: Buffer) => value.toString().slice(5),
  }
  const store = new GoogleTokenStore(join(userData, 'tokens.enc'), storage)
  const clients = createClientStore(join(userData, 'client.enc'), storage)
  await clients.write({ id: 'original.apps.googleusercontent.com' })
  await store.write({
    receiver: account('receiver'),
    other: { ...account('other'), email: secondMailbox?.email ?? person },
  })
  const vaults = createVaultAccounts(join(userData, 'vault-links.json'))
  const accounts = await createGoogleAccounts({
    vaults,
    store,
    clients,
    fetch: oauth,
    now: () => now,
    listen: async () => {
      throw new Error('Consent is not part of this fixture')
    },
    openBrowser: async () => {
      throw new Error('Consent is not part of this fixture')
    },
  })
  await accounts.link(vault, sub)

  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const token = new Headers(init.headers).get('Authorization')
    if (token !== `Bearer token-${sub}` && token !== `Bearer refreshed-${sub}`) {
      throw new Error('The transport received credentials for a different mailbox')
    }
    if (url.pathname.endsWith('/threads/thread') && url.searchParams.get('format') === 'full') {
      return json(state.fullThreadOverride ?? { id: 'thread', messages: state.messages })
    }
    if (
      url.pathname.endsWith('/messages') &&
      url.searchParams.get('q')?.startsWith('rfc822msgid:')
    ) {
      if (state.sentSearchError) return json({}, state.sentSearchError)
      if (state.sentSearchBody !== undefined) return json(state.sentSearchBody)
      const query = url.searchParams.get('q')!
      const includeSpamTrash = url.searchParams.get('includeSpamTrash') === 'true'
      const requiredLabels = url.searchParams.getAll('labelIds')
      const status = state.sentSearchErrors.get(query)
      if (status) return json({}, status)
      const matching =
        state.sentVisible && state.sentIndexed
          ? [...state.sent.values()].filter(
              ({ payload, labelIds }) =>
                requiredLabels.every((label) => labelIds.includes(label)) &&
                (includeSpamTrash || (!labelIds.includes('SPAM') && !labelIds.includes('TRASH'))) &&
                payload.headers.some(
                  ({ name, value }) =>
                    name.toLowerCase() === 'message-id' &&
                    query === `rfc822msgid:${value.slice(1, -1)}`,
                ),
            )
          : []
      return json(
        matching.length ? { messages: matching.map(({ id, threadId }) => ({ id, threadId })) } : {},
      )
    }
    const messagePath = /\/messages\/([^/]+)$/.exec(url.pathname)
    if (messagePath && url.searchParams.get('format') === 'full') {
      if (state.receiptMissOnce) {
        state.receiptMissOnce = false
        return json({}, 404)
      }
      if (state.receiptError)
        return json(
          { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
          state.receiptError,
        )
      const id = messagePath[1]!
      const status = state.receiptErrors.get(id)
      if (status) return json({}, status)
      const message = state.sentVisible ? state.sent.get(id) : undefined
      return message ? json(state.fullSentMessage(message)) : json({}, 404)
    }
    const attachment = /\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
    if (attachment) {
      state.attachmentGets++
      const id = attachment[2]!
      const status = state.attachmentErrors.get(id)
      if (status) return json({}, status)
      const bytes = state.attachments.get(id)
      return bytes ? json({ data: wire(bytes), size: Buffer.byteLength(bytes) }) : json({}, 404)
    }
    const secondaryCalendars = [
      ...state.secondaryCalendars.map((calendar) => ({ accessRole: 'owner', ...calendar })),
      ...state.hiddenCalendars.map((id) => ({
        id,
        selected: false,
        hidden: true,
        accessRole: 'owner',
      })),
    ]
    const calendarKey = (calendarId: string) =>
      calendarId === state.primaryCalendarId ? 'primary' : calendarId
    const eventAccessRole = (id: string) => {
      if (state.freeBusyEventCollections.has(id)) return 'freeBusyReader'
      if (id === 'primary' && state.primaryMissing) return undefined
      return (
        state.eventRoleOverrides.get(id) ??
        (id === 'primary'
          ? state.primaryCalendarRole
          : secondaryCalendars.find(
              (calendar) => calendar.id === id && !('deleted' in calendar && calendar.deleted),
            )?.accessRole)
      )
    }
    const calendarListPath = /\/users\/me\/calendarList(?:\/([^/]+))?$/.exec(url.pathname)
    if (calendarListPath) {
      const calendars = [
        ...(state.primaryMissing
          ? []
          : [
              {
                id: state.primaryCalendarId,
                primary: true,
                selected: true,
                accessRole: state.primaryCalendarRole,
              },
            ]),
        ...secondaryCalendars,
      ].map((calendar) => ({ kind: 'calendar#calendarListEntry', ...calendar }))
      if (calendarListPath[1]) {
        const id = decodeURIComponent(calendarListPath[1])
        const entry = calendars.find((row) =>
          id === 'primary' ? 'primary' in row && row.primary : row.id === id,
        )
        if (!entry) return json({}, 404)
        return json({
          ...entry,
          accessRole: eventAccessRole(calendarKey(entry.id)) ?? entry.accessRole,
        })
      }
      if (state.refreshOnQuery) now = 3_600_000
      const showHidden = url.searchParams.get('showHidden') === 'true'
      const showDeleted = url.searchParams.get('showDeleted') === 'true'
      const minRole = url.searchParams.get('minAccessRole')
      return json({
        kind: 'calendar#calendarList',
        items: calendars.filter(
          (calendar) =>
            (showHidden || !('hidden' in calendar && calendar.hidden)) &&
            (showDeleted || !('deleted' in calendar && calendar.deleted)) &&
            (minRole !== 'reader' || calendar.accessRole !== 'freeBusyReader'),
        ),
      })
    }
    const instancePath = /\/calendars\/([^/]+)\/events\/([^/]+)\/instances$/.exec(url.pathname)
    if (instancePath) {
      state.instanceReads++
      if (state.rawInstancePage) return json(state.rawInstancePage)
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
      const calendarId = decodeURIComponent(instancePath[1]!)
      const id = calendarKey(calendarId)
      const accessRole = eventAccessRole(id)
      if (accessRole === undefined) return json({}, 404)
      if (accessRole === 'freeBusyReader')
        return json({ kind: 'calendar#events', accessRole, items: [] })
      const instances = [
        ...(state.instances.get(id) ?? []),
        ...(state.sparseInstanceRows.get(id) ?? []),
      ]
      const seriesId = decodeURIComponent(instancePath[2]!)
      const original = url.searchParams.get('originalStart')
      if (state.instanceContinuationUnavailable && url.searchParams.has('pageToken'))
        return json({}, 503)
      const items = instances.filter(
        (item) =>
          item.recurringEventId === seriesId &&
          (item.status !== 'cancelled' || url.searchParams.get('showDeleted') === 'true') &&
          (item.originalStartTime?.date !== undefined
            ? item.originalStartTime.date === original
            : Date.parse(item.originalStartTime?.dateTime ?? '') === Date.parse(original ?? '')),
      )
      if (items.length && state.refreshOnInstanceCopy) now = 3_600_000
      return json({
        kind: 'calendar#events',
        accessRole: state.instanceRoleOverrides.get(id) ?? accessRole,
        nextPageToken: state.instanceContinuationUnavailable ? 'next' : undefined,
        items,
      })
    }
    if (url.pathname === '/calendar/v3/colors') return json({ kind: 'calendar#colors' })
    const calendar = /\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname)
    if (calendar) {
      const calendarId = decodeURIComponent(calendar[1]!)
      const id = calendarKey(calendarId)
      if (state.calendarUnavailable) throw new TypeError('Calendar offline')
      const accessRole = eventAccessRole(id)
      if (accessRole === undefined) return json({}, 404)
      if (accessRole === 'freeBusyReader')
        return calendar[2]
          ? json({}, 404)
          : json({ kind: 'calendar#events', accessRole, items: [] })
      const events = state.events.get(id) ?? []
      if (init.method === 'PATCH') {
        state.calendarPatchAttempts++
        if (accessRole === 'reader' || state.instanceRoleOverrides.has(id))
          return json({ error: { errors: [{ reason: 'forbidden' }] } }, 403)
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
        const attendee = update.attendees[0]
        if (
          !update.attendeesOmitted ||
          update.attendees.length !== 1 ||
          !attendee?.responseStatus ||
          !['accepted', 'tentative', 'declined'].includes(attendee.responseStatus) ||
          attendee.email !== currentEvent.attendees.find(({ self }) => self)?.email
        ) {
          return json({ error: 'Only the RSVP of the calendar attendee may change' }, 400)
        }
        currentEvent.attendees[0] = attendee
        currentEvent.etag = `"version-${state.calendarPatchAttempts}"`
        const sendUpdates = url.searchParams.get('sendUpdates')
        if (sendUpdates === 'all') {
          state.calendarUpdateRequests.push({
            calendar: id,
            eventId: currentEvent.id,
            sendUpdates,
            status: attendee.responseStatus,
          })
        }
        if (state.omitAfterPatch) state.primaryPages = [{ kind: 'calendar#events' }]
        state.afterPatch()
        return json(currentEvent)
      }
      if (calendar[2]) {
        state.originalGets.push(calendar[2])
        if (state.exactCalendarError === 'non-json')
          return new Response('<html>invalid event</html>')
        if (state.exactCalendarError) return json({}, state.exactCalendarError)
        const exact = state.exactCalendarRows.get(id)?.get(calendar[2])
        const original =
          exact ??
          [...events, ...(state.instances.get(id) ?? [])].find((event) => event.id === calendar[2])
        if (original) return json(original)
        state.afterExactCalendarMiss()
        return json({}, 404)
      }
      const collectionError = state.eventCollectionErrors.get(id)
      if (collectionError) return json({}, collectionError)
      const queryUid = url.searchParams.get('iCalUID')
      if (queryUid !== null) state.calendarUidQueries.push(queryUid)
      if (url.searchParams.has('timeMin')) {
        const fault = await state.navigationFetch?.(init.signal!)
        if (fault) return fault
        if (state.navigationRefusal) {
          const { status, reason } = state.navigationRefusal
          return reason
            ? json({ error: { details: [{ reason }] } }, status)
            : new Response('Calendar unavailable', { status })
        }
      }
      const timeBound = (param: 'timeMin' | 'timeMax') =>
        Math.floor(Date.parse(url.searchParams.get(param) ?? '') / 1000) * 1000
      const min = timeBound('timeMin')
      const max = timeBound('timeMax')
      const calendarInstant = (time: ReturnType<typeof event>['start']) =>
        Date.parse(
          time.date === undefined
            ? (time.dateTime ?? '')
            : `${time.date}T00:00:00${state.calendarDateOffsets.get(id) ?? 'Z'}`,
        )
      const withinTimeBounds = (row: Pick<ReturnType<typeof event>, 'start' | 'end'>) =>
        (!url.searchParams.has('timeMin') || calendarInstant(row.end) > min) &&
        (!url.searchParams.has('timeMax') || calendarInstant(row.start) < max)
      const visibleInvitation = (row: { id: string }) =>
        url.searchParams.get('showHiddenInvitations') === 'true' ||
        !state.hiddenInvitationIds.has(row.id)
      if (url.searchParams.get('singleEvents') === 'true') {
        if (state.expandedEmptyFirstPage && !url.searchParams.has('pageToken'))
          return json({ kind: 'calendar#events', accessRole, nextPageToken: '0' })
        const limit = Number(url.searchParams.get('maxResults') ?? '250')
        const offset = Number(url.searchParams.get('pageToken') ?? '0')
        if (state.expandedPages)
          return offset < state.expandedPages.length
            ? json(state.expandedPages[offset])
            : json({}, 404)
        const instances = state.instances.get(id) ?? []
        const upcoming = (
          queryUid === null
            ? [...events.filter((event) => !event.recurrence), ...instances]
            : instances
        )
          .filter(
            (event) =>
              (queryUid === null ||
                event.iCalUID === queryUid ||
                (event.iCalUID === undefined &&
                  events.some(
                    (parent) => parent.id === event.recurringEventId && parent.iCalUID === queryUid,
                  ))) &&
              event.status !== 'cancelled' &&
              visibleInvitation(event) &&
              withinTimeBounds(event),
          )
          .sort((a, b) => calendarInstant(a.start) - calendarInstant(b.start))
        return json({
          kind: 'calendar#events',
          accessRole,
          items: upcoming.slice(offset, offset + limit),
          nextPageToken: offset + limit < upcoming.length ? String(offset + limit) : undefined,
        })
      }
      if (id === 'primary' && state.primaryPages) {
        const page = Number(url.searchParams.get('pageToken') ?? 0)
        const status =
          state.primaryPageErrors.get(page) ?? (page < state.primaryPages.length ? 200 : 404)
        return json(status === 200 ? state.primaryPages[page] : {}, status)
      }
      const secondaryUidItems = queryUid !== null && state.secondaryUidItems.get(id)
      if (secondaryUidItems) {
        state.afterSecondaryUidRead()
        return json({ kind: 'calendar#events', accessRole, items: secondaryUidItems })
      }
      const items = (
        state.calendarPatchAttempts && state.calendarReadback ? [state.calendarReadback] : events
      ).filter(
        (e) =>
          e.iCalUID === queryUid &&
          (e.status !== 'cancelled' || url.searchParams.get('showDeleted') === 'true') &&
          visibleInvitation(e) &&
          withinTimeBounds(e),
      )
      if (state.replaceOnQuery) {
        state.replaceOnQuery = false
        state.messages.push(gmailMessage('newer', 400, invite('REQUEST', '', 4)))
      }
      if (id === 'primary' && items.length && state.refreshOnPrimaryCopy) now = 3_600_000
      return json({ kind: 'calendar#events', accessRole, items })
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
        !raw.includes(`From: ${mailbox}\r\n`)
      ) {
        return json({ error: 'Cannot file the calendar reply in this conversation' }, 400)
      }
      state.sentMime.push(raw)
      const reply = gmailMessage(
        `reply-${state.sendAttempts}`,
        state.sentInternalDate ??
          Math.max(
            500,
            ...[...state.messages, ...state.sent.values()].map(({ internalDate }) =>
              Number(internalDate),
            ),
          ) + 1,
        Buffer.from(part[1]!, 'base64'),
        {
          sent: true,
          from: mailbox,
          method: 'REPLY',
          rfcId,
          parent,
          threadId: state.replyThread,
        },
      )
      state.sent.set(reply.id, reply)
      if (state.replyThread === 'thread') state.messages.push(reply)
      await state.beforeSendAcknowledgement()
      if (state.sendReplyMode === 'response-lost') throw new TypeError('Lost the send response')
      if (state.sendReplyMode === 'empty') return new Response(null, { status: 200 })
      return json({
        id: state.sendReceiptId ?? reply.id,
        threadId: state.replyThread,
        labelIds: ['SENT'],
      })
    }
    throw new Error(`Unhandled Google request: ${init.method ?? 'GET'} ${url}`)
  })

  const service = () => {
    const data = agendaCache
      ? createGoogleData({
          api: () =>
            new GoogleApi({
              accessToken: async () => (await accounts.sessionFor(vault))!.getAccessToken(),
            }),
          cache: agendaCache,
        })
      : null
    const caps = googleCapabilities({
      accounts,
      mailInvitations: createMailInvitationSession(createMailInvitationStore(userData)),
      dataFor: async () => data,
      settings: {
        read: async () => ({
          calendars: state.calendarOverrides,
          imageSenders: [],
          imagesFromAllSenders: false,
        }),
        write: async (_root, patch) => {
          if (patch.calendars) state.calendarOverrides = patch.calendars
        },
      },
    })
    const close = () => disposeGoogleCapabilities(caps)
    closeFixtures.push(close)
    const registry = createCapabilityRegistry()
    registry.register(GOOGLE_NAMESPACES, caps)
    const call = async (name: string, params: unknown, door: Door = 'ui') =>
      (
        await registry.run(
          `google.${name}`,
          door,
          {
            remote: vault,
            root: '/vault',
            bundle: null,
            claims: async () => [],
            snapshot: async () => emptyVaultSnapshot(),
            core: noCoreServices(),
          },
          params,
        )
      ).value
    type Session = ReturnType<typeof createMailInvitationSession>
    type Read = Awaited<ReturnType<Session['read']>>
    type Respond = Awaited<ReturnType<Session['respond']>>
    let current: Read['invitations'][number] | null = null
    const list = async (params = request) => (await call('mailInvitation', params)) as Read
    return {
      close,
      call,
      list,
      async read(params = request, scope?: Read['invitations'][number]['scope']) {
        const { invitations } = await list(params)
        current =
          (scope ? invitations.find((card) => card.scope === scope) : invitations[0]) ?? null
        return current
      },
      async respond(answer: string, override?: Record<string, unknown>) {
        const result = (await call('respondToMailInvitation', {
          ...request,
          identity: { ...current?.identity, ...override },
          expectedBindingRevision: current?.bindingRevision,
          expectedResponseTargetKey: current?.responseTargetKey ?? null,
          answer,
        })) as Respond
        if (result.invitation) current = result.invitation
        return result
      },
    }
  }
  return { userData, state, accounts, restart: service, ...service() }
}

afterEach(async () => {
  onReservationPublication = undefined
  for (const close of closeFixtures.splice(0)) close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('excludes guest REQUEST and CANCEL deliveries from organizer history and reply parents', async () => {
  const { state, list, read, respond } = await rig()
  const genuine = gmailMessage('update', 100, invite(), {
    from: `(sent for the meeting) "Host, Organizer" <${organizer.toUpperCase()}> (host)`,
  })
  genuine.payload.headers.push({ name: 'Sender', value: organizer })
  const guestRequest = gmailMessage('guest-update', 300, invite('REQUEST', '', 4), { from: guest })
  const guestCancel = gmailMessage('guest-cancel', 400, invite('CANCEL', 'STATUS:CANCELLED', 5), {
    from: guest,
  })
  state.messages = [guestRequest, guestCancel]
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  const guestPredecessor = gmailMessage(
    'guest-predecessor',
    250,
    invite('REQUEST', '', 3, '20240601T090000Z').replace('Upstairs', 'Downstairs'),
    { from: guest },
  )
  state.messages = [genuine, guestPredecessor, guestRequest, guestCancel]
  state.events.set('primary', [event()])
  expect(await read()).toMatchObject({
    identity,
    canRespond: true,
    recordedResponseStatus: 'declined',
  })
  state.events.clear()
  expect(await read()).toMatchObject({ identity, canRespond: true, cancelled: false })
  await expect(
    respond('accepted', { messageId: guestRequest.id, sequence: 4 }),
  ).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', channel: 'gmail' })
  expect(state.sentMime).toHaveLength(1)
  expect(state.sentMime[0]).toContain('In-Reply-To: <update@example.net>')
})

it.each([
  ['malformed From', `${organizer} (unclosed`, []],
  ['multiple From mailboxes', `${organizer}, ${guest}`, []],
  ['duplicate From', organizer, [{ name: 'fRoM', value: organizer }]],
  [
    'duplicate Sender',
    organizer,
    [
      { name: 'Sender', value: organizer },
      { name: 'sender', value: organizer },
    ],
  ],
  ['malformed Sender', organizer, [{ name: 'Sender', value: `${organizer},` }]],
  ['unverified sender relay', organizer, [{ name: 'Sender', value: guest }]],
  ['self-asserted delegation', guest, [{ name: 'Reply-To', value: organizer }]],
] as const)('does not grant organizer authority to %s', async (defect, from, headers) => {
  const { state, list } = await rig()
  const request =
    defect === 'self-asserted delegation'
      ? invite().replace('ORGANIZER;', `ORGANIZER;SENT-BY="mailto:${guest}";`)
      : invite()
  const delivery = gmailMessage('update', 300, request, { from })
  delivery.payload.headers.push(...headers)
  state.messages = [delivery]
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('patches only the attendee on the primary copy of a past invitation and confirms each answer by readback', async () => {
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
  expect(state.calendarUpdateRequests).toEqual(
    ['accepted', 'tentative', 'declined'].map((status) => ({
      calendar: 'primary',
      eventId: primary.id,
      sendUpdates: 'all',
      status,
    })),
  )
  expect(primary.attendees).toEqual(event().attendees)
  expect(state.sendAttempts).toBe(0)
})

it.each(['verified', 'unverifiable'] as const)(
  'does not fall back to Gmail for an unseen hidden %s invitation copy',
  async (verification) => {
    const { state, read, respond } = await rig()
    const calendar = 'secondary@example.com'
    const copy = {
      ...event({ id: 'hidden-invitation' }),
      sequence: verification === 'verified' ? 3 : 2,
    }
    state.secondaryCalendars = [{ id: calendar, selected: false, accessRole: 'writer' }]
    state.events.set(calendar, [copy])
    state.hiddenInvitationIds.add(copy.id)

    if (verification === 'verified') {
      expect(await read()).toMatchObject({
        htmlLink: copy.htmlLink,
        responseStatus: 'declined',
        canRespond: true,
      })
      expect(await respond('accepted')).toMatchObject({
        channel: 'calendar',
        outcome: 'sent',
        refreshPending: false,
        invitation: { responseStatus: 'accepted' },
      })
      expect(state.calendarUpdateRequests).toEqual([
        { calendar, eventId: copy.id, sendUpdates: 'all', status: 'accepted' },
      ])
    } else {
      expect(await read()).toMatchObject({
        canRespond: false,
        responseStatus: null,
        responseTargetKey: null,
        htmlLink: null,
      })
      await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(state.calendarPatchAttempts).toBe(0)
    }
    expect(state.sendAttempts).toBe(0)
  },
)

it('does not answer a partial, incoherent, or unconditionally writable Calendar copy', async () => {
  const { state, read, respond } = await rig()
  const valid = { ...event(), etag: '"version,opaque"' }
  state.events.set('primary', [valid])
  for (const incomplete of [
    { start: undefined },
    { end: undefined },
    { endTimeUnspecified: true },
    { end: { date: '2024-07-19' } },
    { end: { dateTime: '2024-06-31T16:00:00Z' } },
    { etag: undefined },
    { etag: '*' },
    { etag: 'W/"version"' },
    { etag: '"version", "other"' },
    { etag: '"version"\r\n' },
    { etag: 'version' },
  ]) {
    state.primaryPages = [{ kind: 'calendar#events', items: [{ ...valid, ...incomplete }] }]
    expect(await read()).toMatchObject({ canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  }
  state.primaryPages = null
  expect(await read()).toMatchObject({ canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)
})

it.each(['all-day', 'zero-duration'] as const)(
  'can RSVP to a complete %s Calendar copy',
  async (kind) => {
    const { state, read, respond } = await rig()
    const allDay = kind === 'all-day'
    const times = allDay
      ? 'DTSTART;VALUE=DATE:20240718\r\nDTEND;VALUE=DATE:20240719'
      : 'DTSTART:20240718T150000Z'
    state.messages = [gmailMessage('update', 200, invite('REQUEST', times))]
    state.events.set('primary', [event({ allDay, zeroDuration: !allDay })])
    expect(await read()).toMatchObject({ allDay, canRespond: true })
    expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
    expect(state.sendAttempts).toBe(0)
  },
)

it.each(['timed invitation', 'all-day occurrence'] as const)(
  'blocks both RSVP channels when the Calendar copy extends the implicit end of a %s',
  async (kind) => {
    const { state, read, respond, restart } = await rig()
    const allDay = kind === 'all-day occurrence'
    const times = allDay
      ? 'DTSTART;VALUE=DATE:20240718\r\nRECURRENCE-ID;VALUE=DATE:20240711'
      : 'DTSTART:20240718T150000Z'
    state.messages = [gmailMessage('update', 200, invite('REQUEST', times))]
    const copy = event({ allDay, occurrence: allDay })
    if (allDay) copy.end = { date: '2024-07-20' }
    state.events.set('primary', [copy])

    const readOnly = {
      identity: { ...identity, recurrenceId: allDay ? '2024-07-11' : null },
      end: allDay ? '2024-07-19' : start,
      canRespond: false,
      recordedResponseStatus: null,
      responseTargetKey: null,
    }
    expect(await read()).toMatchObject(readOnly)
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // A complete collection can omit the copy, but its exact resource is
    // still present and must not turn the read-only card into a Gmail target.
    state.primaryPages = [{ kind: 'calendar#events' }]
    const reopened = restart()
    expect(await reopened.read()).toMatchObject(readOnly)
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts).toBe(0)
    expect(state.sendAttempts).toBe(0)

    if (allDay) {
      copy.end = { date: '2024-07-19' }
      state.primaryPages = null
      expect(await reopened.read()).toMatchObject({ end: '2024-07-19', canRespond: true })
      expect(await reopened.respond('accepted')).toMatchObject({
        outcome: 'sent',
        channel: 'calendar',
        refreshPending: false,
        invitation: { responseStatus: 'accepted' },
      })
      expect(state.calendarUpdateRequests).toEqual([
        { calendar: 'primary', eventId: copy.id, sendUpdates: 'all', status: 'accepted' },
      ])
      expect(state.calendarPatchAttempts).toBe(1)
      expect(state.sendAttempts).toBe(0)
    }
  },
)

it.each(['DTEND:20240718T150000Z', 'DURATION:PT0S'])(
  'does not authorize either RSVP channel for an explicit zero interval (%s)',
  async (interval) => {
    const { state, read, respond } = await rig()
    state.messages = [
      gmailMessage('older', 100, invite()),
      gmailMessage(
        'update',
        200,
        invite('REQUEST', `DTSTART:20240718T150000Z\r\n${interval}`, 3, '20240702T090000Z'),
      ),
    ]
    state.events.set('primary', [event({ zeroDuration: true })])
    expect(await read()).toMatchObject({ identity, start, end: start, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    state.events.clear()
    expect(await read()).toMatchObject({ identity, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it.each([
  { dtstart: 'DTSTART:20240718T150000Z', start, end: start, allDay: false },
  { dtstart: 'DTSTART;VALUE=DATE:20240718', start: '2024-07-18', end: '2024-07-19', allDay: true },
])('sends an iTIP reply without an explicit interval for $dtstart', async (times) => {
  const { state, read, respond } = await rig()
  state.messages = [gmailMessage('update', 200, invite('REQUEST', times.dtstart))]
  expect(await read()).toMatchObject({
    start: times.start,
    end: times.end,
    allDay: times.allDay,
    canRespond: true,
  })
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'gmail',
    refreshPending: false,
    invitation: { responseStatus: 'accepted' },
  })
  const encoded = state.sent.get('reply-1')?.payload.parts[1]?.body.data
  const reply = Buffer.from(encoded!, 'base64url').toString('utf8')
  expect(reply.split('\r\n')).toContain(times.dtstart)
  expect(reply).not.toMatch(/^(DTEND|DURATION)[:;]/m)
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('uses original start and the hidden secondary calendar ID for an attached, moved occurrence', async () => {
  const { state, read, respond } = await rig()
  const calendar = 'hidden@example.com'
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
  expect(await read()).toMatchObject({
    identity: occurrence,
    canRespond: false,
    unavailableReason: expect.stringMatching(/time zone definition/i),
  })
  await expect(respond('accepted', occurrence)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)

  state.hiddenCalendars = [calendar]
  state.events.set(calendar, [event({ id: 'series', series: true })])
  state.instances.set(calendar, [event({ id: 'moved', occurrence: true })])
  expect(await read()).toMatchObject({ identity: occurrence, start, end, canRespond: true })
  expect(await respond('accepted', occurrence)).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
  })
  expect(state.calendarUpdateRequests).toEqual([
    { calendar, eventId: 'moved', sendUpdates: 'all', status: 'accepted' },
  ])
  expect(state.sendAttempts).toBe(0)
})

it('does not email a zoned occurrence if a verified Calendar target disappears at final preflight', async () => {
  const { state, read, respond } = await rig()
  state.messages = [
    gmailMessage(
      'update',
      200,
      invite(
        'REQUEST',
        [
          'RECURRENCE-ID;TZID=America/New_York:20240711T110000',
          'DTSTART:20240718T150000Z',
          'DTEND:20240718T160000Z',
        ].join('\r\n'),
      ),
    ),
  ]
  state.events.set('primary', [event({ id: 'moved', occurrence: true })])
  expect(await read()).toMatchObject({ canRespond: true, scope: 'occurrence' })
  state.refreshOnPrimaryCopy = true
  state.onRefresh = async () => {
    state.events.clear()
  }
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(await read()).toMatchObject({
    canRespond: false,
    unavailableReason: expect.stringMatching(/time zone definition/i),
  })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
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

it('sends an email reply without the optional DTSTART when its IANA zone was not supplied', async () => {
  const { state, read, respond } = await rig()
  const request = invite(
    'REQUEST',
    'DTSTART;TZID=America/New_York:20240718T110000\r\nDTEND:20240718T160000Z',
  )
  state.messages = [gmailMessage('update', 200, request, { method: 'REQUEST' })]
  expect(await read()).toMatchObject({ start, canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', refreshPending: false })
  const source = state.sent.get('reply-1')?.payload.parts[1]?.body.data
  const reply = new ICAL.Component(ICAL.parse(Buffer.from(source!, 'base64url').toString()))
  const entry = reply.getFirstSubcomponent('vevent')!
  expect(entry.getFirstPropertyValue('uid')).toBe(uid)
  expect(entry.hasProperty('dtstart')).toBe(false)
  expect(entry.getFirstProperty('attendee')?.getParameter('partstat')).toBe('ACCEPTED')
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
      recordedResponseStatus: null,
      sentResponseStatus: null,
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
    if (change === 'calendar copy')
      await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
    else
      expect(await respond('accepted')).toMatchObject({
        outcome: 'unchanged',
        refreshPending: false,
      })
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

it('cannot reopen or answer a Mail invitation while its OAuth grant is being revoked', async () => {
  const { state, accounts, read, respond, restart } = await rig()
  state.events.set('primary', [event()])
  await accounts.link('owner/second-vault', 'receiver')
  expect(await read()).toMatchObject({ canRespond: true })
  const old = await accounts.bindingFor(remote)
  expect(old?.isCurrent()).toBe(true)

  let start!: () => void
  let finish!: () => void
  const revoking = new Promise<void>((resolve) => (start = resolve))
  const release = new Promise<void>((resolve) => (finish = resolve))
  state.onRevoke = () => {
    start()
    return release
  }
  const replacement = 'replacement.apps.googleusercontent.com'
  const change = accounts.setClient({ id: replacement })
  try {
    await revoking
    expect(old?.isCurrent()).toBe(false)
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const reopened = restart()
    const attemptAfterReopen = async () => {
      await reopened.read()
      return reopened.respond('accepted')
    }
    await expect(attemptAfterReopen()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(accounts.bindingFor(remote)).resolves.toBeNull()
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  } finally {
    finish()
    await change
  }
  expect(accounts.client()).toEqual({ id: replacement, source: 'own' })
  expect(accounts.list()).toEqual([])
  for (const vault of [remote, 'owner/second-vault']) {
    await expect(accounts.bindingFor(vault)).resolves.toBeNull()
    expect(await accounts.overview(vault)).toMatchObject({ state: 'not-connected' })
  }
  await expect(restart().read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(old?.isCurrent()).toBe(false)
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

it.each(['thread', 'separate-thread'])(
  'keeps a Gmail RSVP in %s pending until the account-wide Sent search has a valid envelope',
  async (replyThread) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = replyThread
    state.sendReplyMode = replyThread === 'thread' ? 'empty' : 'ok'
    await read()
    state.sentSearchBody = []
    expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: true })
    const reopened = restart()
    for (const invalid of [
      [],
      'unexpected',
      { messages: [{ id: '../outside' }] },
      { nextPageToken: 1 },
      { nextPageToken: 'more' },
    ]) {
      state.sentSearchBody = invalid
      expect(await reopened.read()).toMatchObject({
        responseStatus: null,
        sentResponseStatus: null,
        responsePending: true,
        canRespond: false,
      })
      await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    state.sentSearchBody = undefined
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'accepted',
      responsePending: false,
    })
    expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it.each(['thread', 'separate-thread'])(
  'keeps the %s receipt pending when the Sent index contradicts a full message',
  async (replyThread) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = replyThread
    state.sentSearchBody = { messages: [{ id: 'lagging-hit', threadId: 'another-thread' }] }
    const wrongId = gmailMessage('lagging-hit', 600, undefined, {
      threadId: 'another-thread',
      sent: true,
    })
    state.sent.set(wrongId.id, wrongId)
    await read()
    expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: true })

    const reopened = restart()
    const pending = {
      responsePending: true,
      canRespond: false,
      responseStatus: null,
      sentResponseStatus: null,
    }
    expect(await reopened.read()).toMatchObject(pending)
    await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // The index now points to the receipt itself, but the full GET no longer
    // corroborates SENT membership, even if the thread snapshot still does.
    const receipt = state.sent.get('reply-1')!
    state.sent.set(receipt.id, { ...receipt, labelIds: ['INBOX'] })
    state.sentSearchBody = { messages: [{ id: receipt.id, threadId: receipt.threadId }] }
    expect(await reopened.read()).toMatchObject(pending)
    await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    state.sent.set(receipt.id, receipt)
    state.sentSearchBody = { messages: [{ id: receipt.id, threadId: 'stale-thread' }] }
    expect(await reopened.read()).toMatchObject(pending)
    state.sentSearchBody = undefined
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'accepted',
      responsePending: false,
    })
    expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it.each(['missing', 'wrong RFC ID'] as const)(
  'does not substitute a matching Sent message for a %s acknowledged Gmail message',
  async (defect) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = 'separate-thread'
    state.sentVisible = false
    await read()
    const pending = {
      responseStatus: null,
      sentResponseStatus: null,
      responsePending: true,
      canRespond: false,
    }
    expect(await respond('accepted')).toMatchObject({
      outcome: 'sent',
      refreshPending: true,
      invitation: pending,
    })
    const acknowledged = state.sent.get('reply-1')!
    const substitute = { ...structuredClone(acknowledged), id: 'substitute' }
    state.sent.set(substitute.id, substitute)
    if (defect === 'missing') state.sent.delete(acknowledged.id)
    else {
      const wrongHeader = structuredClone(acknowledged)
      wrongHeader.payload.headers.find(({ name }) => name === 'Message-ID')!.value =
        '<different@example.net>'
      state.sent.set(acknowledged.id, wrongHeader)
    }
    state.sentVisible = true
    const reopened = restart()
    expect(await reopened.read()).toMatchObject(pending)
    await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // A recovered full GET still cannot settle while another resource owns
    // the same RFC ID. Only the original, uniquely corroborated, can settle.
    state.sent.set(acknowledged.id, acknowledged)
    expect(await reopened.read()).toMatchObject(pending)
    state.sent.delete(substitute.id)
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'accepted',
      sentResponseStatus: 'accepted',
      responsePending: false,
      canRespond: true,
    })
    expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it('does not treat an invalid acknowledged Gmail ID as an absent ID', async () => {
  const { state, read, respond, restart } = await rig()
  state.replyThread = 'separate-thread'
  state.sendReceiptId = '../invalid'
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: true })
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({
    sentResponseStatus: null,
    responsePending: true,
    canRespond: false,
  })
  await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

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

it.each([
  ['LOCATION', 'Upstairs', 'location'],
  ['SUMMARY', 'Design sync', 'summary'],
  ['DESCRIPTION', 'Bring the plans', 'description'],
] as const)(
  'requires provider proof when a same-sequence revision adds %s',
  async (property, value, field) => {
    const { state, read, respond } = await rig()
    const latest = invite('REQUEST', '', 3, '20240702T090000Z').replace(
      new RegExp(`^${property}:[^\\r\\n]*`, 'm'),
      `${property}:${value}`,
    )
    const predecessor = latest
      .replace(`${property}:${value}\r\n`, '')
      .replace('20240702', '20240701')
    state.messages = [gmailMessage('predecessor', 200, predecessor)]
    const copy = { ...event(), [field]: undefined }
    state.events.set('primary', [copy])
    expect(await read()).toMatchObject({ canRespond: true })
    state.messages.push(gmailMessage('latest', 300, latest))
    expect(await read()).toMatchObject({ identity: { messageId: 'latest' }, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    state.events.set('primary', [{ ...copy, [field]: value }])
    expect(await read()).toMatchObject({ canRespond: true })
    expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
    expect(state.calendarUpdateRequests).toHaveLength(1)
    expect(state.sendAttempts).toBe(0)
  },
)

it('requires updated material even when the same-sequence predecessor could not be answered', async () => {
  const { state, read, respond } = await rig()
  const prior = invite('REQUEST', 'COMMENT:Date to follow').replace(
    'DESCRIPTION:https://meet.google.com/abc-defg-hij',
    'DESCRIPTION:Old agenda',
  )
  state.messages = [gmailMessage('prior', 200, prior)]
  const copy = event()
  state.events.set('primary', [copy])
  expect(await read()).toMatchObject({ canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  const latest = invite('REQUEST', '', 3, '20240702T090000Z')
    .replace('Upstairs', 'Downstairs')
    .replace('https://meet.google.com/abc-defg-hij', 'Bring the plans')
  state.messages.push(gmailMessage('latest', 300, latest))
  // Neither an omitted location nor omitted prose proves the revision, even
  // if Calendar confirms the other changed field.
  for (const fields of [{ location: 'Downstairs' }, { description: 'Bring the plans' }]) {
    state.events.set('primary', [{ ...copy, ...fields }])
    expect(await read()).toMatchObject({ identity: { messageId: 'latest' }, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.set('primary', [{ ...copy, location: 'Downstairs', description: 'Bring the plans' }])
  expect(await read()).toMatchObject({ canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it.each(['', 'X-UNKNOWN'])(
  'keeps a newer REQUEST with invalid STATUS %j read-only',
  async (status) => {
    const { state, read, respond } = await rig()
    expect(await read()).toMatchObject({ canRespond: true })
    const latest = invite('REQUEST', '', 3, '20240702T090000Z').replace(
      'END:VEVENT',
      `STATUS:${status}\r\nEND:VEVENT`,
    )
    state.messages.push(gmailMessage('latest', 300, latest))
    expect(await read()).toMatchObject({
      identity: { messageId: 'latest', uid, sequence: 3, dtstamp: '2024-07-02T09:00:00.000Z' },
      canRespond: false,
      responseStatus: null,
      unavailableReason: expect.stringMatching(/status/i),
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it('requires Calendar to distinguish a same-sequence change to the event status', async () => {
  const { state, read, respond } = await rig()
  const prior = invite().replace('END:VEVENT', 'STATUS:TENTATIVE\r\nEND:VEVENT')
  state.messages = [gmailMessage('prior', 200, prior)]
  const copy = { ...event(), status: 'tentative' }
  state.events.set('primary', [copy])
  expect(await read()).toMatchObject({ canRespond: true })
  const latest = prior.replace('TENTATIVE', 'CONFIRMED').replace('20240701', '20240702')
  state.messages.push(gmailMessage('latest', 300, latest))
  for (const status of ['tentative', undefined]) {
    state.events.set('primary', [{ ...copy, status }])
    expect(await read()).toMatchObject({ identity: { messageId: 'latest' }, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.set('primary', [{ ...copy, status: 'confirmed' }])
  expect(await read()).toMatchObject({ canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('blocks a contradictory explicit Calendar status even without the predecessor mail', async () => {
  const { state, read, respond } = await rig()
  state.messages = [
    gmailMessage(
      'latest',
      300,
      invite('REQUEST', '', 3, '20240702T090000Z').replace(
        'END:VEVENT',
        'STATUS:CONFIRMED\r\nEND:VEVENT',
      ),
    ),
  ]
  const copy = { ...event(), status: 'tentative' }
  state.events.set('primary', [copy])
  expect(await read()).toMatchObject({
    identity: { messageId: 'latest' },
    canRespond: false,
    recordedResponseStatus: null,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  copy.status = 'confirmed'
  expect(await read()).toMatchObject({ canRespond: true, recordedResponseStatus: 'declined' })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('does not answer a series master when only an embedded exception moved at the same sequence', async () => {
  const { state, read, respond } = await rig()
  const request = (stamp: string, exceptionHour: number) =>
    invite('REQUEST', '', 3, stamp)
      .replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')
      .replace(
        'END:VCALENDAR',
        [
          'BEGIN:VEVENT',
          `UID:${uid}`,
          'SEQUENCE:3',
          `DTSTAMP:${stamp}`,
          'RECURRENCE-ID:20240725T150000Z',
          `DTSTART:20240725T${exceptionHour}0000Z`,
          `DTEND:20240725T${exceptionHour + 1}0000Z`,
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
      )
  state.messages = [
    gmailMessage('prior', 100, request('20240701T090000Z', 16)),
    gmailMessage('redelivery', 200, request('20240702T090000Z', 16)),
  ]
  state.events.set('primary', [event({ series: true })])
  expect(await read()).toMatchObject({ scope: 'series', canRespond: true })

  state.messages.push(gmailMessage('moved', 300, request('20240703T090000Z', 17)))
  expect(await read()).toMatchObject({ identity: { messageId: 'moved' }, canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await read()).toMatchObject({ canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', refreshPending: false })
  expect(state.calendarPatchAttempts).toBe(0)
  expect(state.sendAttempts).toBe(1)
})

it.each([false, true])(
  'requires Calendar to prove the replacement guest in a same-sequence update (write-ineligible predecessor: %s)',
  async (missingTimes) => {
    const { state, read, respond } = await rig()
    const replacement = 'replacement@example.org'
    const prior = invite('REQUEST', missingTimes ? 'COMMENT:Time to follow' : '').replace(
      'END:VEVENT',
      `ATTENDEE:mailto:${guest}\r\nEND:VEVENT`,
    )
    const latest = invite('REQUEST', '', 3, '20240702T090000Z').replace(
      'END:VEVENT',
      `ATTENDEE;ROLE=OPT-PARTICIPANT;RSVP=TRUE:mailto:${replacement}\r\nEND:VEVENT`,
    )
    state.messages = [gmailMessage('prior', 100, prior), gmailMessage('latest', 200, latest)]
    const copy = event()
    const replacementEntry = { ...copy.attendees[1]!, email: replacement.toUpperCase() }
    for (const unverified of [
      copy,
      { ...copy, attendees: [copy.attendees[0]!] },
      { ...copy, attendees: [copy.attendees[0]!, replacementEntry], attendeesOmitted: true },
    ]) {
      state.events.set('primary', [unverified])
      expect(await read()).toMatchObject({ identity: { messageId: 'latest' }, canRespond: false })
      await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    const latestCopy = { ...copy, attendees: [copy.attendees[0]!, replacementEntry] }
    state.events.set('primary', [latestCopy])
    expect(await read()).toMatchObject({ canRespond: true })
    expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
    expect(latestCopy.attendees[1]).toEqual({
      email: replacement.toUpperCase(),
      responseStatus: 'tentative',
      self: false,
    })
    expect(state.calendarUpdateRequests).toHaveLength(1)
    expect(state.sendAttempts).toBe(0)
  },
)

it('accepts structured conference proof when a bare join URL distinguishes same-sequence mail', async () => {
  const { state, read, respond } = await rig()
  const latest = invite('REQUEST', '', 3, '20240702T090000Z')
  state.messages = [
    gmailMessage('previous', 200, invite().replace(/^DESCRIPTION:[^\r\n]*\r\n/m, '')),
    gmailMessage('latest', 300, latest),
  ]
  const copy = { ...event(), hangoutLink: 'https://meet.google.com/abc-defg-hij' }
  state.events.set('primary', [copy])
  expect(await read()).toMatchObject({ canRespond: true, conferenceLinkSource: 'calendar' })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
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

function upcomingInstance(id: string, day: string, link: string) {
  return {
    ...event({ id, occurrence: true }),
    start: { dateTime: `${day}T15:00:00Z` },
    end: { dateTime: `${day}T16:00:00Z` },
    originalStartTime: { dateTime: `${day}T15:00:00Z` },
    hangoutLink: link,
    htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
  }
}

function seriesWithException(...occurrences: string[]) {
  const exceptions = occurrences
    .map((source) => source.slice(source.indexOf('BEGIN:VEVENT'), source.indexOf('END:VCALENDAR')))
    .join('')
  return invite()
    .replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')
    .replace('END:VCALENDAR', `${exceptions}END:VCALENDAR`)
}

function movedRequest(stamp: string, room: string) {
  return invite('REQUEST', 'DTSTART:20990711T150000Z\r\nDTEND:20990711T160000Z', 3, stamp)
    .replace('https://meet.google.com/abc-defg-hij', room)
    .replace('END:VEVENT', 'RECURRENCE-ID:20990709T150000Z\r\nEND:VEVENT')
}

it('joins the next verified series occurrence but answers only the master', async () => {
  const { state, read, respond } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
  )
  const master = {
    ...event({ id: 'series', series: true }),
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
  }
  const next = upcomingInstance('next', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg')
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  state.events.set('primary', [master])
  state.instances.set('primary', [later, event({ id: 'past', occurrence: true }), next])
  state.expandedEmptyFirstPage = true
  expect(await read()).toMatchObject({
    scope: 'series',
    conferenceUrl: next.hangoutLink,
    htmlLink: next.htmlLink,
    canRespond: true,
  })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.instances.set('primary', [later])
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    refreshPending: false,
    invitation: { conferenceUrl: later.hangoutLink, htmlLink: later.htmlLink },
  })
  expect(state.calendarUpdateRequests.map(({ eventId }) => eventId)).toEqual([master.id])
  expect(later.attendees[0]?.responseStatus).toBe('declined')
  expect(state.sendAttempts).toBe(0)
})

it.each([
  { status: 401, code: 'UNAUTHORIZED' },
  { status: 403, reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', code: 'FORBIDDEN' },
  { status: 429, code: 'RATE_LIMITED' },
])(
  'refuses a series read on navigation HTTP $status but preserves an accepted write',
  async (refusal) => {
    const { state, list, read, respond } = await rig()
    state.messages[0] = gmailMessage('update', 200, seriesWithException())
    const master = event({ id: 'series', series: true })
    const next = upcomingInstance('next', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg')
    state.events.set('primary', [master])
    state.instances.set('primary', [next])
    expect(await read()).toMatchObject({ canRespond: true, conferenceUrl: next.hangoutLink })

    state.navigationRefusal = refusal
    await expect(list()).rejects.toMatchObject({ code: refusal.code })
    // A request for the already-recorded answer does not send and still cannot
    // return a normal card from a refused read.
    await expect(respond('declined')).rejects.toMatchObject({ code: refusal.code })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    state.navigationRefusal = null
    state.afterPatch = () => {
      state.navigationRefusal = refusal
    }
    expect(await respond('accepted')).toMatchObject({
      outcome: 'sent',
      channel: 'calendar',
      invitation: null,
      refreshPending: true,
    })
    expect(state.calendarUpdateRequests).toMatchObject([{ eventId: master.id, status: 'accepted' }])

    state.navigationRefusal = null
    expect(await read()).toMatchObject({
      responsePending: false,
      responseStatus: 'accepted',
      conferenceUrl: next.hangoutLink,
      htmlLink: next.htmlLink,
    })
    expect(state.calendarPatchAttempts).toBe(1)
    expect(state.sendAttempts).toBe(0)
  },
)

it.each(['timeout', 'non-json'])(
  'keeps a verified series response when the optional Join read returns %s',
  async (failure) => {
    const { state, read, respond } = await rig()
    state.messages = [gmailMessage('series-request', 200, seriesWithException())]
    const master = event({ id: 'series', series: true })
    const next = upcomingInstance('next', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg')
    state.events.set('primary', [master])
    state.instances.set('primary', [next])
    const card = await read()
    expect(card).toMatchObject({ canRespond: true, conferenceUrl: next.hangoutLink })

    if (failure === 'non-json') {
      state.navigationFetch = async () => new Response('<html>invalid provider response</html>')
    } else {
      // Abort the same request signal that fetch receives, rejecting with its
      // deadline reason just as fetch does. No timers or simulated HTTP status.
      let deadline: AbortController
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(
        () => (deadline = new AbortController()).signal,
      )
      state.navigationFetch = (signal) => {
        deadline.abort(new DOMException('Resource deadline exceeded', 'TimeoutError'))
        return Promise.reject(signal.reason)
      }
    }
    const withoutNavigation = {
      canRespond: true,
      responseTargetKey: card!.responseTargetKey,
      conferenceUrl: null,
      htmlLink: master.htmlLink,
    }
    expect(await read()).toMatchObject({ ...withoutNavigation, responseStatus: 'declined' })
    expect(await respond('accepted')).toMatchObject({
      outcome: 'sent',
      channel: 'calendar',
      refreshPending: false,
      invitation: { ...withoutNavigation, responseStatus: 'accepted', responsePending: false },
    })
    expect(await respond('accepted')).toMatchObject({ outcome: 'unchanged' })
    expect(state.calendarUpdateRequests).toMatchObject([{ eventId: master.id, status: 'accepted' }])
    expect(state.calendarPatchAttempts).toBe(1)
    expect(state.sendAttempts).toBe(0)
  },
)

it.each(['timeout', 'non-json'])(
  'fails the invitation read if OAuth refresh before Join returns %s',
  async (failure) => {
    const { state, list } = await rig()
    state.messages = [gmailMessage('series-request', 200, seriesWithException())]
    state.events.set('primary', [event({ id: 'series', series: true })])
    // Expire the token only after the authoritative Calendar collection read.
    state.refreshOnPrimaryCopy = true
    state.onRefresh = async () => {
      if (failure === 'timeout') throw new DOMException('OAuth request timed out', 'TimeoutError')
      return new Response('<html>invalid OAuth response</html>')
    }
    await expect(list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it('fails the read when a Join observation cannot be retained', async () => {
  const { state, list, userData } = await rig()
  state.messages = [gmailMessage('series-request', 200, seriesWithException())]
  state.events.set('primary', [event({ id: 'series', series: true })])
  state.instances.set('primary', [
    upcomingInstance('next', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg'),
  ])
  state.navigationFetch = async () => {
    await writeFile(join(userData, 'google-mail-invitations.json'), '{')
  }
  await expect(list()).rejects.toMatchObject({ code: 'EVIDENCE_STORE_FAILURE' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('joins an embedded exception only when Calendar verifies its original slot and revision', async () => {
  const { state, list, read, respond } = await rig()
  const newRoom = 'https://meet.google.com/qrs-tuvw-xyz'
  state.messages[0] = gmailMessage(
    'update',
    200,
    seriesWithException(movedRequest('20240702T090000Z', newRoom)),
  )
  const master = event({ id: 'series', series: true })
  const stale = upcomingInstance('moved', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg')
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  state.events.set('primary', [master])
  state.instances.set('primary', [stale, later])

  const { invitations } = await list()
  expect(invitations).toHaveLength(1)
  const [series] = invitations
  const skipsStale = {
    scope: 'series',
    canRespond: true,
    conferenceUrl: later.hangoutLink,
    htmlLink: later.htmlLink,
    responseTargetKey: series!.responseTargetKey,
  }
  expect(series).toMatchObject(skipsStale)
  // A current URL alone is not proof; the actual start and end are still stale.
  const wrongTime = { ...stale, hangoutLink: newRoom }
  state.instances.set('primary', [wrongTime, later])
  expect(await read()).toMatchObject(skipsStale)

  const current = {
    ...wrongTime,
    start: { dateTime: '2099-07-11T15:00:00Z' },
    end: { dateTime: '2099-07-11T16:00:00Z' },
    originalStartTime: { dateTime: '2099-07-09T11:00:00-04:00' },
  }
  state.instances.set('primary', [current, later])
  const joined = {
    ...skipsStale,
    identity: series!.identity,
    conferenceUrl: newRoom,
    htmlLink: current.htmlLink,
  }
  expect(await read()).toMatchObject(joined)
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    refreshPending: false,
    invitation: { conferenceUrl: newRoom, htmlLink: current.htmlLink },
  })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.calendarUpdateRequests.map(({ eventId }) => eventId)).toEqual([master.id])
  expect(current.attendees[0]?.responseStatus).toBe('declined')
  expect(state.sendAttempts).toBe(0)
})

it('orders embedded and separately mailed evidence for Join and occurrence responses', async () => {
  const { state, read, respond } = await rig()
  const embeddedRoom = 'https://meet.google.com/qrs-tuvw-xyz'
  const separateRoom = 'https://meet.google.com/xyz-abcd-efg'
  const stamp = '20240702T090000Z'
  const series = gmailMessage('update', 200, seriesWithException(movedRequest(stamp, embeddedRoom)))
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  const providerRow = {
    ...upcomingInstance('moved', '2099-07-11', separateRoom),
    originalStartTime: { dateTime: '2099-07-09T15:00:00Z' },
  }
  state.events.set('primary', [event({ id: 'series', series: true })])
  state.instances.set('primary', [providerRow, later])
  const join = () => read(thread, 'series')
  const occurrence = () => read(thread, 'occurrence')
  const separatelyMailed = (revision: string) =>
    gmailMessage('separate', 400, movedRequest(revision, separateRoom))
  const withheld = {
    identity: { messageId: 'separate' },
    canRespond: false,
    responseTargetKey: null,
    responseStatus: null,
    sentResponseStatus: null,
    recordedResponseStatus: null,
    conferenceUrl: null,
    htmlLink: null,
  }

  // Arrival and a matching row cannot override a newer embedded revision.
  state.messages = [series, separatelyMailed('20240701T090000Z')]
  expect(await join()).toMatchObject({ conferenceUrl: later.hangoutLink, canRespond: true })
  expect(await occurrence()).toMatchObject(withheld)
  await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  providerRow.hangoutLink = embeddedRoom
  expect(await join()).toMatchObject({ conferenceUrl: embeddedRoom })

  state.events.clear()
  state.instances.clear()
  const oldSent = gmailMessage(
    'sent-to-old-occurrence',
    500,
    movedRequest('20240704T090000Z', separateRoom)
      .replace('METHOD:REQUEST', 'METHOD:REPLY')
      .replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:'),
    { sent: true, parent: '<separate@example.net>' },
  )
  state.messages.push(oldSent)
  expect(await occurrence()).toMatchObject(withheld)
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.set('primary', [event({ id: 'series', series: true })])
  state.instances.set('primary', [providerRow, later])
  // Neither of two different versions with the same revision fields proves the slot.
  state.messages = [series, separatelyMailed(stamp)]
  expect(await join()).toMatchObject({ conferenceUrl: later.hangoutLink })
  expect(await occurrence()).toMatchObject(withheld)
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  state.messages = [
    series,
    gmailMessage('new-occurrence', 600, movedRequest('20240703T090000Z', separateRoom)),
    oldSent,
  ]
  expect(await join()).toMatchObject({ conferenceUrl: later.hangoutLink })
  providerRow.description = providerRow.hangoutLink = separateRoom
  expect(await join()).toMatchObject({
    conferenceUrl: separateRoom,
    htmlLink: providerRow.htmlLink,
  })
  expect(await occurrence()).toMatchObject({ canRespond: true, htmlLink: providerRow.htmlLink })
  state.events.clear()
  state.instances.clear()
  expect(await occurrence()).toMatchObject({
    identity: { messageId: 'new-occurrence' },
    canRespond: true,
    sentResponseStatus: null,
  })
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', outcome: 'sent' })
  expect(state.sentMime).toHaveLength(1)
  expect(state.sentMime[0]).toContain('In-Reply-To: <new-occurrence@example.net>')
  expect(state.calendarPatchAttempts).toBe(0)
})

it('rejects a Gmail reply when an embedded slot revision arrives before dispatch', async () => {
  const { state, read, respond } = await rig()
  state.messages = [
    gmailMessage(
      'old-occurrence',
      200,
      movedRequest('20240701T090000Z', 'https://meet.google.com/xyz-abcd-efg'),
    ),
  ]
  expect(await read()).toMatchObject({ scope: 'occurrence', canRespond: true })
  state.refreshOnQuery = true
  state.onRefresh = async () => {
    state.messages.push(
      gmailMessage(
        'new-series',
        400,
        seriesWithException(
          movedRequest('20240702T090000Z', 'https://meet.google.com/qrs-tuvw-xyz'),
        ),
      ),
    )
  }
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(await read(thread, 'occurrence')).toMatchObject({
    canRespond: false,
    responseTargetKey: null,
  })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('does not order conflicting MIME alternatives as independent embedded revisions', async () => {
  const { state, read, list } = await rig()
  const embeddedRoom = 'https://meet.google.com/qrs-tuvw-xyz'
  const separateRoom = 'https://meet.google.com/xyz-abcd-efg'
  const first = seriesWithException(movedRequest('20240701T090000Z', embeddedRoom))
  const last = seriesWithException(movedRequest('20240703T090000Z', embeddedRoom))
  const master = gmailMessage('update', 200, first)
  const redelivery = gmailMessage('reissued', 100, last)
  const intermediate = gmailMessage(
    'occurrence',
    300,
    movedRequest('20240702T090000Z', separateRoom),
  )
  const moved = {
    ...upcomingInstance('moved', '2099-07-11', embeddedRoom),
    originalStartTime: { dateTime: '2099-07-09T15:00:00Z' },
    description: embeddedRoom,
  }
  const next = upcomingInstance('next', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  state.events.set('primary', [event({ id: 'series', series: true })])
  state.instances.set('primary', [moved, next])
  state.messages = [master, redelivery, intermediate]
  const series = await read(thread, 'series')
  // Two real deliveries can order the exceptions even though the master is unchanged.
  expect(series).toMatchObject({ canRespond: true, conferenceUrl: embeddedRoom })

  master.payload.mimeType = 'multipart/alternative'
  master.payload.parts.push(redelivery.payload.parts[1]!)
  state.messages = [master, intermediate]
  const { invitations } = await list()
  expect(invitations).toHaveLength(2) // The alternatives did not make occurrence cards.
  const rsvp = {
    identity: series!.identity,
    responseTargetKey: series!.responseTargetKey,
    canRespond: true,
  }
  expect(invitations.find(({ scope }) => scope === 'series')).toMatchObject({
    ...rsvp,
    conferenceUrl: next.hangoutLink,
    htmlLink: next.htmlLink,
  })

  // Equivalent alternatives leave the independently mailed update in force.
  master.payload.parts[2] = gmailMessage(
    'equivalent',
    100,
    first.replaceAll('\r\n', '\n'),
  ).payload.parts[1]!
  moved.hangoutLink = moved.description = separateRoom
  const current = { ...rsvp, conferenceUrl: separateRoom, htmlLink: moved.htmlLink }
  expect(await read(thread, 'series')).toMatchObject(current)

  // Even if the alternatives still disagree, strictly newer independent proof
  // can reinstate the slot without granting either branch authority.
  master.payload.parts[2] = redelivery.payload.parts[1]!
  state.messages[1] = gmailMessage('newer', 400, movedRequest('20240704T090000Z', separateRoom))
  expect(await read(thread, 'series')).toMatchObject(current)
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('requires a verified live embedded revision to reinstate a slot covered by an embedded cancellation', async () => {
  const { state, read, list } = await rig()
  const room = 'https://meet.google.com/qrs-tuvw-xyz'
  const cancelled = invite('REQUEST', 'STATUS:CANCELLED', 3, '20240702T090000Z').replace(
    'END:VEVENT',
    'RECURRENCE-ID;RANGE=THISANDFUTURE:20990702T150000Z\r\nEND:VEVENT',
  )
  const reinstated = movedRequest('20240703T090000Z', room)
  const master = event({ id: 'series', series: true })
  const instance = {
    ...upcomingInstance('moved', '2099-07-11', room),
    originalStartTime: { dateTime: '2099-07-09T15:00:00Z' },
  }
  state.events.set('primary', [master])
  const unknown = upcomingInstance('unknown', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  state.instances.set('primary', [instance, unknown])
  const series = () => read(thread, 'series')
  const withCancellation = (live: string) =>
    gmailMessage('update', 200, seriesWithException(cancelled, live))
  const withheld = { canRespond: true, conferenceUrl: null, htmlLink: master.htmlLink }

  state.messages = [withCancellation(movedRequest('20240701T090000Z', room))]
  expect(await series()).toMatchObject(withheld)
  // An exception with no independent organizer evidence cannot restore Join.
  state.messages = [
    withCancellation(reinstated.replace(`ORGANIZER;CN=Host:mailto:${organizer}\r\n`, '')),
  ]
  expect(await series()).toMatchObject(withheld)
  state.messages = [withCancellation(reinstated)]
  expect(await series()).toMatchObject({
    canRespond: true,
    conferenceUrl: room,
    htmlLink: instance.htmlLink,
  })
  expect((await list()).invitations.map(({ scope }) => scope)).toEqual(['series'])
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['PUBLISH', 'EXPORT'] as const)(
  'keeps the just-ended occurrence joinable for a legacy %s series but not a REQUEST',
  async (method) => {
    const clock = vi.spyOn(Date, 'now')
    const { state, read, respond } = await rig()
    const allDay = method === 'EXPORT'
    const first = upcomingInstance('first', '2024-07-18', 'https://meet.google.com/xyz-abcd-efg')
    const next = upcomingInstance('next', '2024-07-25', 'https://meet.google.com/klm-nopq-rst')
    first.attendees[0]!.responseStatus = 'accepted'
    next.attendees[0]!.responseStatus = 'needsAction'
    // The occurrence moved a week. Its actual end, not its original slot,
    // controls Join; DATE ends are midnight in the server's calendar zone.
    state.calendarDateOffsets.set('primary', '+09:00')
    state.instances.set(
      'primary',
      allDay
        ? [
            {
              ...next,
              start: { date: '2024-07-25' },
              end: { date: '2024-07-26' },
              originalStartTime: { date: '2024-07-18' },
            },
            {
              ...first,
              start: { date: '2024-07-18' },
              end: { date: '2024-07-19' },
              originalStartTime: { date: '2024-07-11' },
            },
          ]
        : [next, { ...first, originalStartTime: { dateTime: '2024-07-11T15:00:00Z' } }],
    )
    const master = event({ id: 'series', series: true, allDay })
    master.attendees[0]!.responseStatus = 'needsAction'
    state.events.set('primary', [master])
    const source = (kind: string) =>
      invite(kind, allDay ? 'DTSTART;VALUE=DATE:20240718' : '')
        .replace('METHOD:EXPORT\r\n', '')
        .replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')
    state.messages = [gmailMessage('legacy', 200, source(method))]

    const halfPastEnd = Date.parse(allDay ? '2024-07-18T15:30:00Z' : '2024-07-18T16:30:00Z')
    clock.mockReturnValue(halfPastEnd)
    expect(await read()).toMatchObject({
      scope: 'series',
      kind: 'meeting',
      allDay,
      canRespond: false,
      conferenceUrl: first.hangoutLink,
      htmlLink: first.htmlLink,
    })
    clock.mockReturnValue(halfPastEnd + 30 * 60 * 1000)
    expect(await read()).toMatchObject({
      scope: 'series',
      kind: 'meeting',
      allDay,
      canRespond: false,
      conferenceUrl: next.hangoutLink,
      htmlLink: next.htmlLink,
    })

    clock.mockReturnValue(halfPastEnd)
    state.messages = [gmailMessage('request', 300, source('REQUEST'))]
    expect(await read()).toMatchObject({
      scope: 'series',
      kind: 'invitation',
      allDay,
      canRespond: true,
      conferenceUrl: next.hangoutLink,
      htmlLink: next.htmlLink,
    })
    state.instances.set(
      'primary',
      state.instances.get('primary')!.filter(({ id }) => id === first.id),
    )
    clock.mockReturnValue(halfPastEnd + 30 * 60 * 1000)
    state.messages = [gmailMessage('legacy', 200, source(method))]
    expect(await read()).toMatchObject({
      scope: 'series',
      kind: 'meeting',
      title: 'Design sync',
      start: master.start.date ?? master.start.dateTime,
      canRespond: false,
      conferenceUrl: null,
      conferenceLinkSource: null,
      htmlLink: null,
      htmlLinkSource: null,
    })
    state.messages = [gmailMessage('request', 300, source('REQUEST'))]
    expect(await read()).toMatchObject({
      scope: 'series',
      kind: 'invitation',
      canRespond: true,
      conferenceUrl: null,
      htmlLink: master.htmlLink,
    })
    expect(await respond('accepted')).toMatchObject({ channel: 'calendar', outcome: 'sent' })
    expect(state.calendarUpdateRequests).toMatchObject([{ eventId: master.id, status: 'accepted' }])
    expect(state.sendAttempts).toBe(0)
  },
)

it('skips a declined legacy series occurrence without losing it as Calendar evidence', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
  const { state, read, restart } = await rig()
  const master = {
    ...event({ id: 'series', series: true }),
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
  }
  const declined = upcomingInstance(
    'declined',
    '2024-07-18',
    'https://meet.google.com/abc-defg-hij',
  )
  const next = upcomingInstance('next', '2024-07-25', 'https://meet.google.com/xyz-abcd-efg')
  next.attendees[0]!.responseStatus = 'needsAction'
  const series = (method: string) =>
    invite(method).replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')
  state.messages = [gmailMessage('publication', 200, series('PUBLISH'))]
  state.events.set('primary', [master])
  state.instances.set('primary', [declined, next])
  expect(await read()).toMatchObject({
    scope: 'series',
    conferenceUrl: next.hangoutLink,
    htmlLink: next.htmlLink,
  })
  next.htmlLink = ''
  expect(await read()).toMatchObject({
    scope: 'series',
    conferenceUrl: next.hangoutLink,
    htmlLink: null,
  })
  state.instances.set('primary', [declined])
  expect(await read()).toMatchObject({ scope: 'series', conferenceUrl: null, htmlLink: null })

  // The expanded resource is still present even though the UID collection
  // and its master are now gone. Do not fall back to a Gmail response.
  state.events.clear()
  const occurrence = invite().replace('END:VEVENT', 'RECURRENCE-ID:20240718T150000Z\r\nEND:VEVENT')
  state.messages = [gmailMessage('update', 300, occurrence)]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({
    scope: 'occurrence',
    canRespond: false,
    responseTargetKey: null,
  })
  state.instances.clear()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it.each([
  'joined',
  'linkless before a failed continuation',
  'stale embedded revision before a failed continuation',
  'UID-less child before a failed continuation',
] as const)(
  'retains the original slot of a %s navigation-only Calendar instance',
  async (discovery) => {
    const { state, read, restart } = await rig()
    state.messages[0] = gmailMessage(
      'update',
      200,
      invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
    )
    const master = event({ id: 'series', series: true })
    const slotB = upcomingInstance('slot-b', '2099-07-10', 'https://meet.google.com/xyz-abcd-efg')
    slotB.originalStartTime = { dateTime: '2099-07-09T15:00:00Z' }
    state.events.set('primary', [master]) // Unexpanded UID results expose only the master.
    const row =
      discovery === 'UID-less child before a failed continuation'
        ? { ...slotB, iCalUID: undefined, organizer: undefined }
        : slotB
    state.instances.set('primary', [row])
    if (discovery !== 'joined') {
      if (discovery === 'linkless before a failed continuation') {
        slotB.hangoutLink = ''
        slotB.htmlLink = ''
      } else if (discovery === 'stale embedded revision before a failed continuation') {
        state.messages[0] = gmailMessage(
          'update',
          200,
          seriesWithException(
            movedRequest('20240702T090000Z', 'https://meet.google.com/qrs-tuvw-xyz'),
          ),
        )
      }
      // Page 2 is unavailable, but page 1 already established a resource.
      state.expandedPages = [{ kind: 'calendar#events', items: [row], nextPageToken: '1' }]
    }
    expect(await read()).toMatchObject({
      scope: 'series',
      canRespond: true,
      conferenceUrl: discovery === 'joined' ? slotB.hangoutLink : null,
      htmlLink: discovery === 'joined' ? slotB.htmlLink : master.htmlLink,
    })

    state.events.clear() // The master now returns 404. The instance still returns 200.
    const request = (slot: string) =>
      invite('REQUEST', 'DTSTART:20990710T150000Z\r\nDTEND:20990710T160000Z').replace(
        'END:VEVENT',
        `RECURRENCE-ID:${slot}\r\nEND:VEVENT`,
      )
    const reopened = restart()
    state.messages = [gmailMessage('other-slot', 300, request('20990710T150000Z'))]
    expect(await reopened.read()).toMatchObject({ scope: 'occurrence', canRespond: true })

    state.messages = [gmailMessage('slot-b-request', 400, request('20990709T150000Z'))]
    expect(await reopened.read()).toMatchObject({
      identity: { messageId: 'slot-b-request', recurrenceId: '2099-07-09T15:00:00.000Z' },
      canRespond: false,
      responseTargetKey: null,
      recordedResponseStatus: null,
      htmlLink: null,
    })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    state.instances.clear()
    expect(await reopened.read()).toMatchObject({ canRespond: true })
    expect(await reopened.respond('accepted')).toMatchObject({
      channel: 'gmail',
      outcome: 'sent',
      refreshPending: false,
    })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it('skips linkless and unsafe upcoming instances and leaves only Calendar navigation when exhausted', async () => {
  const { state, read } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
  )
  const master = event({ id: 'series', series: true })
  state.events.set('primary', [master])
  const linkless = {
    ...upcomingInstance('linkless', '2099-07-09', ''),
    htmlLink: '',
  }
  const unsafe = {
    ...upcomingInstance('unsafe', '2099-07-16', 'javascript:alert(1)'),
    htmlLink: 'https://not-calendar.example/calendar/event?eid=unsafe',
  }
  state.instances.set('primary', [linkless, unsafe])
  const noJoin = await read()
  expect(noJoin).toMatchObject({ conferenceUrl: null, htmlLink: master.htmlLink, canRespond: true })

  const linked = upcomingInstance('linked', '2099-07-23', 'https://meet.google.com/klm-nopq-rst')
  state.instances.set('primary', [linkless, unsafe, linked])
  expect(await read()).toMatchObject({
    conferenceUrl: linked.hangoutLink,
    htmlLink: linked.htmlLink,
    responseTargetKey: noJoin!.responseTargetKey,
    canRespond: true,
  })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('skips expanded rows without current mailbox membership or the master revision', async () => {
  const { state, read, respond } = await rig()
  const original = seriesWithException()
  state.messages = [
    gmailMessage('original', 100, original),
    gmailMessage(
      'update',
      200,
      original.replace('20240701T090000Z', '20240702T090000Z').replace('Upstairs', 'Downstairs'),
    ),
  ]
  const master = event({ id: 'series', series: true, location: 'Downstairs' })
  const room = 'https://meet.google.com/xyz-abcd-efg'
  const removed = upcomingInstance('removed', '2099-07-09', room)
  removed.attendees.shift()
  const unrelatedSelf = upcomingInstance('different-self', '2099-07-16', room)
  unrelatedSelf.attendees[0]!.self = false
  unrelatedSelf.attendees[1]!.self = true
  const omitted = { ...upcomingInstance('omitted', '2099-07-23', room), attendeesOmitted: true }
  const stale = { ...upcomingInstance('stale', '2099-07-30', room), sequence: 2 }
  const staleMaterial = {
    ...upcomingInstance('stale-location', '2099-08-06', room),
    location: 'Upstairs',
  }
  const next = upcomingInstance('next', '2099-08-13', 'https://meet.google.com/klm-nopq-rst')
  for (const row of [removed, unrelatedSelf, omitted, stale, next]) row.location = master.location
  state.events.set('primary', [master])
  state.instances.set('primary', [removed, unrelatedSelf, omitted, stale, staleMaterial, next])
  expect(await read()).toMatchObject({
    conferenceUrl: next.hangoutLink,
    htmlLink: next.htmlLink,
    canRespond: true,
  })
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', channel: 'calendar' })
  expect(state.calendarUpdateRequests).toMatchObject([{ eventId: master.id, status: 'accepted' }])
})

it('skips individually unverifiable series occurrences, but cannot use a malformed page for Join', async () => {
  const { state, read } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
  )
  const master = event({ id: 'series', series: true })
  const missingEnd = {
    ...upcomingInstance('no-end', '2099-07-09', 'https://meet.google.com/abc-defg-hij'),
    endTimeUnspecified: true,
  }
  const otherSeries = {
    ...upcomingInstance('other-series', '2099-07-16', 'https://meet.google.com/abc-defg-hij'),
    recurringEventId: 'different-master',
  }
  const next = upcomingInstance('next', '2099-07-23', 'https://meet.google.com/xyz-abcd-efg')
  state.events.set('primary', [master])
  state.instances.set('primary', [missingEnd, otherSeries, next])
  const joined = await read()
  expect(joined).toMatchObject({ conferenceUrl: next.hangoutLink, htmlLink: next.htmlLink })

  const noJoin = {
    conferenceUrl: null,
    htmlLink: master.htmlLink,
    canRespond: true,
    responseTargetKey: joined!.responseTargetKey,
  }
  state.instances.set('primary', [missingEnd, otherSeries])
  expect(await read()).toMatchObject(noJoin)

  const page = { kind: 'calendar#events' }
  for (const malformed of [
    { ...page, items: [next], nextPageToken: 'bad token' },
    { ...page, items: [next], nextPageToken: '1' },
    { kind: 'calendar#calendarList', items: [next] },
  ]) {
    state.expandedPages = [{ ...page, items: [missingEnd], nextPageToken: '1' }, malformed]
    expect(await read()).toMatchObject(noJoin)
  }
  state.expandedPages = [{ ...page, accessRole: 'freeBusyReader', items: [] }]
  expect(await read()).toMatchObject({
    conferenceUrl: null,
    htmlLink: null,
    canRespond: false,
    responseTargetKey: null,
  })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('follows cancellation and reinstatement at the original slot when joining a series', async () => {
  const { state, list, read } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
  )
  const master = event({ id: 'series', series: true })
  const next = upcomingInstance('next', '2099-07-10', 'https://meet.google.com/xyz-abcd-efg')
  // Google still shows the moved instance as confirmed, in a different room.
  const original = '2099-07-09T15:00:00Z'
  next.originalStartTime = { dateTime: original }
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  state.events.set('primary', [master])
  state.instances.set('primary', [later, next])
  const series = () => read(thread, 'series')
  const first = await series()
  expect(first).toMatchObject({ conferenceUrl: next.hangoutLink, canRespond: true })
  const cancel = (organizerEmail: string, stamp: string, range = '') =>
    invite('CANCEL', 'STATUS:CANCELLED', 3, stamp)
      .replace(organizer, organizerEmail)
      .replace('END:VEVENT', `RECURRENCE-ID${range}:20990709T150000Z\r\nEND:VEVENT`)

  state.messages.push(
    gmailMessage('another-organizer', 400, cancel(guest, '20240703T090000Z'), { from: guest }),
  )
  expect(await series()).toMatchObject({ conferenceUrl: next.hangoutLink })
  state.messages.pop()
  state.messages.push(gmailMessage('obsolete', 500, cancel(organizer, '20240630T090000Z')))
  expect(await series()).toMatchObject({ conferenceUrl: next.hangoutLink })
  state.messages.pop()

  state.messages.push(gmailMessage('cancel', 300, cancel(organizer, '20240702T090000Z')))
  expect((await list()).invitations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: 'occurrence', cancelled: true, canRespond: false }),
      expect.objectContaining({
        scope: 'series',
        cancelled: false,
        canRespond: true,
        responseTargetKey: first!.responseTargetKey,
        conferenceUrl: later.hangoutLink,
        htmlLink: later.htmlLink,
      }),
    ]),
  )

  const range = gmailMessage(
    'range',
    310,
    cancel(organizer, '20240702T090000Z', ';RANGE=THISANDFUTURE'),
  )
  const removeOther = gmailMessage(
    'remove-other',
    310,
    cancel(organizer, '20240702T090000Z', ';RANGE=THISANDFUTURE')
      .replace('STATUS:CANCELLED', `ATTENDEE:mailto:${guest}`)
      .replace(`ATTENDEE:mailto:${person}\r\n`, ''),
  )
  state.messages = [state.messages[0]!, removeOther]
  expect(await series()).toMatchObject({ conferenceUrl: next.hangoutLink })
  state.messages = [state.messages[0]!, range]
  expect(await series()).toMatchObject({
    conferenceUrl: null,
    htmlLink: master.htmlLink,
    canRespond: true,
  })
  const newRoom = 'https://meet.google.com/qrs-tuvw-xyz'
  const reinstate = invite(
    'REQUEST',
    'DTSTART:20990711T150000Z\r\nDTEND:20990711T160000Z',
    3,
    '20240703T090000Z',
  )
    .replace('LOCATION:Upstairs', 'LOCATION:Downstairs')
    .replace('https://meet.google.com/abc-defg-hij', newRoom)
    .replace('END:VEVENT', 'RECURRENCE-ID:20990709T150000Z\r\nEND:VEVENT')
  state.messages = [
    state.messages[0]!,
    gmailMessage('cancel', 300, cancel(organizer, '20240702T090000Z')),
  ]
  const reinstated = gmailMessage('reinstated', 250, reinstate)
  state.messages.push(reinstated)
  expect(await read(thread, 'occurrence')).toMatchObject({
    identity: { messageId: 'reinstated' },
    cancelled: false,
    canRespond: false,
    responseTargetKey: null,
    conferenceUrl: newRoom, // Current mail material, not the stale Calendar room.
    htmlLink: null,
  })
  expect(await series()).toMatchObject({
    conferenceUrl: later.hangoutLink,
    htmlLink: later.htmlLink,
    canRespond: true,
    responseTargetKey: first!.responseTargetKey,
  })
  const updated = {
    ...next,
    start: { dateTime: '2099-07-11T15:00:00Z' },
    end: { dateTime: '2099-07-11T16:00:00Z' },
    location: 'Downstairs',
    hangoutLink: newRoom,
  }
  state.instances.set('primary', [later, { ...updated, hangoutLink: next.hangoutLink }])
  expect(await series()).toMatchObject({ conferenceUrl: later.hangoutLink })
  state.instances.set('primary', [later, updated])
  expect(await series()).toMatchObject({
    conferenceUrl: newRoom,
    htmlLink: updated.htmlLink,
    canRespond: true,
    responseTargetKey: first!.responseTargetKey,
  })
  expect(await read(thread, 'occurrence')).toMatchObject({
    identity: { messageId: 'reinstated' },
    canRespond: true,
    conferenceUrl: newRoom,
    htmlLink: updated.htmlLink,
  })
  state.messages = [state.messages[0]!, range, reinstated]
  expect(await series()).toMatchObject({ conferenceUrl: newRoom, canRespond: true })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['DTEND:20990711T150000Z', 'DTEND:20990711T140000Z', 'DURATION:-PT1H'])(
  'keeps a malformed cancellation (%s) as read-only revision evidence',
  async (end) => {
    const { state, read, respond, list } = await rig()
    const slot = 'RECURRENCE-ID:20990709T150000Z'
    const canonicalSlot = '2099-07-09T15:00:00.000Z'
    const original = gmailMessage(
      'slot',
      200,
      movedRequest('20240701T090000Z', 'https://meet.google.com/xyz-abcd-efg'),
    )
    const fields = `STATUS:CANCELLED\r\n${slot}\r\nDTSTART:20990711T150000Z\r\n${end}`
    const stamp = '20240702T090000Z'
    const atSlot = () => read(thread, 'occurrence')

    state.messages = [original]
    expect(await atSlot()).toMatchObject({ canRespond: true, cancelled: false })
    for (const method of ['CANCEL', 'REQUEST']) {
      state.messages = [original, gmailMessage('malformed', 300, invite(method, fields, 4, stamp))]
      expect(await atSlot()).toMatchObject({
        identity: {
          messageId: 'malformed',
          uid,
          sequence: 4,
          dtstamp: '2024-07-02T09:00:00.000Z',
          recurrenceId: canonicalSlot,
          materialKey: expect.any(String),
        },
        organizer: { email: organizer },
        cancelled: false,
        canRespond: false,
        responseTargetKey: null,
        unavailableReason: expect.any(String),
      })
      await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }

    const seriesUpdate = gmailMessage(
      'series-update',
      300,
      seriesWithException(invite('REQUEST', fields, 4, stamp)),
    )
    state.messages = [original, seriesUpdate]
    expect(await atSlot()).toMatchObject({
      cancelled: false,
      canRespond: false,
      responseTargetKey: null,
      conferenceUrl: null,
      htmlLink: null,
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const master = event({ id: 'series', series: true })
    state.events.set('primary', [master])
    const stale = upcomingInstance('moved', '2099-07-11', 'https://meet.google.com/xyz-abcd-efg')
    stale.originalStartTime = { dateTime: canonicalSlot }
    state.instances.set('primary', [stale])
    state.messages = [seriesUpdate]
    const { invitations } = await list()
    expect(invitations).toMatchObject([{ scope: 'series', canRespond: true, conferenceUrl: null }])

    state.events.clear()
    state.instances.clear()
    state.messages = [
      original,
      gmailMessage('valid', 300, invite('CANCEL', `STATUS:CANCELLED\r\n${slot}`, 4, stamp)),
    ]
    expect(await atSlot()).toMatchObject({ cancelled: true, canRespond: false })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it.each([
  { method: 'CANCEL', range: '' },
  { method: 'CANCEL', range: 'RECURRENCE-ID;RANGE=THISANDFUTURE:20240704T150000Z' },
  { method: 'REQUEST', range: '' },
])(
  'withholds older occurrences covered by an unusable $method ($range)',
  async ({ method, range }) => {
    const { state, list, read, call } = await rig()
    const room = 'https://meet.google.com/abc-defg-hij'
    const request = (slot: string, sequence: number) =>
      invite('REQUEST', '', sequence).replace('END:VEVENT', `RECURRENCE-ID:${slot}\r\nEND:VEVENT`)
    const old = gmailMessage('old-slot', 200, request('20240711T150000Z', 3))
    const broken = gmailMessage(
      'broken',
      300,
      invite(
        method,
        [range, 'STATUS:CANCELLED', 'DTSTART:20240718T150000Z', 'DTEND:20240718T140000Z']
          .filter(Boolean)
          .join('\r\n'),
        4,
      ),
    )
    const withheld = {
      identity: expect.objectContaining({ messageId: old.id }),
      cancelled: false,
      canRespond: false,
      responseTargetKey: null,
      responseStatus: null,
      recordedResponseStatus: null,
      sentResponseStatus: null,
      conferenceUrl: null,
      htmlLink: null,
    }
    const copy = event({ id: 'instance', occurrence: true })
    for (const items of [[], [copy]]) {
      state.messages = [old]
      state.events.set('primary', items)
      const visible = await read()
      expect(visible).toMatchObject({ canRespond: true, conferenceUrl: room })
      state.messages.push(broken)
      // The broken revision retains its own card, but cannot confirm cancellation
      // or let the older card respond even to an already-recorded answer.
      expect((await list()).invitations).toEqual(
        expect.arrayContaining([
          expect.objectContaining(withheld),
          expect.objectContaining({
            identity: expect.objectContaining({ messageId: broken.id }),
            cancelled: false,
            canRespond: false,
          }),
        ]),
      )
      await expect(
        call('respondToMailInvitation', {
          ...thread,
          identity: visible!.identity,
          expectedBindingRevision: visible!.bindingRevision,
          expectedResponseTargetKey: visible!.responseTargetKey,
          answer: 'declined',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    state.messages.push(gmailMessage('new-slot', 400, request('20240711T150000Z', 5)))
    state.events.set('primary', [{ ...copy, sequence: 5 }])
    expect(
      (await list()).invitations.find(({ identity }) => identity.messageId === 'new-slot'),
    ).toMatchObject({
      canRespond: true,
      cancelled: false,
      conferenceUrl: room,
      responseTargetKey: expect.any(String),
    })

    state.events.clear()
    const unrelated = gmailMessage(
      'unrelated',
      200,
      request('20240711T150000Z', 3).replace(organizer, guest),
      { from: guest },
    )
    state.messages = [unrelated, broken]
    // A same-UID organizer collision is already disputed when it is in the
    // exact same scope. Across scopes, it must not poison this request.
    expect(
      (await list()).invitations.find(({ identity }) => identity.messageId === unrelated.id),
    ).toMatchObject({ canRespond: true })
    if (range) {
      const earlier = gmailMessage('before', 210, request('20240627T150000Z', 3))
      state.messages = [earlier, broken]
      expect(
        (await list()).invitations.find(({ identity }) => identity.messageId === earlier.id),
      ).toMatchObject({ canRespond: true, conferenceUrl: room })
    }
  },
)

it('covers a separately mailed slot with an authenticated cancelled REQUEST for the series', async () => {
  const { state, list, read, respond } = await rig()
  const occurrence = (sequence: number) =>
    invite('REQUEST', '', sequence).replace(
      'END:VEVENT',
      'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT',
    )
  const old = gmailMessage('old-slot', 200, occurrence(3))
  const series = (status: string, sequence = 4) =>
    invite('REQUEST', '', sequence).replace(
      'END:VEVENT',
      `RRULE:FREQ=WEEKLY\r\n${status}\r\nEND:VEVENT`,
    )
  const cancel = series('STATUS:CANCELLED')
  const readSlot = () => read(thread, 'occurrence')

  // Neither a contradictory envelope nor an authenticated other organizer,
  // older revision, or invalid STATUS can cancel this occurrence.
  for (const candidate of [
    gmailMessage('wrong-from', 350, cancel, { from: guest }),
    gmailMessage('wrong-organizer', 350, cancel.replace(organizer, guest), { from: guest }),
    gmailMessage('older', 350, series('STATUS:CANCELLED', 2)),
    gmailMessage('ambiguous', 350, series('STATUS:CANCELLED\r\nSTATUS:CONFIRMED')),
  ]) {
    state.messages = [old, candidate]
    expect(await readSlot()).toMatchObject({ cancelled: false, canRespond: true })
  }

  state.messages = [old, gmailMessage('cancelled-series', 300, cancel)]
  const covered = {
    identity: { messageId: 'old-slot', recurrenceId: '2024-07-11T15:00:00.000Z' },
    cancelled: true,
    canRespond: false,
    responseTargetKey: null,
    conferenceUrl: null,
    htmlLink: null,
    responseStatus: null,
    recordedResponseStatus: null,
    unavailableReason: expect.stringMatching(/cancel/i),
  }
  expect(await readSlot()).toMatchObject(covered)
  expect((await list()).invitations).toHaveLength(2)
  expect((await list()).invitations.find(({ scope }) => scope === 'series')).toMatchObject({
    cancelled: true,
    canRespond: false,
    responseTargetKey: null,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  const copy = event({ id: 'instance', occurrence: true })
  state.events.set('primary', [copy])
  expect(await readSlot()).toMatchObject(covered)
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)

  state.messages.push(gmailMessage('slot-reinstated', 400, occurrence(5)))
  state.events.set('primary', [{ ...copy, sequence: 5 }])
  expect(await readSlot()).toMatchObject({
    identity: { messageId: 'slot-reinstated' },
    cancelled: false,
    htmlLink: copy.htmlLink,
    canRespond: true,
  })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', outcome: 'sent' })
  expect(state.calendarUpdateRequests).toMatchObject([{ eventId: copy.id, status: 'accepted' }])
  expect(state.sendAttempts).toBe(0)
})

it('withholds navigation on a disputed occurrence and skips it for series Join until reinstated', async () => {
  const { state, read, list, respond } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
  )
  const master = event({ id: 'series', series: true })
  const first = upcomingInstance('first', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg')
  const next = upcomingInstance('next', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  state.events.set('primary', [master])
  state.instances.set('primary', [first, next])
  const series = () => read(thread, 'series')
  const original = await series()
  expect(original).toMatchObject({ canRespond: true, conferenceUrl: first.hangoutLink })

  const atSlot = (source: string) =>
    source.replace('END:VEVENT', 'RECURRENCE-ID:20990709T150000Z\r\nEND:VEVENT')
  const stamp = '20240702T090000Z'
  const request = (dtstamp: string) =>
    atSlot(invite('REQUEST', 'DTSTART:20990709T150000Z\r\nDTEND:20990709T160000Z', 3, dtstamp))
      .replace('https://meet.google.com/abc-defg-hij', first.hangoutLink)
      .replace('END:VEVENT', `URL:${first.htmlLink}\r\nEND:VEVENT`)
  const slotRequest = gmailMessage('slot-request', 300, request(stamp))
  state.messages.push(
    slotRequest,
    gmailMessage('slot-cancel', 400, atSlot(invite('CANCEL', 'STATUS:CANCELLED', 3, stamp))),
  )
  for (const arrival of ['300', '450']) {
    slotRequest.internalDate = arrival
    const occurrence = await read(thread, 'occurrence')
    expect(occurrence).toMatchObject({
      canRespond: false,
      cancelled: false,
      responseTargetKey: null,
      conferenceUrl: null,
      conferenceLinkSource: null,
      htmlLink: null,
      htmlLinkSource: null,
      unavailableReason: expect.any(String),
      organizer: { email: organizer },
    })
    if (arrival === '450')
      expect(occurrence).toMatchObject({
        title: 'Design sync',
        location: 'Upstairs',
        start: expect.any(String),
      })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await series()).toMatchObject({
      canRespond: true,
      responseTargetKey: original!.responseTargetKey,
      conferenceUrl: next.hangoutLink,
      htmlLink: next.htmlLink,
    })
  }

  state.messages.push(
    gmailMessage('slot-reinstated', 500, request('20240703T090000Z')),
    // A dispute at the same wall-clock slot on another UID does not suppress this series.
    gmailMessage('other-request', 600, request(stamp).replace('folded-uid', 'other-series')),
    gmailMessage(
      'other-cancel',
      700,
      atSlot(invite('CANCEL', 'STATUS:CANCELLED', 3, stamp)).replace('folded-uid', 'other-series'),
    ),
  )
  expect(await series()).toMatchObject({
    canRespond: true,
    responseTargetKey: original!.responseTargetKey,
    conferenceUrl: first.hangoutLink,
    htmlLink: first.htmlLink,
  })
  expect(
    (await list()).invitations.find(({ identity }) => identity.messageId === 'slot-reinstated'),
  ).toMatchObject({ canRespond: true, conferenceUrl: first.hangoutLink, htmlLink: first.htmlLink })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('honors Calendar picker settings without overriding legacy Mail visibility', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
  const cache = openGoogleCache(':memory:')
  try {
    const { state, call, list } = await rig(cache)
    const secondary = 'unselected@example.com'
    state.secondaryCalendars.push({ id: secondary, selected: false, accessRole: 'owner' })
    const copy = event({ id: 'meeting' })
    copy.attendees[0]!.responseStatus = 'needsAction'
    state.events.set(secondary, [copy])
    const picker = () => call('calendars', {})
    const agenda = () =>
      call('agenda', {
        from: '2024-07-18T00:00:00Z',
        to: '2024-07-19T00:00:00Z',
      })
    expect(await picker()).toContainEqual(
      expect.objectContaining({ id: secondary, enabled: false }),
    )
    expect(await agenda()).toEqual([])

    await call('setCalendar', { id: secondary, enabled: true })
    expect(await picker()).toContainEqual(expect.objectContaining({ id: secondary, enabled: true }))
    expect(await agenda()).toMatchObject([{ id: copy.id }])
    state.messages = [gmailMessage('publication', 200, invite('PUBLISH'))]
    expect((await list()).invitations).toEqual([])

    state.secondaryCalendars[0]!.selected = true
    await call('setCalendar', { id: secondary, enabled: false })
    expect(await picker()).toContainEqual(
      expect.objectContaining({ id: secondary, enabled: false }),
    )
    expect(await agenda()).toEqual([])
  } finally {
    cache.close()
  }
})

it('uses only verified upcoming links for a series export by the organizer', async () => {
  const { state, read, respond } = await rig()
  const source = invite()
    .replace('METHOD:REQUEST\r\n', '')
    .replace(organizer, person)
    .replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')
  state.messages = [gmailMessage('export', 200, source, { sent: true })]
  const master = {
    ...event({ id: 'series', series: true }),
    organizer: { email: person, self: true },
    attendees: [],
  }
  state.events.set('primary', [master])
  const next = upcomingInstance(
    'next',
    '2099-07-09',
    'https://teams.microsoft.com/l/meetup-join/19%3aX/0',
  )
  next.attendees = []
  state.instances.set('primary', [next])
  expect(await read()).toMatchObject({
    kind: 'meeting',
    canRespond: false,
    conferenceUrl: null,
    htmlLink: null,
  })
  state.instances.set('primary', [{ ...next, organizer: master.organizer }])
  expect(await read()).toMatchObject({
    kind: 'meeting',
    canRespond: false,
    conferenceUrl: next.hangoutLink,
    htmlLink: next.htmlLink,
  })
  state.instances.set('primary', [
    { ...next, organizer: master.organizer, hangoutLink: 'https://notzoom.us/j/123' },
  ])
  expect(await read()).toMatchObject({
    kind: 'meeting',
    canRespond: false,
    conferenceUrl: null,
    htmlLink: next.htmlLink,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['organizer', 'UID hint'])(
  'skips a sparse DATE tombstone for a series export identified by %s without granting RSVP',
  async (proof) => {
    const { state, list, read, respond } = await rig()
    let source = seriesWithException()
      .replace('METHOD:REQUEST\r\n', '')
      .replace(organizer, person)
      .replace(`ATTENDEE:mailto:${person}`, `ATTENDEE:mailto:${guest}`)
      .replace(
        'DTSTART:20240718T150000Z\r\nDTEND:20240718T160000Z',
        'DTSTART;VALUE=DATE:20240718\r\nDTEND;VALUE=DATE:20240719',
      )
    if (proof === 'UID hint') source = source.replace(`ORGANIZER;CN=Host:mailto:${person}\r\n`, '')
    state.messages = [gmailMessage('export', 200, source, { sent: true })]
    const owned = { organizer: { email: person, self: true }, attendees: [] }
    const master = { ...event({ id: 'series', series: true, allDay: true }), ...owned }
    const occurrence = (id: string, start: string, end: string, room: string) => ({
      ...upcomingInstance(id, start, room),
      ...owned,
      originalStartTime: { date: start },
      start: { date: start },
      end: { date: end },
    })
    const stale = occurrence(
      'old',
      '2099-07-09',
      '2099-07-10',
      'https://meet.google.com/xyz-abcd-efg',
    )
    const later = occurrence(
      'later',
      '2099-07-16',
      '2099-07-17',
      'https://meet.google.com/klm-nopq-rst',
    )
    const tombstone = {
      id: stale.id,
      status: 'cancelled',
      recurringEventId: master.id,
      originalStartTime: stale.originalStartTime,
    }
    state.events.set('primary', [master])
    state.instances.set('primary', [later, stale])
    state.primaryPages = [
      {
        kind: 'calendar#events',
        items: [
          { ...tombstone, id: 'other-parent-child', recurringEventId: 'other-parent' },
          { ...tombstone, id: 'other-organizer-child', organizer: { email: organizer } },
          master,
        ],
      },
    ]
    expect(await read()).toMatchObject({
      conferenceUrl: stale.hangoutLink,
      htmlLink: stale.htmlLink,
    })

    state.primaryPages = [{ kind: 'calendar#events', items: [tombstone, master] }]
    expect(await read()).toMatchObject({
      scope: 'series',
      kind: 'meeting',
      cancelled: false,
      canRespond: false,
      responseTargetKey: null,
      conferenceUrl: later.hangoutLink,
      htmlLink: later.htmlLink,
    })
    await expect(respond('accepted')).rejects.toMatchObject({
      code: proof === 'UID hint' ? 'CONFLICT' : 'FORBIDDEN',
    })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    // A series without a usable Calendar organizer is not a verified parent.
    master.organizer = { email: '', self: false }
    expect((await list()).invitations).toEqual([])
  },
)

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
      invite()
        .replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT')
        .replace('https://meet.google.com/abc-defg-hij', 'https://meet.google.com/xyz-abcd-efg'),
    ),
  )
  const series = event({ id: 'series', series: true })
  const instance = {
    ...event({ id: 'instance', occurrence: true }),
    hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
  }
  const next = upcomingInstance('next', '2099-07-09', 'https://meet.google.com/klm-nopq-rst')
  state.events.set('primary', [series])
  state.instances.set('primary', [instance, next])
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
        conferenceUrl: instance.hangoutLink,
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
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it.each([
  { scope: 'occurrence', row: 'root', recurrence: 'RECURRENCE-ID:20240711T150000Z' },
  { scope: 'occurrence', row: 'cancelled root', recurrence: 'RECURRENCE-ID:20240711T150000Z' },
  { scope: 'series', row: 'exception', recurrence: 'RRULE:FREQ=WEEKLY' },
  { scope: 'single', row: 'exception', recurrence: '' },
] as const)(
  'retains the same-UID $row as possible Calendar evidence for a $scope invitation',
  async ({ scope, row, recurrence }) => {
    const { state, read, restart } = await rig()
    const request = invite().replace(
      'END:VEVENT',
      recurrence ? `${recurrence}\r\nEND:VEVENT` : 'END:VEVENT',
    )
    state.messages = [gmailMessage('update', 200, request)]
    const copy = event({ occurrence: row === 'exception' })
    if (row === 'cancelled root') copy.status = 'cancelled'
    state.events.set('primary', [copy])
    expect(await read()).toMatchObject({ scope, canRespond: false })
    if (row === 'cancelled root') expect(await read()).toMatchObject({ cancelled: true })

    // events.list is complete but now omits the same still-readable resource.
    state.primaryPages = [{ kind: 'calendar#events' }]
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({ scope, canRespond: false })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    state.events.clear()
    expect(await reopened.read()).toMatchObject({ scope, canRespond: true })
    expect(await reopened.respond('accepted')).toMatchObject({
      channel: 'gmail',
      outcome: 'sent',
      refreshPending: false,
    })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it('follows documented empty Calendar pages but never treats malformed or partial collections as absence', async () => {
  const { state, read, respond } = await rig()
  const empty = { kind: 'calendar#events' }
  const copy = event()
  state.events.set('primary', [copy])
  state.primaryPages = [
    { ...empty, nextPageToken: '1' },
    { ...empty, items: [copy] },
  ]
  expect(await read()).toMatchObject({ responseStatus: 'declined', canRespond: true })
  state.events.clear()
  state.primaryPages = [{ ...empty, nextPageToken: '1' }, empty]
  expect(await read()).toMatchObject({ responseStatus: 'needsAction', canRespond: true })
  for (const second of [
    { kind: 'calendar#calendarList' },
    { items: [] },
    { ...empty, items: null },
    { ...empty, items: [{}] },
    { ...empty, accessRole: 'unrecognized' },
    { ...empty, accessRole: null },
    { ...empty, nextPageToken: '1' },
    { ...empty, nextPageToken: 1 },
  ]) {
    state.primaryPages = [{ ...empty, nextPageToken: '1' }, second]
    expect(await read()).toMatchObject({ responseStatus: null, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each([
  ['writable', 'transport failure'],
  ['RSVP-ineligible', 'transport failure'],
  ['writable', 'read-access downgrade'],
] as const)(
  'retains a %s Calendar copy from a valid first page after a later %s',
  async (eligibility, failure) => {
    const { state, read, restart } = await rig()
    const page = { kind: 'calendar#events', accessRole: 'owner' }
    const copy = event()
    if (eligibility === 'RSVP-ineligible') copy.attendees = []
    state.events.set('primary', [copy])
    state.primaryPages = [{ ...page, items: [copy], nextPageToken: '1' }]
    if (failure === 'read-access downgrade')
      state.primaryPages.push({ ...page, accessRole: 'freeBusyReader', items: [] })
    else state.primaryPageErrors.set(1, 503)
    expect(await read()).toMatchObject({ responseStatus: null, canRespond: false })

    // A later query omits the row, but its exact resource is still there.
    state.primaryPages = [page]
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({ responseStatus: null, canRespond: false })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    // Only complete absence and an actual exact-resource 404 allow Gmail.
    state.events.clear()
    expect(await reopened.read()).toMatchObject({ responseStatus: 'needsAction', canRespond: true })
    expect(await reopened.respond('accepted')).toMatchObject({ channel: 'gmail', outcome: 'sent' })
    expect(state.calendarPatchAttempts).toBe(0)
    expect(state.sendAttempts).toBe(1)
  },
)

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
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
  const { state, read, respond, list } = await rig()
  const published = invite('PUBLISH').replace('METHOD:PUBLISH', 'METHOD:PUB\r\n LISH')
  state.messages = [gmailMessage('published', 200, published, { method: 'PUBLISH' })]
  const copy = event({ description: 'Meeting: https://meet.google.com/abc-defg-hij' })
  copy.attendees[0]!.responseStatus = 'needsAction'
  state.events.set('primary', [copy])
  expect(await read()).toMatchObject({
    kind: 'meeting',
    scope: 'single',
    canRespond: false,
    recordedResponseStatus: null,
    sentResponseStatus: null,
    conferenceLinkSource: 'provider',
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.events.set('primary', [
    { ...copy, location: 'Wrong place', description: 'https://notzoom.us/j/12345' },
  ])
  expect((await list()).invitations).toEqual([])
  const sent = invite()
    .replace(organizer, person)
    .replace('DESCRIPTION:https://meet.google.com/abc-defg-hij', 'DESCRIPTION:Discuss work')
  const ownMeeting = { ...event(), organizer: { email: person, self: true }, attendees: [] }
  state.events.set('primary', [ownMeeting])
  state.messages = [
    gmailMessage('organized', 300, sent.replace('METHOD:REQUEST', 'METHOD:PUBLISH'), {
      sent: true,
    }),
  ]
  expect(await read()).toMatchObject({
    kind: 'meeting',
    canRespond: false,
    htmlLink: ownMeeting.htmlLink,
  })

  state.messages = [gmailMessage('organized', 300, sent, { sent: true })]
  state.events.set('primary', [
    {
      ...ownMeeting,
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

it('skips disabled collections for publications but not for REQUEST authority', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
  const { state, read, respond } = await rig()
  const disabledId = 'disabled@example.com'
  const enabledId = 'enabled@example.com'
  state.secondaryCalendars = [
    { id: disabledId, selected: true },
    { id: enabledId, selected: true },
  ]
  state.calendarOverrides = { [disabledId]: false }
  state.eventCollectionErrors.set(disabledId, 503)
  const enabledCopy = event({ id: 'enabled' })
  enabledCopy.attendees[0]!.responseStatus = 'needsAction'
  state.events.set(enabledId, [enabledCopy])
  state.messages = [gmailMessage('publication', 200, invite('PUBLISH'))]
  expect(await read()).toMatchObject({
    kind: 'meeting',
    htmlLink: enabledCopy.htmlLink,
    canRespond: false,
  })
  state.messages = [gmailMessage('update', 300, invite())]
  expect(await read()).toMatchObject({ kind: 'invitation', htmlLink: null, canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['PUBLISH', 'EXPORT'] as const)(
  'uses only visible, vault-enabled calendars for %s links, without changing REQUEST authority',
  async (method) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
    const { state, read, respond, list } = await rig()
    const secondary = { id: 'secondary@example.com', selected: true, hidden: false }
    state.primaryCalendarId = 'declared-primary@example.com'
    state.secondaryCalendars.push(secondary)
    state.calendarOverrides = {
      primary: true,
      [state.primaryCalendarId]: false,
      [secondary.id]: false,
    }
    const legacy = invite(method).replace('METHOD:EXPORT\r\n', '')
    state.messages = [gmailMessage('update', 200, legacy)]
    const room = 'https://meet.google.com/abc-defg-hij'
    const primaryCopy = { ...event(), hangoutLink: room }
    primaryCopy.attendees[0]!.responseStatus = 'needsAction'
    const secondaryCopy = {
      ...event({ id: 'secondary' }),
      htmlLink: 'https://calendar.google.com/calendar/event?eid=secondary',
      hangoutLink: room,
    }
    secondaryCopy.attendees[0]!.responseStatus = 'needsAction'
    secondaryCopy.attendees[1]!.responseStatus = 'declined' // Another guest is not self.
    state.events.set('primary', [primaryCopy])
    state.events.set(secondary.id, [secondaryCopy])
    expect((await list()).invitations).toEqual([])
    state.calendarOverrides = {
      primary: false,
      [state.primaryCalendarId]: true,
      [secondary.id]: false,
    }
    expect(await read()).toMatchObject({ conferenceUrl: room, htmlLink: primaryCopy.htmlLink })
    state.calendarOverrides[state.primaryCalendarId] = false
    state.calendarOverrides[secondary.id] = true
    expect(await read()).toMatchObject({
      kind: 'meeting',
      conferenceUrl: room,
      htmlLink: secondaryCopy.htmlLink,
      canRespond: false,
    })
    secondary.selected = false
    expect((await list()).invitations).toEqual([])

    secondary.selected = true
    secondary.hidden = true
    expect((await list()).invitations).toEqual([])
    secondary.hidden = false
    const workingLocation = { ...secondaryCopy, eventType: 'workingLocation' }
    state.events.set(secondary.id, [workingLocation])
    expect((await list()).invitations).toEqual([])
    state.events.delete('primary')
    state.events.set(secondary.id, [secondaryCopy])
    secondaryCopy.attendees[0]!.responseStatus = 'declined'
    expect((await list()).invitations).toEqual([])
    secondary.hidden = true
    state.messages = [gmailMessage('update', 300, invite())]
    expect(await read()).toMatchObject({
      kind: 'invitation',
      canRespond: true,
      recordedResponseStatus: 'declined',
      conferenceUrl: room,
      htmlLink: secondaryCopy.htmlLink,
    })
    expect(await respond('accepted')).toMatchObject({
      channel: 'calendar',
      outcome: 'sent',
      refreshPending: false,
    })
    expect(state.calendarUpdateRequests).toMatchObject([
      { calendar: secondary.id, eventId: secondaryCopy.id, status: 'accepted' },
    ])
    expect(state.sendAttempts).toBe(0)
  },
)

it.each(['PUBLISH', 'EXPORT'] as const)(
  'keeps %s meeting facts but expires standalone navigation at the legacy cutoff',
  async (method) => {
    const clock = vi.spyOn(Date, 'now')
    const { state, read, respond } = await rig()
    let source = invite(method)
    if (method === 'EXPORT') source = source.replace('METHOD:EXPORT\r\n', '')
    state.messages = [gmailMessage('meeting', 200, source)]
    const copy = { ...event(), hangoutLink: 'https://meet.google.com/abc-defg-hij' }
    copy.attendees[0]!.responseStatus = 'needsAction'
    state.events.set('primary', [copy])

    for (const time of ['14:00:00', '15:30:00', '16:59:59']) {
      clock.mockReturnValue(Date.parse(`2024-07-18T${time}Z`))
      expect(await read()).toMatchObject({
        conferenceUrl: copy.hangoutLink,
        htmlLink: copy.htmlLink,
      })
    }
    clock.mockReturnValue(Date.parse('2024-07-18T17:00:00Z'))
    expect(await read()).toMatchObject({
      kind: 'meeting',
      title: 'Design sync',
      start,
      end,
      location: 'Upstairs',
      conferenceUrl: null,
      conferenceLinkSource: null,
      htmlLink: null,
      htmlLinkSource: null,
      canRespond: false,
    })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    state.messages = [gmailMessage('late-request', 300, invite())]
    expect(await read()).toMatchObject({ kind: 'invitation', canRespond: true })
    expect(await respond('accepted')).toMatchObject({
      channel: 'calendar',
      outcome: 'sent',
      refreshPending: false,
    })
  },
)

it('uses the Calendar end cutoff for an all-day publication with an implicit end', async () => {
  const clock = vi.spyOn(Date, 'now')
  const { state, read, list } = await rig()
  state.messages = [
    gmailMessage('publication', 200, invite('PUBLISH', 'DTSTART;VALUE=DATE:20240718')),
  ]
  const copy = event({ allDay: true })
  copy.attendees[0]!.responseStatus = 'needsAction'
  state.events.set('primary', [copy])
  clock.mockReturnValue(Date.parse('2024-07-18T23:30:00Z'))
  expect(await read()).toMatchObject({ allDay: true, end: '2024-07-19', htmlLink: copy.htmlLink })
  state.navigationRefusal = { status: 429 }
  await expect(list()).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  state.navigationRefusal = null
  clock.mockReturnValue(Date.parse('2024-07-19T01:00:00Z'))
  expect(await read()).toMatchObject({
    allDay: true,
    end: '2024-07-19',
    htmlLink: null,
    conferenceUrl: null,
    canRespond: false,
  })
})

it.each(['PUBLISH', 'EXPORT'] as const)(
  'expires %s occurrence links from the moved end, not the original slot',
  async (method) => {
    const clock = vi.spyOn(Date, 'now')
    const { state, read, respond, list } = await rig()
    const conferenceUrl = 'https://meet.google.com/abc-defg-hij'
    const htmlLink = 'https://calendar.google.com/calendar/event?eid=moved'
    const moved = (kind: string) =>
      invite(kind).replace(
        'END:VEVENT',
        `RECURRENCE-ID:20240711T150000Z\r\nURL:${htmlLink}\r\nEND:VEVENT`,
      )
    state.messages = [gmailMessage('update', 200, moved(method).replace('METHOD:EXPORT\r\n', ''))]
    const copy = { ...event({ id: 'moved', occurrence: true }), htmlLink: '' }
    state.events.set('primary', [copy])
    clock.mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
    expect((await list()).invitations).toEqual([]) // Self declined; no mail URL fallback.
    copy.attendees[0]!.responseStatus = 'needsAction'

    // The original slot was a week earlier. The actual occurrence is joinable
    // before it starts, while ongoing, and in the grace period. Both links come from mail.
    for (const time of ['14:00:00', '15:30:00', '16:59:59']) {
      clock.mockReturnValue(Date.parse(`2024-07-18T${time}Z`))
      expect(await read()).toMatchObject({ scope: 'occurrence', conferenceUrl, htmlLink })
    }
    for (const time of ['17:00:00', '18:00:00']) {
      clock.mockReturnValue(Date.parse(`2024-07-18T${time}Z`))
      expect(await read()).toMatchObject({
        kind: 'meeting',
        scope: 'occurrence',
        start,
        end,
        location: 'Upstairs',
        conferenceUrl: null,
        conferenceLinkSource: null,
        htmlLink: null,
        htmlLinkSource: null,
        canRespond: false,
      })
    }

    state.messages = [gmailMessage('update', 300, moved('REQUEST'))]
    expect(await read()).toMatchObject({
      kind: 'invitation',
      scope: 'occurrence',
      canRespond: true,
    })
    expect(await respond('accepted')).toMatchObject({ channel: 'calendar', outcome: 'sent' })
    expect(state.calendarUpdateRequests).toMatchObject([{ eventId: 'moved', status: 'accepted' }])
    expect(state.sendAttempts).toBe(0)
  },
)

it('uses the calendar-zone end of the exact DATE occurrence, not a future neighbor', async () => {
  const clock = vi.spyOn(Date, 'now')
  const { state, read } = await rig()
  state.calendarDateOffsets.set('primary', '+09:00')
  state.expandedEmptyFirstPage = true
  state.messages = [
    gmailMessage(
      'publication',
      200,
      invite('PUBLISH', 'DTSTART;VALUE=DATE:20240718\r\nRECURRENCE-ID;VALUE=DATE:20240711'),
    ),
  ]
  const copy = event({ id: 'moved', occurrence: true, allDay: true })
  copy.attendees[0]!.responseStatus = 'needsAction'
  const neighbor = {
    ...copy,
    id: 'neighbor',
    start: { date: '2024-07-20' },
    end: { date: '2024-07-21' },
    originalStartTime: { date: '2024-07-25' },
    hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=neighbor',
  }
  state.events.set('primary', [event({ id: 'series', series: true, allDay: true }), copy])
  state.instances.set('primary', [copy, neighbor])

  // The implicit end is midnight July 19 in the calendar's zone (15:00 UTC).
  // Calendar can return an empty page before the qualifying exact occurrence.
  clock.mockReturnValue(Date.parse('2024-07-18T15:59:59Z'))
  expect(await read()).toMatchObject({
    scope: 'occurrence',
    allDay: true,
    start: '2024-07-18',
    end: '2024-07-19',
    htmlLink: copy.htmlLink,
    conferenceUrl: 'https://meet.google.com/abc-defg-hij',
  })
  clock.mockReturnValue(Date.parse('2024-07-18T16:00:00Z'))
  expect(await read()).toMatchObject({
    scope: 'occurrence',
    allDay: true,
    start: '2024-07-18',
    end: '2024-07-19',
    conferenceUrl: null,
    htmlLink: null,
    canRespond: false,
  })
  // At the same instant a different calendar zone still has time left.
  state.calendarDateOffsets.set('primary', '-04:00')
  expect(await read()).toMatchObject({ htmlLink: copy.htmlLink })
})

it.each(['PUBLISH', 'EXPORT'] as const)(
  'keeps the REQUEST actionable when a later %s has the same UID and scope',
  async (method) => {
    const { state, list, read, respond } = await rig()
    let later = invite(method, '', 4, '20240702T090000Z')
    if (method === 'EXPORT') later = later.replace('METHOD:EXPORT\r\n', '')
    state.messages.push(gmailMessage('later', 300, later))
    expect(await list()).toMatchObject({
      invitations: [{ identity, kind: 'invitation', canRespond: true }],
    })
    await read()
    expect(await respond('accepted')).toMatchObject({
      channel: 'gmail',
      refreshPending: false,
      invitation: { identity, sentResponseStatus: 'accepted' },
    })
    state.messages.push(gmailMessage('cancel', 400, invite('CANCEL', 'STATUS:CANCELLED', 4)))
    expect(await read()).toMatchObject({ cancelled: true, canRespond: false })
    expect(state.sendAttempts).toBe(1)
  },
)

it.each(['PUBLISH', 'EXPORT'] as const)(
  'uses one Gmail parent for a REQUEST with a %s sidecar, but rejects competing ownership or REQUESTs',
  async (method) => {
    const { state, read, respond } = await rig()
    const mixed = state.messages[0]!
    let source = invite(method, '', 4).replace('SUMMARY:Design sync', 'SUMMARY:Public meeting')
    if (method === 'EXPORT') source = source.replace('METHOD:EXPORT\r\n', '')
    const sidecar = gmailMessage('sidecar', 300, source)
    mixed.payload.parts.push(sidecar.payload.parts[1]!)
    expect(await read()).toMatchObject({ identity, canRespond: true })
    expect(await respond('accepted')).toMatchObject({
      channel: 'gmail',
      refreshPending: false,
      invitation: { sentResponseStatus: 'accepted' },
    })

    sidecar.payload.headers.find(({ name }) => name === 'Message-ID')!.value =
      '<update@example.net>'
    state.messages.push(sidecar)
    expect(await read()).toMatchObject({ canRespond: false, sentResponseStatus: null })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.messages.pop()

    mixed.payload.parts.push(
      gmailMessage('competing', 300, invite().replace('LOCATION:Upstairs', 'LOCATION:Downstairs'))
        .payload.parts[1]!,
    )
    expect(await read()).toMatchObject({ canRespond: false, sentResponseStatus: null })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it('allows a methodless export to open only a verified meeting, never to RSVP', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
  const { state, read, respond, list } = await rig()
  const source = invite()
    .replace('METHOD:REQUEST\r\n', '')
    .replace('DTSTAMP:20240701T090000Z\r\n', '')
  state.messages = [gmailMessage('export', 200, source)]
  expect((await list()).invitations).toEqual([])

  const legacy = 'https://www.google.com/calendar/event?eid=example'
  const copy = {
    ...event({ description: 'Join https://meet.google.com/abc-defg-hij' }),
    htmlLink: legacy,
  }
  copy.attendees[0]!.responseStatus = 'needsAction'
  state.events.set('primary', [copy])
  expect(await read()).toMatchObject({
    kind: 'meeting',
    canRespond: false,
    recordedResponseStatus: null,
    sentResponseStatus: null,
    conferenceUrl: 'https://meet.google.com/abc-defg-hij',
    htmlLink: legacy,
    htmlLinkSource: 'calendar',
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  for (const sourceWithMethod of [
    source.replace('BEGIN:VEVENT', 'METHOD:X-UNKNOWN\r\nBEGIN:VEVENT'),
    source.replace('BEGIN:VEVENT', 'METHOD:\r\nBEGIN:VEVENT'),
  ]) {
    state.messages = [gmailMessage('export', 200, sourceWithMethod)]
    expect((await list()).invitations).not.toContainEqual(
      expect.objectContaining({ kind: 'meeting' }),
    )
  }
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['EXPORT', 'PUBLISH'] as const)(
  'uses an organizer-free %s as a read-only Calendar hint, not an RSVP revision',
  async (method) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
    const { state, list, read, respond } = await rig()
    const source = invite(method)
      .replace('METHOD:EXPORT\r\n', '')
      .replace(`ORGANIZER;CN=Host:mailto:${organizer}\r\n`, '')
      .replace(`ATTENDEE:mailto:${person}\r\n`, '')
      .replace('SUMMARY:Design sync\r\n', '')
      .replace('LOCATION:Upstairs\r\n', '')
    state.messages = [gmailMessage('legacy', 200, source, { from: guest })]
    // Both the Calendar and the self guest would be writable for a genuine REQUEST.
    // Use Calendar's actual details, not the room or stamp carried by the export.
    const copy = {
      ...event({ location: 'Conference room' }),
      sequence: 5,
      hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
    }
    copy.attendees[0]!.responseStatus = 'accepted'
    state.events.set('primary', [copy])
    state.hiddenInvitationIds.add(copy.id)
    expect((await list()).invitations).toEqual([])
    state.hiddenInvitationIds.clear()
    expect(await read()).toMatchObject({
      kind: 'meeting',
      identity: { messageId: 'legacy', uid, sequence: 3 },
      title: copy.summary,
      start,
      end,
      organizer: { email: organizer },
      location: copy.location,
      conferenceUrl: copy.hangoutLink,
      htmlLink: copy.htmlLink,
      canRespond: false,
      responseTargetKey: null,
      responseStatus: null,
      recordedResponseStatus: null,
      sentResponseStatus: null,
    })
    // In particular, this already-recorded answer is not an RSVP no-op.
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it.each(
  (['EXPORT', 'PUBLISH'] as const).flatMap((method) =>
    (['reader', 'writer'] as const).flatMap((role) =>
      [false, true].map((withOrganizer) => ({ method, role, withOrganizer })),
    ),
  ),
)(
  'reads a $method with source organizer=$withOrganizer on an explicitly enabled $role calendar',
  async ({ method, role, withOrganizer }) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
    const { state, call, list, read, respond } = await rig()
    const shared = 'team@example.net'
    state.secondaryCalendars = [{ id: shared, selected: true, accessRole: role }]
    let source = invite(method).replace('METHOD:EXPORT\r\n', '')
    if (!withOrganizer)
      source = source
        .replace(`ORGANIZER;CN=Host:mailto:${organizer}\r\n`, '')
        .replace('SUMMARY:Design sync', 'SUMMARY:Title from email')
        .replace('abc-defg-hij', 'xyz-abcd-efg')
    state.messages = [gmailMessage('legacy', 200, source, { from: guest, attached: true })]
    state.attachments.set('legacy', source)
    const copy = {
      ...event({ id: 'shared', location: 'Upstairs' }),
      attendees: [event().attendees[1]!], // Neither organizer nor guest is the connected mailbox.
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=shared',
    }
    state.events.set(shared, [copy])
    const enable = (enabled: boolean) => call('setCalendar', { id: shared, enabled })
    expect((await list()).invitations).toEqual([])
    await enable(true)
    const meeting = await read()
    expect(meeting).toMatchObject({
      kind: 'meeting',
      title: copy.summary,
      organizer: { email: organizer },
      start,
      end,
      location: copy.location,
      conferenceUrl: copy.hangoutLink,
      htmlLink: copy.htmlLink,
      htmlLinkSource: 'calendar',
      canRespond: false,
      responseTargetKey: null,
      responseStatus: null,
      recordedResponseStatus: null,
      sentResponseStatus: null,
    })
    await call('validateMailInvitationBinding', {
      expectedAccountSub: thread.expectedAccountSub,
      expectedBindingRevision: meeting!.bindingRevision,
    })
    const refusal = { code: withOrganizer ? 'FORBIDDEN' : 'CONFLICT' }
    await expect(respond('accepted')).rejects.toMatchObject(refusal)
    if (role === 'writer') {
      // Even an independently writable guest copy holding this answer cannot
      // turn the export into an RSVP no-op or a response target.
      copy.attendees = [{ ...event().attendees[0]!, responseStatus: 'accepted' }]
      expect(await read()).toMatchObject({ canRespond: false, responseTargetKey: null })
      await expect(respond('accepted')).rejects.toMatchObject(refusal)
    }
    await enable(false)
    expect((await list()).invitations).toEqual([])
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it('withholds a shared publication without an exact readable copy and never substitutes its email links', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
  const { state, call, list, read } = await rig()
  const shared = 'team@example.net'
  state.secondaryCalendars = [{ id: shared, selected: true, accessRole: 'reader' }]
  await call('setCalendar', { id: shared, enabled: true })
  state.messages = [
    gmailMessage(
      'legacy',
      200,
      invite('PUBLISH').replace(
        'END:VEVENT',
        'URL:https://calendar.google.com/calendar/event?eid=email\r\nEND:VEVENT',
      ),
    ),
  ]
  const copy = { ...event({ id: 'shared' }), attendees: [], htmlLink: '' }
  expect((await list()).invitations).toEqual([])
  for (const lookalike of [
    { ...copy, iCalUID: 'unrelated-event' },
    { ...copy, organizer: { email: guest, self: false } },
    { ...copy, sequence: 2 },
    { ...copy, attendees: [event().attendees[0]!] }, // Actual self declined.
  ]) {
    state.events.set(shared, [lookalike])
    expect((await list()).invitations).toEqual([])
  }
  state.events.set(shared, [copy])
  state.freeBusyEventCollections.add(shared)
  expect((await list()).invitations).toEqual([])
  state.freeBusyEventCollections.clear()
  // A linkless copy can supply facts, but an email link must never stand in
  // for a Calendar event URL or verified conference room on a shared calendar.
  expect(await read()).toMatchObject({
    kind: 'meeting',
    title: copy.summary,
    conferenceUrl: null,
    htmlLink: null,
  })
})

it.each([false, true])(
  'withholds the original slot of shared Calendar tombstones (source organizer=%s)',
  async (withOrganizer) => {
    const { state, call, read } = await rig()
    const shared = 'team@example.net'
    state.secondaryCalendars = [{ id: shared, selected: true, accessRole: 'reader' }]
    await call('setCalendar', { id: shared, enabled: true })
    const exportSource = (sequence: number) => {
      const source = seriesWithException()
        .replace('METHOD:REQUEST\r\n', '')
        .replace('SEQUENCE:3', `SEQUENCE:${sequence}`)
      return withOrganizer
        ? source
        : source.replace(`ORGANIZER;CN=Host:mailto:${organizer}\r\n`, '')
    }
    state.messages = [gmailMessage('legacy', 200, exportSource(3))]
    const master = { ...event({ id: 'series', series: true }), attendees: [] }
    const stale = {
      ...upcomingInstance('moved', '2099-07-11', 'https://meet.google.com/xyz-abcd-efg'),
      attendees: [],
      originalStartTime: { dateTime: '2099-07-09T15:00:00Z' },
    }
    const later = {
      ...upcomingInstance('next', '2099-07-16', 'https://meet.google.com/klm-nopq-rst'),
      attendees: [],
    }
    const sparse = {
      id: stale.id,
      status: 'cancelled',
      recurringEventId: master.id,
      originalStartTime: { dateTime: '2099-07-09T11:00:00-04:00', timeZone: 'America/New_York' },
    }
    state.events.set(shared, [master])
    state.instances.set(shared, [stale, later])
    state.secondaryUidItems.set(shared, [master, { ...sparse, recurringEventId: 'other-series' }])
    expect(await read()).toMatchObject({
      conferenceUrl: stale.hangoutLink,
      htmlLink: stale.htmlLink,
    })
    state.secondaryUidItems.set(shared, [master, sparse])
    state.instances.set(shared, [stale])
    expect(await read()).toMatchObject({ conferenceUrl: null, htmlLink: null })
    state.instances.set(shared, [stale, later])
    const nextLinks = { conferenceUrl: later.hangoutLink, htmlLink: later.htmlLink }
    expect(await read()).toMatchObject({
      ...nextLinks,
      kind: 'meeting',
      scope: 'series',
      cancelled: false,
      canRespond: false,
      responseTargetKey: null,
    })
    // A fully identified cancellation does not need a mailbox attendee to
    // withhold shared navigation, but an older one cannot defeat reinstatement.
    const full = { ...stale, ...sparse, sequence: 3 }
    state.secondaryUidItems.set(shared, [master, full])
    expect(await read()).toMatchObject(nextLinks)
    state.messages = [gmailMessage('new', 300, exportSource(4))]
    master.sequence = stale.sequence = 4
    expect(await read()).toMatchObject({
      conferenceUrl: stale.hangoutLink,
      htmlLink: stale.htmlLink,
    })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it('does not use an organizer-free UID to resolve a malformed iTIP rendition', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2024-07-18T14:00:00Z'))
  const { state, list } = await rig()
  const request = invite().replace(`ORGANIZER;CN=Host:mailto:${organizer}\r\n`, '')
  const exported = request.replace('METHOD:REQUEST\r\n', '')
  const copy = { ...event(), hangoutLink: 'https://meet.google.com/abc-defg-hij' }
  copy.attendees[0]!.responseStatus = 'needsAction'
  state.events.set('primary', [copy])
  const unsupported = request.replace('METHOD:REQUEST', 'METHOD:X-UNKNOWN')
  const invalidInterval = exported.replace('DTEND:20240718T160000Z', 'DTEND:20240718T140000Z')
  const cancel = request.replace('METHOD:REQUEST', 'METHOD:CANCEL')
  const disputed = gmailMessage('disputed', 200, exported)
  disputed.payload.mimeType = 'multipart/alternative'
  disputed.payload.parts.push(gmailMessage('other', 200, request).payload.parts[1]!)
  for (const mail of [
    gmailMessage('request', 200, request, { method: 'REQUEST' }),
    gmailMessage('mime-request', 200, exported, { method: 'REQUEST' }),
    gmailMessage('cancel', 200, cancel),
    gmailMessage('unsupported', 200, unsupported),
    gmailMessage('invalid-interval', 200, invalidInterval),
    disputed,
  ]) {
    state.messages = [mail]
    expect((await list()).invitations).not.toContainEqual(
      expect.objectContaining({ kind: 'meeting' }),
    )
  }
  state.messages = [gmailMessage('request', 200, request), gmailMessage('legacy', 300, exported)]
  expect((await list()).invitations).toEqual([])
  expect(state.calendarUidQueries).toEqual([])
})

it('refuses to project an older actionable invitation when a newer full MIME tree is incomplete', async () => {
  const { state, list, read, respond, call } = await rig()
  expect(await read()).toMatchObject({ canRespond: true })
  const newer = gmailMessage('newer', 300, invite('REQUEST', '', 4), { method: 'REQUEST' })
  const nested = { mimeType: 'multipart/mixed', body: { size: 0 }, parts: [{}] }
  state.fullThreadOverride = {
    id: 'thread',
    messages: [
      ...state.messages,
      { ...newer, payload: { ...newer.payload, parts: [newer.payload.parts[0], nested] } },
    ],
  }
  await expect(call('thread', { id: 'thread' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await list()).toMatchObject({
    invitations: [],
    recoveryReason: expect.stringMatching(/invalid full MIME part/i),
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  nested.parts = [{ mimeType: 'text/plain', body: { size: 0 } }, newer.payload.parts[1]!]
  await expect(call('thread', { id: 'thread' })).resolves.toMatchObject({
    messages: [expect.any(Object), expect.objectContaining({ hasCalendarPayload: true })],
  })
  expect(await read()).toMatchObject({
    identity: { messageId: 'newer', sequence: 4 },
    canRespond: true,
  })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it.each(['message/rfc822', 'multipart/alternative', 'text/plain'])(
  'rejects a multipart whose conflicting %s header changes MIME traversal',
  async (declaration) => {
    const { state, list, read, respond } = await rig()
    await read()
    const latest = gmailMessage('newer', 300, invite('REQUEST', '', 4))
    const contentType = { name: 'Content-Type', value: declaration }
    const nested = {
      ...latest.payload,
      headers: [contentType],
    }
    state.fullThreadOverride = {
      id: 'thread',
      messages: [...state.messages, { ...latest, payload: { ...latest.payload, parts: [nested] } }],
    }
    expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
    contentType.value = 'multipart/mixed'
    expect(await read()).toMatchObject({ identity: { messageId: 'newer' }, canRespond: true })
  },
)

it('never uses invitation evidence from a different full Gmail thread', async () => {
  const { state, list } = await rig()
  state.fullThreadOverride = {
    id: 'wrong-thread',
    messages: [gmailMessage('elsewhere', 200, invite(), { threadId: 'wrong-thread' })],
  }
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  state.fullThreadOverride = undefined
  expect(await list()).toMatchObject({ invitations: [{ identity, canRespond: true }] })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['ORGANIZER', 'ATTENDEE'] as const)(
  'does not authorize an RSVP with duplicate VALUE on %s, even next to a valid REQUEST',
  async (property) => {
    const { state, list, read, respond } = await rig()
    const quotedName = 'CN="Name;VALUE=TEXT"'
    const valid = (params: string) =>
      invite().replace(
        new RegExp(`${property}(?:;CN=Host)?:`),
        `${property};${quotedName};${params}:`,
      )
    state.messages = [gmailMessage('update', 200, valid('VALUE=CAL-ADDRESS'))]
    expect(await read()).toMatchObject({ identity, canRespond: true })
    for (const params of ['value="TEXT";VALUE=CAL-ADDRESS', 'value=CAL-ADDRESS;VALUE=TEXT']) {
      state.messages[1] = gmailMessage('ambiguous', 300, valid(params))
      expect(await list()).toMatchObject({
        invitations: [{ canRespond: false, unavailableReason: expect.any(String) }],
      })
      await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
    }
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  },
)

it.each(['UID', 'METHOD', 'X-EXTENSION'])(
  'rejects duplicate VALUE on %s in a related REQUEST or Sent reply in either order',
  async (property) => {
    const { state, list, read, respond } = await rig()
    const parameters = (source: string, params: string) =>
      source
        .replace('END:VEVENT', 'X-EXTENSION:one,two;VALUE=TEXT\r\nEND:VEVENT')
        .replace(`${property}:`, `${property};CN="Name^';VALUE=TEXT";${params}:`)
    const request = invite()
    const reply = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:')
    const sent = (source: string) =>
      gmailMessage('sent', 500, source, {
        sent: true,
        parent: '<update@example.net>',
        method: 'REPLY',
      })
    state.messages = [gmailMessage('update', 200, parameters(request, 'VALUE=TEXT'))]
    expect(await read()).toMatchObject({ identity, canRespond: true })
    for (const params of ['value="URI";VALUE=TEXT', 'value=TEXT;VALUE=URI']) {
      state.messages[1] = gmailMessage('newer', 300, parameters(request, params))
      expect(await list()).toMatchObject({ invitations: [{ canRespond: false }] })
      await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
      state.messages[1] = sent(parameters(reply, params))
      expect(await read()).toMatchObject({ canRespond: false, sentResponseStatus: null })
      await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    state.messages[1] = sent(parameters(reply, 'VALUE=TEXT'))
    expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it('keeps a visible unstamped REQUEST nonactionable on both channels without falling back', async () => {
  const { state, read, respond } = await rig()
  const stamped = state.messages[0]!
  const unstamped = gmailMessage(
    'unstamped',
    300,
    invite().replace('DTSTAMP:20240701T090000Z\r\n', ''),
  )
  for (const hasCalendarCopy of [false, true]) {
    if (hasCalendarCopy) state.events.set('primary', [event()])
    state.messages = [unstamped]
    expect(await read()).toMatchObject({
      identity: { messageId: 'unstamped', uid, dtstamp: null },
      kind: 'invitation',
      cancelled: false,
      canRespond: false,
      unavailableReason: expect.any(String),
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.messages.push(stamped)
    expect(await read()).toMatchObject({ kind: 'invitation', cancelled: false, canRespond: false })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.messages = [stamped]
    expect(await read()).toMatchObject({ canRespond: true })
  }
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

  state.messages[3] = gmailMessage('wrong-organizer', 190, cancel.replace(organizer, guest), {
    from: guest,
  })
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
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: false })
  series.recurrence = ['RRULE:FREQ=WEEKLY;BYDAY=TH,FR', 'EXDATE:20240725T150000Z,20240726T150000Z']
  series.attendees[0]!.responseStatus = 'needsAction'
  series.etag = '"organizer-reset"'
  expect(await read()).toMatchObject({
    responseStatus: 'needsAction',
    recordedResponseStatus: 'needsAction',
    canRespond: true,
  })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
  })
  expect(state.calendarPatchAttempts).toBe(2)
  expect(state.sendAttempts).toBe(0)
})

it('proves floating-occurrence absence without guessing a time zone', async () => {
  const { state, read, respond, restart } = await rig()
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
  state.events.delete(secondary)

  state.events.set('primary', [event({ id: 'floating-copy', occurrence: true })])
  expect(await read()).toMatchObject({ scope: 'occurrence', canRespond: false })
  state.primaryPages = [{ kind: 'calendar#events' }]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({
    scope: 'occurrence',
    responseStatus: null,
    canRespond: false,
  })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await reopened.read()).toMatchObject({
    scope: 'occurrence',
    floating: true,
    canRespond: true,
  })
  expect(await reopened.respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'gmail',
    invitation: { responseStatus: 'accepted' },
  })
  const sent = state.sent.get('reply-1')?.payload.parts[1]?.body.data
  expect(Buffer.from(sent!, 'base64url').toString()).toContain('RECURRENCE-ID:20240711T150000\r\n')
  expect(state.instanceReads).toBe(0)
  expect(state.sendAttempts).toBe(1)
})

it.each([
  ['missing original slot', undefined, false],
  ['provably different original slot', { dateTime: '2024-07-25T11:00:00-04:00' }, true],
] as const)(
  'distinguishes a %s from a matching Calendar occurrence',
  async (_case, originalStartTime, canRespond) => {
    const { state, read, restart } = await rig()
    const occurrence = invite().replace(
      'END:VEVENT',
      'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT',
    )
    state.messages = [gmailMessage('update', 200, occurrence)]
    state.events.set('primary', [{ ...event({ occurrence: true }), originalStartTime }])
    expect(await read()).toMatchObject({ scope: 'occurrence', canRespond: false })

    // A complete list may omit either row while its underlying resource remains.
    state.primaryPages = [{ kind: 'calendar#events' }]
    expect(await restart().read()).toMatchObject({ scope: 'occurrence', canRespond })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it('retains a listed occurrence for its own slot, not the slot being read', async () => {
  const { state, read, respond, restart } = await rig()
  const request = (slot: string) =>
    invite().replace('END:VEVENT', `RECURRENCE-ID:${slot}\r\nEND:VEVENT`)
  const slotA = event({ id: 'slot-a', occurrence: true })
  const slotB = {
    ...event({ id: 'slot-b', occurrence: true }),
    // A moved exception may have the same displayed time as a different slot.
    originalStartTime: { dateTime: '2024-07-25T11:00:00-04:00' },
    htmlLink: 'https://calendar.google.com/calendar/event?eid=slotB',
  }
  state.messages = [gmailMessage('request-a', 200, request('20240711T150000Z'))]
  state.events.set('primary', [event({ id: 'series', series: true }), slotB])
  state.instances.set('primary', [slotA])
  expect(await read()).toMatchObject({
    identity: { messageId: 'request-a', recurrenceId: '2024-07-11T15:00:00.000Z' },
    canRespond: true,
    htmlLink: slotA.htmlLink,
  })

  // The master and slot A are gone. The UID collection also omits the still
  // readable slot B; that resource cannot become A's target or block A's absence.
  state.primaryPages = [{ kind: 'calendar#events' }]
  state.events.set('primary', [slotB])
  state.instances.clear()
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ canRespond: true, htmlLink: null })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })

  // A new invitation for B must not use Gmail while B still exists, nor can
  // the known exact resource provide RSVP or navigation when omitted from the list.
  state.messages = [gmailMessage('request-b', 300, request('20240725T150000Z'))]
  expect(await reopened.read()).toMatchObject({
    identity: { messageId: 'request-b', recurrenceId: '2024-07-25T15:00:00.000Z' },
    canRespond: false,
    responseTargetKey: null,
    recordedResponseStatus: null,
    htmlLink: null,
  })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
  })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it.each(
  [
    ['text/calendar; method="REQUEST'],
    ['text/calendar; method=REQUEST; METHOD=REPLY'],
    ['text/calendar; method=REQUEST', 'text/calendar; method=REQUEST'],
    ['text/calendar; method=REQUEST', 'text/plain; method=REQUEST'],
  ].map((contentTypes) => ({ contentTypes })),
)('does not treat invalid MIME metadata as missing ($contentTypes)', async ({ contentTypes }) => {
  const { state, list, read, respond } = await rig()
  await read()
  state.messages.push(gmailMessage('ambiguous', 300, invite(), { contentTypes }))
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each([
  { mimeType: 'text/calendar', contentType: 'text/plain; method=REQUEST', hasCopy: true },
  {
    mimeType: 'text/plain',
    contentType: '(invite) TeXt / CaLeNdAr; method=REQUEST',
    hasCopy: false,
  },
])(
  'blocks a REQUEST with conflicting media declarations ($mimeType)',
  async ({ mimeType, contentType, hasCopy }) => {
    const { state, call, list, read, respond } = await rig()
    const latest = gmailMessage('latest', 300, invite(), { method: 'REQUEST' })
    state.messages.push(latest)
    if (hasCopy) state.events.set('primary', [event()])
    expect(await read()).toMatchObject({ identity: { messageId: 'latest' }, canRespond: true })

    const part = latest.payload.parts[1]!
    part.mimeType = mimeType
    part.headers![0]!.value = contentType
    // Discovery still offers the invitation reader; neither the contradictory
    // rendition nor the older REQUEST can authorize a response.
    expect(await call('thread', { id: 'thread' })).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'latest', hasCalendarPayload: true }),
      ]),
    })
    expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

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

it('cannot confirm an out-of-thread Sent receipt until its full nested MIME is readable', async () => {
  const { state, read, respond, list } = await rig()
  state.replyThread = 'separate-thread'
  state.sentVisible = false
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: true })

  const prose = state.sent.get('reply-1')!.payload.parts[0]!
  Object.assign(prose, {
    mimeType: 'multipart/mixed',
    body: { size: 0 },
    parts: [{ mimeType: 'text/plain' }],
  })
  state.sentVisible = true
  expect(await list()).toMatchObject({
    invitations: [],
    recoveryReason: expect.stringMatching(/invalid full MIME part/i),
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  Object.assign(prose, { parts: [{ mimeType: 'text/plain', body: { size: 0 } }] })
  expect(await read()).toMatchObject({ responseStatus: 'accepted', responsePending: false })
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

it('does not answer a rolled-back or conflicting REQUEST after a confirmed Gmail reply', async () => {
  const { state, read, respond, restart } = await rig()
  state.replyThread = 'separate-thread'
  const older = gmailMessage('older', 900, invite())
  const current = gmailMessage('current', 200, invite('REQUEST', '', 4))
  const stamp = '20240702T090000Z'
  const redelivery = gmailMessage('redelivery', 300, invite('REQUEST', '', 4, stamp))
  const olderReply = { ...acceptedReply('<older@example.net>'), internalDate: '1000' }
  state.messages = [older, olderReply]
  expect(await read()).toMatchObject({ responseStatus: 'accepted', sentResponseStatus: 'accepted' })
  state.messages = [older, current]
  expect(await read()).toMatchObject({ identity: { messageId: 'current' }, canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', refreshPending: false })

  // Matching material can carry the prior answer forward. An explicit change
  // on that delivery must not lose the confirmed version during compaction.
  state.messages = [older, redelivery]
  expect(await read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await respond('tentative')).toMatchObject({ channel: 'gmail', refreshPending: false })

  state.messages = [older]
  const reopened = restart()
  const blocked = {
    canRespond: false,
    responseTargetKey: null,
    responseStatus: null,
    sentResponseStatus: null,
    responsePending: false,
    unavailableReason: expect.any(String),
  }
  expect(await reopened.read()).toMatchObject({
    ...blocked,
    identity: { messageId: 'older', sequence: 3 },
    title: 'Design sync',
    start,
    end,
    recordedResponseStatus: null,
  })
  await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  state.messages.push(olderReply)
  expect(await reopened.read()).toMatchObject({ ...blocked, recordedResponseStatus: null })
  const olderCopy = event()
  state.events.set('primary', [olderCopy])
  expect(await reopened.read()).toMatchObject({ ...blocked, recordedResponseStatus: 'declined' })
  // A fresh Calendar answer belongs to that copy only, including when the
  // user asks for the same answer; the old card cannot establish a no-op.
  await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.events.clear()

  state.messages = [
    gmailMessage(
      'conflict',
      1000,
      invite('REQUEST', '', 4, stamp).replace('Upstairs', 'Downstairs'),
    ),
  ]
  expect(await reopened.read()).toMatchObject({
    ...blocked,
    identity: { messageId: 'conflict', sequence: 4 },
    location: 'Downstairs',
    recordedResponseStatus: null,
  })
  await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(2)
  expect(state.calendarPatchAttempts).toBe(0)

  state.messages = [redelivery]
  expect(await reopened.read()).toMatchObject({ responseStatus: 'tentative', canRespond: true })
  expect(await reopened.respond('tentative')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(2)

  state.messages.push(gmailMessage('newest', 100, invite('REQUEST', '', 5)))
  expect(await reopened.read()).toMatchObject({
    identity: { messageId: 'newest' },
    responseStatus: 'needsAction',
    canRespond: true,
  })
  expect(await reopened.respond('declined')).toMatchObject({
    channel: 'gmail',
    refreshPending: false,
  })
  expect(state.sendAttempts).toBe(3)
  expect(state.calendarPatchAttempts).toBe(0)
})

it.each(['calendar', 'gmail'] as const)(
  'needs fresh Calendar material for a later same-sequence REQUEST after a confirmed %s reply',
  async (channel) => {
    const { state, read, respond, restart } = await rig()
    const replacement = 'replacement@example.org'
    // Change prose in the Gmail case without also removing a conference link.
    const priorDescription = channel === 'gmail' ? 'Review the sketches' : undefined
    const request = invite('REQUEST', '', 4)
    const prior = (
      priorDescription
        ? request.replace(/^DESCRIPTION:[^\r\n]*/m, `DESCRIPTION:${priorDescription}`)
        : request
    ).replace('END:VEVENT', `ATTENDEE:mailto:${guest}\r\nEND:VEVENT`)
    const oldCopy = { ...event({ description: priorDescription }), sequence: 4 }
    state.messages = [gmailMessage('prior', 200, prior)]
    if (channel === 'calendar') state.events.set('primary', [oldCopy])
    else state.replyThread = 'separate-thread'
    expect(await read()).toMatchObject({ canRespond: true })
    expect(await respond('accepted')).toMatchObject({ channel, refreshPending: false })
    const writesBeforeUpdate = [state.calendarPatchAttempts, state.sendAttempts]

    const latest = prior.replace('20240701T090000Z', '20240702T090000Z').replace(guest, replacement)
    // The Gmail case also changes prose: even a current roster cannot prove
    // a changed description that the provider omits.
    const description = 'Bring the plans'
    state.messages = [
      gmailMessage(
        'latest',
        300,
        channel === 'gmail'
          ? latest.replace(/^DESCRIPTION:[^\r\n]*/m, `DESCRIPTION:${description}`)
          : latest,
      ),
    ]
    // The same Calendar resource still has the prior roster and answer. The
    // connected mailbox remains the unique self attendee in both revisions.
    oldCopy.attendees[0]!.responseStatus = 'accepted'
    state.events.set('primary', [oldCopy])
    const reopened = restart()
    const blocked = {
      identity: { messageId: 'latest', sequence: 4 },
      canRespond: false,
      responseStatus: null,
      recordedResponseStatus: null,
      sentResponseStatus: null,
      responsePending: false,
      responseTargetKey: null,
      unavailableReason: expect.any(String),
    }
    expect(await reopened.read()).toMatchObject(blocked)
    await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // Collection omission cannot turn the already observed resource into
    // permission to fall back to Gmail while the exact GET still finds it.
    state.primaryPages = [{ kind: 'calendar#events' }]
    expect(await reopened.read()).toMatchObject(blocked)
    await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.primaryPages = null

    const current = {
      ...oldCopy,
      etag: '"updated-roster"',
      description: undefined,
      attendees: [
        { ...oldCopy.attendees[0]!, responseStatus: 'needsAction' },
        { ...oldCopy.attendees[1]!, email: replacement },
      ],
    }
    state.events.set('primary', [current])
    if (channel === 'gmail') {
      expect(await reopened.read()).toMatchObject(blocked)
      await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      state.events.set('primary', [{ ...current, description, etag: '"updated-description"' }])
    }
    await expect(respond('declined')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect([state.calendarPatchAttempts, state.sendAttempts]).toEqual(writesBeforeUpdate)

    expect(await reopened.read()).toMatchObject({
      identity: { messageId: 'latest', sequence: 4 },
      responseTargetKey: expect.any(String),
      responseStatus: 'needsAction',
      canRespond: true,
    })
    expect(await reopened.respond('declined')).toMatchObject({
      channel: 'calendar',
      refreshPending: false,
      invitation: { responseStatus: 'declined' },
    })
    expect(state.calendarUpdateRequests.at(-1)).toMatchObject({
      calendar: 'primary',
      eventId: current.id,
      status: 'declined',
    })
    expect(state.calendarPatchAttempts).toBe(writesBeforeUpdate[0]! + 1)
    expect(state.sendAttempts).toBe(writesBeforeUpdate[1])
  },
)

it('retains same-sequence material across confirmed answer replacements and restarts', async () => {
  const { state, read, respond, restart } = await rig()
  const replacement = 'replacement@example.org'
  const prior = invite()
    .replace(/^DESCRIPTION:[^\r\n]*/m, 'DESCRIPTION:Old agenda')
    .replace('END:VEVENT', `ATTENDEE:mailto:${guest}\r\nEND:VEVENT`)
  const latest = prior
    .replace('20240701T090000Z', '20240702T090000Z')
    .replace(guest, replacement)
    .replace('Old agenda', 'Bring the plans')
  const oldCopy = event({ description: 'Old agenda' })
  state.messages = [gmailMessage('prior', 200, prior)]
  state.events.set('primary', [oldCopy])
  expect(await read()).toMatchObject({ canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })

  const current = {
    ...event({ description: 'Bring the plans' }),
    etag: '"updated-material"',
    attendees: [oldCopy.attendees[0]!, { ...oldCopy.attendees[1]!, email: replacement }],
  }
  state.messages.push(gmailMessage('latest', 300, latest))
  state.events.set('primary', [current])
  expect(await read()).toMatchObject({ canRespond: true })
  expect(await respond('tentative')).toMatchObject({ channel: 'calendar', refreshPending: false })
  state.messages.shift()
  const reopened = restart()
  const blocked = {
    identity: { messageId: 'latest', sequence: 3 },
    canRespond: false,
    responseStatus: null,
    recordedResponseStatus: null,
    sentResponseStatus: null,
    responseTargetKey: null,
  }
  for (const rollback of [
    { ...current, attendees: oldCopy.attendees },
    { ...current, description: oldCopy.description },
    { ...current, description: undefined },
    oldCopy,
  ]) {
    state.events.set('primary', [rollback])
    expect(await reopened.read()).toMatchObject(blocked)
    await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  // Omitting the stale copy from the collection still cannot permit Gmail.
  state.primaryPages = [{ kind: 'calendar#events' }]
  expect(await reopened.read()).toMatchObject(blocked)
  await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts).toBe(2)
  expect(state.sendAttempts).toBe(0)

  state.primaryPages = null
  state.events.set('primary', [current])
  expect(await reopened.read()).toMatchObject({ responseStatus: 'tentative', canRespond: true })
  expect(await reopened.respond('declined')).toMatchObject({
    channel: 'calendar',
    refreshPending: false,
  })
  expect(state.calendarUpdateRequests).toHaveLength(3)
  expect(state.calendarUpdateRequests.at(-1)).toMatchObject({
    eventId: current.id,
    status: 'declined',
  })

  const again = restart()
  state.events.set('primary', [oldCopy])
  expect(await again.read()).toMatchObject(blocked)
  await expect(again.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts).toBe(3)
  expect(state.sendAttempts).toBe(0)
})

it('does not treat an older journal anchor as complete Calendar material', async () => {
  const { state, read, restart, userData } = await rig()
  const prior = gmailMessage(
    'update',
    200,
    invite().replace(/^DESCRIPTION:[^\r\n]*/m, 'DESCRIPTION:Old agenda'),
  )
  state.messages = [prior]
  const { messageId: _messageId, ...revision } = (await read())!.identity
  await writeFile(
    join(userData, 'google-mail-invitations.json'),
    JSON.stringify({
      version: 1,
      attempts: [],
      parentAnchors: [
        {
          accountSub: 'receiver',
          mailbox: person,
          organizer,
          parent: '<update@example.net>',
          revision,
        },
      ],
    }),
  )
  const description = 'Bring the plans'
  const latest = invite('REQUEST', '', 3, '20240702T090000Z').replace(
    /^DESCRIPTION:[^\r\n]*/m,
    `DESCRIPTION:${description}`,
  )
  state.messages = [gmailMessage('latest', 300, latest)]
  state.events.set('primary', [event({ description })])
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ canRespond: false, responseStatus: null })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  // The actual source lets us compare the provider's copy and retain what it
  // needed to prove, even if this old REQUEST later leaves the conversation.
  state.messages.unshift(prior)
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'calendar',
    refreshPending: false,
  })
  state.messages.shift()
  const again = restart()
  expect(await again.read()).toMatchObject({ canRespond: true, responseStatus: 'accepted' })
  state.events.get('primary')![0]!.description = undefined
  expect(await again.read()).toMatchObject({ canRespond: false, responseStatus: null })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('keeps the master and a different original slot eligible after an occurrence confirmation', async () => {
  const { state, read, respond, restart } = await rig()
  const occurrence = (sequence: number, slot: string) =>
    invite('REQUEST', '', sequence).replace('END:VEVENT', `RECURRENCE-ID:${slot}\r\nEND:VEVENT`)
  const slot = '20240711T150000Z'
  state.messages = [gmailMessage('confirmed-slot', 200, occurrence(4, slot))]
  expect(await read()).toMatchObject({ scope: 'occurrence', canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', refreshPending: false })

  state.messages = [
    gmailMessage('old-slot', 300, occurrence(3, slot)),
    gmailMessage('different-slot', 400, occurrence(3, '20240725T150000Z')),
    gmailMessage('master', 500, invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')),
  ]
  const { invitations } = await restart().list()
  expect(invitations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: expect.objectContaining({ messageId: 'old-slot' }),
        canRespond: false,
      }),
      expect.objectContaining({
        identity: expect.objectContaining({ messageId: 'different-slot' }),
        canRespond: true,
      }),
      expect.objectContaining({
        identity: expect.objectContaining({ messageId: 'master' }),
        canRespond: true,
      }),
    ]),
  )
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('does not retarget the first click when Calendar omits or replaces a displayed copy', async () => {
  const { state, read, respond, restart } = await rig()
  const first = event({ id: 'first' })
  const second = event({ id: 'second' })
  state.events.set('primary', [first])
  expect(await read()).toMatchObject({ canRespond: true })

  // Google can omit a resource from events.list while events.get still sees it.
  state.primaryPages = [{ kind: 'calendar#events' }]
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await restart().read()).toMatchObject({ canRespond: false })

  state.events.set('primary', [first, second])
  state.primaryPages = [{ kind: 'calendar#events', items: [second] }]
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.primaryPages = null
  state.events.clear()
  for (const error of [503, 'non-json'] as const) {
    state.exactCalendarError = error
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({ canRespond: false, responseTargetKey: null })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  state.exactCalendarError = null
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(await read()).toMatchObject({ canRespond: true })
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', refreshPending: false })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('requires absence of a known series master before sending a reply to one of its occurrences', async () => {
  const { state, read, restart } = await rig()
  const first = invite().replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT')
  state.messages = [gmailMessage('series', 200, first)]
  state.events.set('primary', [event({ id: 'series', series: true })])
  expect(await read()).toMatchObject({ scope: 'series', canRespond: true })

  const occurrence = invite().replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT')
  state.messages = [gmailMessage('occurrence', 300, occurrence)]
  state.primaryPages = [{ kind: 'calendar#events' }]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ scope: 'occurrence', canRespond: false })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await reopened.read()).toMatchObject({ scope: 'occurrence', canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'gmail',
    refreshPending: false,
  })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('keeps distinct Calendar copies through answer compaction and a transition to Gmail', async () => {
  const { state, read, respond, restart } = await rig()
  const first = event({ id: 'first' })
  const second = event({ id: 'second' })
  state.events.set('primary', [first, second])
  state.primaryPages = [{ kind: 'calendar#events', items: [first] }]
  await read()
  expect(await respond('accepted')).toMatchObject({ channel: 'calendar', refreshPending: false })

  second.attendees[0]!.responseStatus = 'accepted'
  state.primaryPages = [{ kind: 'calendar#events', items: [second] }]
  expect(await read()).toMatchObject({ canRespond: true, recordedResponseStatus: 'accepted' })
  expect(await respond('tentative')).toMatchObject({ channel: 'calendar', refreshPending: false })

  const reopened = restart()
  state.primaryPages = [{ kind: 'calendar#events' }]
  state.events.set('primary', [first])
  expect(await reopened.read()).toMatchObject({ canRespond: false })
  await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('declined')).toMatchObject({
    channel: 'gmail',
    refreshPending: false,
  })
  state.events.set('primary', [first])
  expect(await restart().read()).toMatchObject({ canRespond: false })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarUpdateRequests.map(({ eventId }) => eventId)).toEqual(['first', 'second'])
})

it.each(['collection recovers', 'resource deleted'] as const)(
  'keeps the confirmed answer but blocks writes while the exact Calendar copy contradicts absence (%s)',
  async (resolution) => {
    const { state, read, respond, restart } = await rig()
    state.events.set('primary', [event()])
    state.omitAfterPatch = true
    state.replyThread = 'separate-thread'
    await read()
    expect(await respond('accepted')).toMatchObject({
      channel: 'calendar',
      outcome: 'sent',
      refreshPending: false,
      invitation: { responseStatus: 'accepted', canRespond: false },
    })
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'accepted',
      recordedResponseStatus: 'accepted',
      responsePending: false,
      canRespond: false,
    })
    expect(await reopened.respond('accepted')).toMatchObject({
      channel: 'calendar',
      outcome: 'unchanged',
    })
    await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts).toBe(1)
    expect(state.sendAttempts).toBe(0)

    state.omitAfterPatch = false
    if (resolution === 'collection recovers') {
      // The old exact resource still exists, but doesn't prove the newly selected revision.
      const moved = invite('REQUEST', '', 3, '20240702T090000Z').replace('Upstairs', 'Downstairs')
      state.messages.push(gmailMessage('moved', 300, moved))
      expect(await reopened.read()).toMatchObject({
        identity: { messageId: 'moved' },
        canRespond: false,
        responseStatus: null,
        recordedResponseStatus: null,
      })
      await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(state.calendarPatchAttempts).toBe(1)
      expect(state.sendAttempts).toBe(0)

      state.primaryPages = null
      state.events.set('primary', [event({ location: 'Downstairs' })])
      expect(await reopened.read()).toMatchObject({ canRespond: true })
      expect(await reopened.respond('tentative')).toMatchObject({
        channel: 'calendar',
        outcome: 'sent',
        refreshPending: false,
        invitation: { responseStatus: 'tentative' },
      })
      expect(state.calendarPatchAttempts).toBe(2)
      expect(state.sendAttempts).toBe(0)
    } else {
      state.events.clear()
      expect(await reopened.read()).toMatchObject({ canRespond: true })
      expect(await reopened.respond('tentative')).toMatchObject({
        channel: 'gmail',
        outcome: 'sent',
        refreshPending: false,
        invitation: { responseStatus: 'tentative' },
      })
      expect(state.calendarPatchAttempts).toBe(1)
      expect(state.sendAttempts).toBe(1)
    }
  },
)

it('keeps the exact Calendar answer separate from a newer verified Sent answer', async () => {
  const { state, read, respond, restart } = await rig()
  state.events.set('primary', [event()])
  await read()
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
  })
  state.primaryPages = [{ kind: 'calendar#events' }]
  state.messages.push(
    gmailMessage(
      'newer-sent',
      700,
      invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
      { sent: true, parent: '<update@example.net>', method: 'REPLY' },
    ),
  )
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({
    responseStatus: null,
    recordedResponseStatus: 'accepted',
    sentResponseStatus: 'declined',
    canRespond: false,
    responsePending: false,
    responseTargetKey: null,
    htmlLink: null,
  })
  await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)
})

it('remembers the identity of an RSVP-ineligible Calendar copy until exact deletion', async () => {
  const { state, read, respond, restart } = await rig()
  const copy = event()
  state.events.set('primary', [{ ...copy, sequence: 2 }])
  expect(await read()).toMatchObject({ canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  // A distinct copy at the selected sequence can also prove existence even
  // when its provider material is insufficient for RSVP.
  const other = { ...event({ id: 'status-missing' }), status: undefined }
  other.attendees[0]!.responseStatus = undefined
  state.events.set('primary', [other])
  expect(await read()).toMatchObject({ canRespond: false, recordedResponseStatus: null })
  const incoherent = { ...event({ id: 'unknown-end' }), endTimeUnspecified: true }
  state.events.set('primary', [incoherent])
  expect(await read()).toMatchObject({ canRespond: false, responseTargetKey: null })

  state.primaryPages = [{ kind: 'calendar#events' }]
  const reopened = restart()
  for (const remaining of [[{ ...copy, sequence: 2 }], [other], [incoherent]]) {
    state.events.set('primary', remaining)
    expect(await reopened.read()).toMatchObject({ canRespond: false, responseTargetKey: null })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
  })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

function calendarLocator(id: string, eventUid: string) {
  return {
    accountSub: 'receiver',
    uid: eventUid,
    recurrenceId: null as string | null,
    organizer,
    target: JSON.stringify([
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}?sendUpdates=all`,
      person,
    ]),
  }
}

async function seedCalendarLocators(userData: string, count: number) {
  const store = createMailInvitationStore(userData)
  closeFixtures.push(store.close)
  for (let i = 0; i < count; i++)
    await store.rememberCalendarLocator(calendarLocator(`old-${i}`, `unrelated-${i}`), () => {})
  return store
}

function requestFor(eventUid: string, mailbox = person) {
  return gmailMessage(
    'update',
    200,
    invite()
      .replace('conference-series-1234567890-long-\r\n folded-uid', eventUid)
      .replaceAll(person, mailbox),
    { to: mailbox },
  )
}

it('isolates Calendar locator exhaustion by invitation and authenticated mailbox across restart', async () => {
  const a = await rig()
  const store = await seedCalendarLocators(a.userData, 4095)
  const original = event({ id: 'last-retained' })
  a.state.events.set('primary', [original])
  expect(await a.read()).toMatchObject({ canRespond: true })
  a.state.events.clear()
  expect(await a.read()).toMatchObject({ canRespond: true, responseTargetKey: expect.any(String) })
  expect(a.state.originalGets).toContain(original.id)

  // Repeated observations didn't take another slot. The first distinct copy
  // beyond the budget is observed by the real invitation capability.
  const excess = event({ id: 'not-retained' })
  a.state.events.set('primary', [excess])
  expect(await a.read()).toMatchObject({ canRespond: true })
  a.state.events.clear()
  a.state.originalGets.length = 0
  store.close()
  a.close()
  const reopened = a.restart()
  expect(await reopened.read()).toMatchObject({ canRespond: false, responseTargetKey: null })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(a.state.originalGets).toContain(original.id)
  expect(a.state.sendAttempts + a.state.calendarPatchAttempts).toBe(0)

  a.state.messages = [requestFor('fresh-in-same-mailbox')]
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
  })
  expect(a.state.sentMime).toHaveLength(1)

  const address = 'other@example.com'
  const b = await rig(undefined, { userData: a.userData, email: address })
  const secondUid = 'fresh-in-second-mailbox'
  const secondCopy = { ...event({ id: 'second-mailbox-copy' }), iCalUID: secondUid }
  secondCopy.attendees[0]!.email = address
  b.state.messages = [requestFor(secondUid, address)]
  b.state.events.set('primary', [secondCopy])
  expect(await b.read()).toMatchObject({ canRespond: true, htmlLinkSource: 'calendar' })
  b.state.events.clear()
  expect(await b.read()).toMatchObject({ canRespond: true })
  expect(b.state.originalGets).toContain(secondCopy.id)
  expect(await b.respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
  })
  expect(b.state.sentMime).toHaveLength(1)

  const matchingInstant = '2024-07-11T15:00:00.000Z'
  const lookup = async (
    eventUid: string,
    recurrenceId: string | null,
    host: string,
    accountSub = 'receiver',
    email = person,
  ) =>
    store.lookupCalendarEvidence(
      await store.read(),
      { accountSub, email },
      {
        identity: { uid: eventUid, recurrenceId },
        organizer: { email: host },
      },
    )
  await store.rememberCalendarLocator(
    {
      ...calendarLocator('unretained-slot', 'exact-slot'),
      recurrenceId: '2024-07-11T11:00:00-04:00',
    },
    () => {},
  )
  expect(await lookup('exact-slot', matchingInstant, organizer)).toEqual({
    incomplete: true,
    targets: new Set(),
  })
  expect((await lookup('exact-slot', '2024-07-18T15:00:00Z', organizer)).incomplete).toBe(false)
  expect((await lookup('exact-slot', matchingInstant, guest)).incomplete).toBe(false)
  expect((await lookup('exact-slot', matchingInstant, organizer, 'other')).incomplete).toBe(false)
  expect(
    (await lookup('exact-slot', matchingInstant, organizer, 'receiver', address)).incomplete,
  ).toBe(false)
  expect((await lookup('exact-slot', null, organizer)).incomplete).toBe(true)
  expect((await lookup('exact-slot', '2024-07-18', organizer)).incomplete).toBe(true)
  expect((await lookup('exact-slot', '2024-07-18T15:00:00', organizer)).incomplete).toBe(true)

  await store.rememberCalendarLocator(
    {
      ...calendarLocator('unretained-date', 'unknown-organizer'),
      organizer: undefined,
      recurrenceId: '2024-07-11',
    },
    () => {},
  )
  expect((await lookup('unknown-organizer', '2024-07-11', guest)).incomplete).toBe(true)
  expect((await lookup('unknown-organizer', '2024-07-18', guest)).incomplete).toBe(false)
  await store.rememberCalendarLocator(
    {
      ...calendarLocator('unverified-slot', 'unknown-organizer'),
      organizer: undefined,
      occurrenceUnverified: true,
    },
    () => {},
  )
  expect((await lookup('unknown-organizer', '2024-07-18', guest)).incomplete).toBe(true)
})

it('refuses a late matching Calendar footprint but not evidence for another scope', async () => {
  const { userData, state, read, respond } = await rig()
  const store = await seedCalendarLocators(userData, 4096)
  expect(await read()).toMatchObject({ canRespond: true })
  onReservationPublication = () =>
    store.rememberCalendarLocator(calendarLocator('late-copy', uid), () => {})
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  expect(await read()).toMatchObject({ canRespond: false })

  state.messages = [requestFor('another-invitation')]
  expect(await read()).toMatchObject({ canRespond: true })
  onReservationPublication = () =>
    store.rememberCalendarLocator(calendarLocator('other-copy', 'third-invitation'), () => {})
  expect(await respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
  })
  expect(state.sentMime).toHaveLength(1)
  state.messages = [requestFor('third-invitation')]
  expect(await read()).toMatchObject({ canRespond: false })
})

it('does not infer Calendar absence when the observation store cannot write', async () => {
  const { userData, state, read } = await rig()
  await mkdir(join(userData, 'google-mail-invitation-calendar.db'))
  state.events.set('primary', [event()])
  await expect(read()).rejects.toMatchObject({ code: 'EVIDENCE_STORE_FAILURE' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('keeps unattributed legacy Calendar overflow fail-closed after exact misses', async () => {
  const { userData, state, read, respond } = await rig()
  await writeFile(
    join(userData, 'google-mail-invitations.json'),
    JSON.stringify({
      version: 2,
      materialHistory: [],
      attempts: [],
      calendarLocators: [calendarLocator('legacy-calendar-copy', uid)],
      calendarLocatorOverflow: true,
    }),
  )
  expect(await read()).toMatchObject({ canRespond: false })
  expect(state.originalGets).toContain('legacy-calendar-copy')
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('retains an active primary copy with the exact UID and no organizer address', async () => {
  const { state, read, respond, restart } = await rig()
  const copy = event()
  state.events.set('primary', [copy])
  state.primaryPages = [{ kind: 'calendar#events', items: [{ ...copy, organizer: undefined }] }]
  const blocked = { canRespond: false, responseTargetKey: null, htmlLink: null }
  expect(await read()).toMatchObject(blocked)
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  // A complete UID collection is not absence while exact GET still returns
  // the resource. Its complete organizer details cannot authorize a write either.
  state.primaryPages = [{ kind: 'calendar#events' }]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject(blocked)
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
  })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it.each(['primary', 'secondary@example.com'])(
  'keeps a Calendar copy readable without RSVP when Events reports reader on %s',
  async (calendar) => {
    const { state, read, respond } = await rig()
    const copy = event()
    if (calendar === 'primary') state.primaryCalendarRole = 'writer'
    else state.secondaryCalendars = [{ id: calendar, selected: true, accessRole: 'writer' }]
    state.events.set(calendar, [copy])
    state.eventRoleOverrides.set(calendar, 'reader')
    const readOnly = {
      htmlLink: copy.htmlLink,
      responseStatus: 'declined',
      recordedResponseStatus: 'declined',
      canRespond: false,
      responseTargetKey: null,
    }
    expect(await read()).toMatchObject(readOnly)
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // CalendarList's reader observation also cannot be upgraded by a writer page.
    if (calendar === 'primary') state.primaryCalendarRole = 'reader'
    else state.secondaryCalendars[0]!.accessRole = 'reader'
    state.eventRoleOverrides.set(calendar, 'writer')
    expect(await read()).toMatchObject(readOnly)
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)

    if (calendar === 'primary') state.primaryCalendarRole = 'writer'
    else state.secondaryCalendars[0]!.accessRole = 'writer'
    state.eventRoleOverrides.clear()
    expect(await read()).toMatchObject({ canRespond: true })
    expect(await respond('accepted')).toMatchObject({ channel: 'calendar', outcome: 'sent' })
    expect(state.calendarUpdateRequests).toMatchObject([{ calendar, status: 'accepted' }])
    expect(state.sendAttempts).toBe(0)
  },
)

it.each(['primary', 'secondary@example.com'])(
  'shares a fresh CalendarList reader role across invitation cards on %s',
  async (calendar) => {
    const { state, read, list, respond, call } = await rig()
    state.primaryCalendarRole = 'writer'
    if (calendar !== 'primary')
      state.secondaryCalendars = [{ id: calendar, selected: true, accessRole: 'writer' }]
    const gone = { ...event({ id: 'gone' }), iCalUID: 'other-uid' }
    const copy = event()
    state.events.set(calendar, [copy, gone])
    state.messages = [
      gmailMessage('update', 300, invite()),
      gmailMessage(
        'other',
        200,
        invite().replace('conference-series-1234567890-long-\r\n folded-uid', gone.iCalUID),
      ),
    ]
    expect((await list()).invitations.map(({ canRespond }) => canRespond)).toEqual([true, true])

    state.events.set(calendar, [copy])
    // Complete UID reads are still from the writable snapshot. The exact
    // miss is followed by a CalendarList entry that sees the new role.
    state.afterExactCalendarMiss = () => state.eventRoleOverrides.set(calendar, 'reader')
    const readOnly = { canRespond: false, responseTargetKey: null }
    const result = await list()
    expect(result.invitations).toHaveLength(2)
    expect(result.invitations.find(({ identity }) => identity.uid === uid)).toMatchObject({
      ...readOnly,
      htmlLink: copy.htmlLink,
      recordedResponseStatus: 'declined',
      responseStatus: 'declined',
    })
    const missing = result.invitations.find(({ identity }) => identity.uid === gone.iCalUID)!
    expect(missing).toMatchObject(readOnly)
    // Even when preflight reads only the selected card, its known locator
    // finds the lost role. It must not authorize falling back to Gmail.
    state.eventRoleOverrides.clear()
    await expect(
      call('respondToMailInvitation', {
        ...thread,
        identity: missing.identity,
        expectedResponseTargetKey: null,
        expectedBindingRevision: missing.bindingRevision,
        answer: 'accepted',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await read()
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)

    // A fresh writer entry does not undo the reader role already observed by
    // the collection reads. A new read can establish restored write access.
    state.afterExactCalendarMiss = () => state.eventRoleOverrides.set(calendar, 'writer')
    for (const card of (await list()).invitations) expect(card).toMatchObject(readOnly)
    state.afterExactCalendarMiss = () => {}
    expect(await read()).toMatchObject({ canRespond: true })
    expect(await respond('accepted')).toMatchObject({ channel: 'calendar', outcome: 'sent' })
    expect(state.calendarUpdateRequests).toMatchObject([{ calendar, status: 'accepted' }])
    expect(state.sendAttempts).toBe(0)
  },
)

it('keeps verified series Join but not its RSVP actions when expansion reports reader', async () => {
  const { state, read } = await rig()
  state.messages = [gmailMessage('update', 200, seriesWithException())]
  const master = event({ id: 'series', series: true })
  const next = upcomingInstance('next', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg')
  state.events.set('primary', [master])
  state.instances.set('primary', [next])
  state.expandedPages = [{ kind: 'calendar#events', accessRole: 'reader', items: [next] }]
  expect(await read()).toMatchObject({
    htmlLink: next.htmlLink,
    conferenceUrl: next.hangoutLink,
    recordedResponseStatus: 'declined',
    canRespond: false,
    responseTargetKey: null,
  })
})

it('uses the strictest UID and instance page role at final Calendar preflight', async () => {
  const { state, read, respond } = await rig()
  state.messages = [
    gmailMessage(
      'update',
      200,
      invite().replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT'),
    ),
  ]
  const master = event({ id: 'series', series: true })
  const instance = event({ id: 'moved', occurrence: true })
  state.events.set('primary', [master])
  state.instances.set('primary', [instance])
  expect(await read()).toMatchObject({ canRespond: true })

  // A refresh happens after the initial response lookup and before dispatch.
  state.refreshOnInstanceCopy = true
  state.onRefresh = async () => {
    state.instanceRoleOverrides.set('primary', 'reader')
  }
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  const readOnly = {
    scope: 'occurrence',
    htmlLink: instance.htmlLink,
    canRespond: false,
    responseTargetKey: null,
    recordedResponseStatus: 'declined',
  }
  expect(await read()).toMatchObject(readOnly)

  // A later owner page (even the exact original-slot instance page) cannot
  // undo the downgrade seen earlier in this same read.
  state.instanceRoleOverrides.clear()
  state.primaryPages = [
    { kind: 'calendar#events', accessRole: 'reader', items: [master], nextPageToken: '1' },
    { kind: 'calendar#events', accessRole: 'owner' },
  ]
  expect(await read()).toMatchObject(readOnly)
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it('requires current event read access before an empty secondary UID page permits Gmail', async () => {
  const { state, read, respond } = await rig()
  const calendar = 'secondary@example.com'
  state.secondaryCalendars = [{ id: calendar, selected: true, accessRole: 'reader' }]
  state.events.set(calendar, [event()])
  // CalendarList still advertises reader; events.list can now only give free/busy.
  state.freeBusyEventCollections.add(calendar)
  expect(await read()).toMatchObject({
    canRespond: false,
    responseStatus: null,
    responseTargetKey: null,
    htmlLink: null,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)

  state.events.delete(calendar)
  state.freeBusyEventCollections.delete(calendar)
  expect(await read()).toMatchObject({ canRespond: true, responseStatus: 'needsAction' })
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', channel: 'gmail' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('requires access to a known secondary calendar before its event 404 permits Gmail', async () => {
  const { state, read, restart } = await rig()
  const secondary = {
    id: 'hidden@example.com',
    selected: false,
    hidden: true,
    accessRole: 'writer' as const,
  }
  state.secondaryCalendars = [secondary]
  state.events.set(secondary.id, [event()])
  expect(await read()).toMatchObject({ canRespond: true, recordedResponseStatus: 'declined' })
  // The event still exists. Complete UID discovery does not see it, and an
  // exact GET without read access returns the same 404 as deletion.
  state.secondaryUidItems.set(secondary.id, [])
  const reopened = restart()
  const blocked = { canRespond: false, responseTargetKey: null }
  for (const subscriptions of [
    [],
    [{ ...secondary, accessRole: 'freeBusyReader' as const }],
    [{ ...secondary, deleted: true }],
    [secondary],
  ]) {
    state.secondaryCalendars = subscriptions
    expect(await reopened.read()).toMatchObject(blocked)
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  state.events.delete(secondary.id)
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  // The initial response read sees a real deletion. During final preflight
  // Google first returns the old writable subscription and a complete UID
  // list, then loses access before the exact read (also a 404).
  let uidReads = 0
  state.afterSecondaryUidRead = () => {
    if (++uidReads === 2) {
      state.events.set(secondary.id, [event()])
      state.secondaryCalendars = []
    }
  }
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(state.sendAttempts).toBe(0)
  state.secondaryCalendars = [secondary]
  expect(await reopened.read()).toMatchObject(blocked) // Restored access reveals the exact event.
  state.events.delete(secondary.id)
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'sent', channel: 'gmail' })
  expect(state.sendAttempts).toBe(1)
})

it.each(['mailbox', 'other mailbox', 'ambiguous self'] as const)(
  'treats a sparse shared Calendar row as possible existence only when bound to the mailbox (%s)',
  async (membership) => {
    const { state, read, respond, restart } = await rig()
    const secondary = 'shared@example.com'
    state.secondaryCalendars.push({ id: secondary, selected: true, accessRole: 'writer' })
    const request = (slot: string) =>
      invite()
        .replace('DESCRIPTION:https://meet.google.com/abc-defg-hij\r\n', '')
        .replace('END:VEVENT', `RECURRENCE-ID:${slot}\r\nEND:VEVENT`)
    const source = gmailMessage('update', 200, request('20240711T150000Z'))
    state.messages = [source]
    const copy = event({ occurrence: true })
    copy.hangoutLink = 'https://meet.google.com/xyz-abcd-efg'
    if (membership === 'other mailbox') copy.attendees[0]!.email = secondary
    if (membership === 'ambiguous self') copy.attendees[1]!.self = true
    state.events.set(secondary, [copy])
    state.secondaryUidItems.set(secondary, [{ ...copy, organizer: undefined }])
    const blocked = {
      canRespond: false,
      responseTargetKey: null,
      responseStatus: null,
      recordedResponseStatus: null,
      conferenceUrl: null,
      htmlLink: null,
    }
    expect(await read()).toMatchObject(blocked)
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // The UID collection is now empty while the exact resource still exists.
    state.secondaryUidItems.set(secondary, [])
    const reopened = restart()
    if (membership === 'mailbox') {
      state.messages = [gmailMessage('other-slot', 300, request('20240704T150000Z'))]
      expect(await reopened.read()).toMatchObject({ canRespond: true })
      state.messages = [source]
      expect(await reopened.read()).toMatchObject(blocked)
      await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      state.events.delete(secondary) // Exact 404 and a complete empty UID collection.
    }
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
    expect(await reopened.read()).toMatchObject({ canRespond: true })
    if (membership === 'mailbox') {
      expect(await reopened.respond('accepted')).toMatchObject({
        channel: 'gmail',
        outcome: 'sent',
        refreshPending: false,
      })
      expect(state.sendAttempts).toBe(1)
      expect(state.calendarPatchAttempts).toBe(0)
    }
  },
)

it('retains sparse primary cancellations until every possible exact copy is gone', async () => {
  const { state, read, restart } = await rig()
  const first = { ...event({ id: 'first' }), status: 'cancelled' }
  const second = { ...event({ id: 'second' }), status: 'cancelled' }
  state.events.set('primary', [first, second])
  state.primaryPages = [
    {
      kind: 'calendar#events',
      items: [{ id: first.id, iCalUID: uid, status: 'cancelled', organizer: {} }],
    },
  ]
  const unverified = {
    cancelled: false,
    canRespond: false,
    conferenceUrl: null,
    htmlLink: null,
    responseTargetKey: null,
  }
  expect(await read()).toMatchObject(unverified)
  state.primaryPages = [{ kind: 'calendar#events', items: [{ ...second, iCalUID: undefined }] }]
  expect(await read()).toMatchObject(unverified)

  // The complete collection now omits both rows, but exact GET still sees them.
  state.primaryPages = [{ kind: 'calendar#events' }]
  const reopened = restart()
  const blocked = { canRespond: false, recordedResponseStatus: null, responseTargetKey: null }
  expect(await reopened.read()).toMatchObject(blocked)
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.events.set('primary', [second])
  expect(await reopened.read()).toMatchObject(blocked)
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.events.clear()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'gmail',
    refreshPending: false,
  })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it.each([
  { status: 'cancelled', failsLaterPage: false },
  { status: 'confirmed', failsLaterPage: false },
  { status: undefined, failsLaterPage: true },
])(
  'retains a UID-less primary instance (status $status) even when its parent disappears',
  async ({ status, failsLaterPage }) => {
    const { state, read, respond, restart } = await rig()
    state.messages[0] = gmailMessage(
      'update',
      200,
      invite()
        .replace('DESCRIPTION:https://meet.google.com/abc-defg-hij\r\n', '')
        .replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT'),
    )
    state.events.set('primary', [event({ id: 'series', series: true })])
    const copy = event({ id: 'instance', occurrence: true })
    const sparse = {
      ...copy,
      status,
      iCalUID: undefined,
      organizer: undefined,
      hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
    }
    state.instances.set('primary', [sparse])
    state.instanceContinuationUnavailable = failsLaterPage
    const blocked = {
      scope: 'occurrence',
      canRespond: false,
      responseTargetKey: null,
      htmlLink: null,
      conferenceUrl: null,
    }
    expect(await read()).toMatchObject({ ...blocked, cancelled: false })
    if (status === 'confirmed') {
      // Even a fresh organizer and self attendee do not turn the query's
      // parent binding into payload UID proof.
      state.instances.set('primary', [{ ...sparse, organizer: copy.organizer }])
      expect(await read()).toMatchObject(blocked)
    }
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // The complete UID list is empty and the master returns 404. The instance
    // still returns 200, even if only an incomplete collection ever showed it.
    state.events.clear()
    const reopened = restart()
    expect(await reopened.read()).toMatchObject(blocked)
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

    state.instances.clear()
    expect(await reopened.read()).toMatchObject({ canRespond: true })
    expect(await reopened.respond('accepted')).toMatchObject({
      channel: 'gmail',
      outcome: 'sent',
      refreshPending: false,
    })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it.each([
  { query: 'instances', bindsMailbox: true },
  { query: 'expanded', bindsMailbox: true },
  { query: 'instances', bindsMailbox: false },
] as const)(
  'retains a sparse secondary child from $query only if it binds the mailbox ($bindsMailbox)',
  async ({ query, bindsMailbox }) => {
    const { state, read, respond, restart } = await rig()
    const secondary = 'secondary@example.com'
    state.secondaryCalendars.push({ id: secondary, selected: true, accessRole: 'owner' })
    const request = invite('REQUEST', 'DTSTART:20990710T150000Z\r\nDTEND:20990710T160000Z').replace(
      /^DESCRIPTION:[^\r\n]*\r\n/m,
      '',
    )
    const slotRequest = request.replace(
      'END:VEVENT',
      'RECURRENCE-ID:20990709T150000Z\r\nEND:VEVENT',
    )
    const child = {
      ...upcomingInstance('child', '2099-07-10', 'https://meet.google.com/xyz-abcd-efg'),
      iCalUID: undefined,
      organizer: undefined,
      originalStartTime: query === 'instances' ? { dateTime: '2099-07-09T15:00:00Z' } : undefined,
    }
    if (!bindsMailbox) child.attendees[0]!.email = secondary
    const master = {
      ...event({ id: 'series', series: true }),
      start: { dateTime: '2099-07-10T15:00:00Z', timeZone: 'UTC' },
      end: { dateTime: '2099-07-10T16:00:00Z' },
    }
    const blocked = {
      scope: 'occurrence',
      canRespond: false,
      responseTargetKey: null,
      conferenceUrl: null,
      htmlLink: null,
    }
    state.events.set(secondary, [master])
    state.instances.set(secondary, [child])
    if (query === 'instances') {
      state.messages = [gmailMessage('update', 200, slotRequest)]
      state.instanceContinuationUnavailable = true
      expect(await read()).toMatchObject(blocked)
      await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } else {
      state.messages = [
        gmailMessage(
          'series',
          200,
          request.replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'),
        ),
      ]
      state.expandedPages = [{ kind: 'calendar#events', items: [child], nextPageToken: '1' }]
      expect(await read()).toMatchObject({
        scope: 'series',
        canRespond: true,
        conferenceUrl: null,
        htmlLink: master.htmlLink,
      })
    }

    // Complete lists and a readable 404 for the parent do not erase the
    // child observed before a collection failure. Its exact GET still works.
    state.events.clear()
    state.messages = [gmailMessage('update', 300, slotRequest)]
    const reopened = restart()
    if (bindsMailbox) {
      expect(await reopened.read()).toMatchObject(blocked)
      await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
      state.instances.clear()
    }
    expect(await reopened.read()).toMatchObject({ canRespond: true })
    expect(await reopened.respond('accepted')).toMatchObject({
      channel: 'gmail',
      refreshPending: false,
    })
    expect(state.calendarPatchAttempts).toBe(0)
    expect(state.sendAttempts).toBe(1)
  },
)

it('remembers a sparse secondary sibling from legacy DATE navigation without using its links', async () => {
  const clock = vi.spyOn(Date, 'now')
  const { state, read, restart } = await rig()
  const calendar = 'secondary@example.com'
  state.secondaryCalendars = [{ id: calendar, selected: true, accessRole: 'owner' }]
  state.calendarDateOffsets.set(calendar, '+09:00')
  const slot = (method: string, start: string, original: string) =>
    invite(method, `DTSTART;VALUE=DATE:${start}\r\nRECURRENCE-ID;VALUE=DATE:${original}`)
  state.messages = [
    gmailMessage(
      'export',
      200,
      slot('EXPORT', '20240718', '20240711').replace('METHOD:EXPORT\r\n', ''),
    ),
  ]
  const master = {
    ...event({ id: 'series', series: true, allDay: true }),
    start: { date: '2024-07-04', timeZone: 'Asia/Tokyo' },
    end: { date: '2024-07-05' },
  }
  const selected = event({ id: 'selected', occurrence: true, allDay: true })
  selected.attendees[0]!.responseStatus = 'needsAction'
  const sibling = {
    ...selected,
    id: 'sibling',
    iCalUID: undefined,
    organizer: undefined,
    start: { date: '2024-07-19' },
    end: { date: '2024-07-20' },
    originalStartTime: { date: '2024-07-25' },
    htmlLink: 'https://calendar.google.com/calendar/event?eid=sibling',
    hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
  }
  state.events.set(calendar, [master])
  state.instances.set(calendar, [selected, sibling])

  // At the exclusive end plus the grace hour the selected row has dropped
  // out. The sibling is in the provider's window, but belongs to another slot.
  clock.mockReturnValue(Date.parse('2024-07-18T16:00:00Z'))
  expect(await read()).toMatchObject({
    scope: 'occurrence',
    kind: 'meeting',
    allDay: true,
    htmlLink: null,
    conferenceUrl: null,
    canRespond: false,
  })

  state.events.delete(calendar)
  state.messages = [gmailMessage('request', 300, slot('REQUEST', '20240719', '20240725'))]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({
    identity: { recurrenceId: '2024-07-25' },
    canRespond: false,
    responseTargetKey: null,
    htmlLink: null,
  })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)

  state.instances.set(calendar, [selected])
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({ channel: 'gmail', outcome: 'sent' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('does not treat a cancelled Calendar row for a known different organizer as a known copy', async () => {
  const { state, read, restart } = await rig()
  state.events.set('primary', [
    { ...event(), status: 'cancelled', organizer: { email: guest, self: false } },
  ])
  expect(await read()).toMatchObject({ canRespond: false })
  state.primaryPages = [{ kind: 'calendar#events' }]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({ channel: 'gmail', outcome: 'sent' })
  expect(state.calendarPatchAttempts).toBe(0)
  expect(state.sendAttempts).toBe(1)
})

it('uses a fresh Calendar reset but remembers the confirmed answer when that copy is missing', async () => {
  const { state, read, respond, restart } = await rig()
  const copy = event()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DELEGATED:'),
  )
  state.events.set('primary', [copy])
  await read()
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
  })

  state.events.clear()
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'unchanged',
  })

  copy.attendees[0]!.responseStatus = 'needsAction'
  copy.etag = '"organizer-reset"'
  state.events.set('primary', [copy])
  expect(await reopened.read()).toMatchObject({
    responseStatus: 'needsAction',
    recordedResponseStatus: 'needsAction',
    canRespond: true,
    responsePending: false,
  })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(await reopened.respond('accepted')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
    invitation: { responseStatus: 'accepted' },
  })
  expect(state.calendarPatchAttempts).toBe(2)
  expect(state.calendarUpdateRequests.map(({ status }) => status)).toEqual(['accepted', 'accepted'])
  expect(state.sendAttempts).toBe(0)
})

it('does not treat an omitted self response after confirmed Calendar delivery as a reset', async () => {
  const { state, read, respond, restart } = await rig()
  const copy = event()
  state.events.set('primary', [copy])
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: false })

  copy.attendees[0]!.responseStatus = undefined
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({
    recordedResponseStatus: null,
    responseStatus: null,
    canRespond: false,
  })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await reopened.read()).toMatchObject({ canRespond: false })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)

  copy.attendees[0]!.responseStatus = 'accepted'
  expect(await reopened.read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({
    outcome: 'unchanged',
    refreshPending: false,
  })
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)
})

it.each(['duplicate mailbox attendee', 'unspecified end'])(
  'keeps Calendar delivery pending when exact readback has %s',
  async (defect) => {
    const { state, read, respond, restart } = await rig()
    const copy = event()
    const originalGuest = { ...copy.attendees[1]! }
    state.events.set('primary', [copy])
    state.omitAfterPatch = true
    state.afterPatch = () => {
      if (defect === 'duplicate mailbox attendee')
        copy.attendees.push({ ...copy.attendees[0]!, email: person.toUpperCase(), self: false })
      else copy.endTimeUnspecified = true
    }
    await read()
    expect(await respond('accepted')).toMatchObject({
      outcome: 'sent',
      refreshPending: true,
      invitation: { canRespond: false, responsePending: true },
    })
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({ canRespond: false, responsePending: true })
    await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    copy.attendees.splice(2)
    copy.endTimeUnspecified = undefined
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'accepted',
      responsePending: false,
    })
    expect(await reopened.respond('accepted')).toMatchObject({
      outcome: 'unchanged',
      refreshPending: false,
    })
    expect(copy.attendees[1]).toEqual(originalGuest)
    expect(state.calendarPatchAttempts).toBe(1)
    expect(state.sendAttempts).toBe(0)
  },
)

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
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('marks contradictory Sent readback instead of settling or offering to send the same answer again', async () => {
  const { state, read, respond } = await rig()
  const previous = acceptedReply('<update@example.net>')
  // Gmail reports the pre-existing competing answer as later than the just-filed reply.
  state.sentInternalDate = 501
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

it('uses a newer Gmail answer on a verified old parent after equivalent REQUEST redelivery', async () => {
  const { state, read, respond, restart } = await rig()
  state.replyThread = 'separate-sent-thread'
  await read()
  expect(await respond('accepted')).toMatchObject({
    channel: 'gmail',
    refreshPending: false,
    invitation: { responseStatus: 'accepted' },
  })

  const parent = '<update@example.net>'
  const decline = gmailMessage(
    'gmail-decline',
    700,
    // An old iTIP DTSTAMP does not order Gmail messages.
    invite('REPLY', '', 3, '20240101T000000Z').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
    { sent: true, parent, method: 'REPLY' },
  )
  const unorderable = { ...decline, internalDate: undefined }
  state.messages.push(unorderable)
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ responseStatus: null, canRespond: false })
  await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  const unrelated = gmailMessage(
    'different-parent',
    900,
    invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:'),
    { sent: true, parent: '<unrelated@example.net>', method: 'REPLY' },
  )
  state.messages = [
    gmailMessage('redelivery', 300, invite('REQUEST', '', 3, '20240702T090000Z')),
    decline,
    unrelated,
  ]
  expect(await reopened.read()).toMatchObject({
    responseStatus: 'declined',
    sentResponseStatus: 'declined',
    canRespond: true,
  })
  expect(await reopened.respond('declined')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(1)

  expect(await reopened.respond('tentative')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: false,
    invitation: { responseStatus: 'tentative' },
  })
  expect(await reopened.read()).toMatchObject({ responseStatus: 'tentative', canRespond: true })
  expect(await reopened.respond('tentative')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(2)

  // The second confirmed Holi answer compacted the first receipt. An even
  // later Sent reply to the original (now absent) REQUEST still belongs here.
  const lateAccepted = gmailMessage(
    'late-original-accept',
    1100,
    invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:'),
    { sent: true, method: 'REPLY', parent },
  )
  lateAccepted.payload.headers.find(({ name }) => name === 'From')!.value =
    `"Example, Me" (nested (comment)) <${person}>`
  lateAccepted.payload.headers.find(({ name }) => name === 'To')!.value =
    `Undisclosed:;, "Host, Organizer" <${organizer}> (host)`
  // Independent manual replies do not claim to match Holi's organizer-only send.
  lateAccepted.payload.headers.push({ name: 'Cc', value: guest })
  state.messages.push(lateAccepted)
  const afterCompaction = restart()
  expect(await afterCompaction.read()).toMatchObject({
    sentResponseStatus: 'accepted',
    responseStatus: 'accepted',
    canRespond: true,
  })
  expect(await afterCompaction.respond('accepted')).toMatchObject({ outcome: 'unchanged' })

  // Even an anchor's original reply needs uncontested ownership. A plain
  // claimant found after compaction leaves later mail on a possible-only parent.
  const anchorRfcId = state.sent
    .get('reply-1')!
    .payload.headers.find(({ name }) => name === 'Message-ID')!.value
  const anchorClaim = gmailMessage('anchor-id-claim', 1140, undefined, {
    rfcId: anchorRfcId,
    sent: true,
    threadId: 'another-thread',
  })
  // Even a non-Sent claim in Spam contests a compacted Sent anchor.
  anchorClaim.labelIds = ['SPAM']
  state.sent.set(anchorClaim.id, anchorClaim)
  const disputedAnswer = { sentResponseStatus: null, responseStatus: null, canRespond: false }
  expect(await restart().read()).toMatchObject(disputedAnswer)
  state.sent.delete(anchorClaim.id)
  expect(await restart().read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })

  // Plain mail claiming the now-absent parent invalidates even a persisted
  // anchor. Its later valid REPLY still contests the older redelivery receipt.
  const claim = gmailMessage('plain-claim', 1150, undefined, { rfcId: '<plain@example.net>' })
  claim.payload.headers.push({ name: 'message-id', value: parent })
  state.messages.push(claim)
  expect(await restart().read()).toMatchObject(disputedAnswer)
  state.messages.pop()

  const copy = event()
  copy.attendees[0]!.responseStatus = 'needsAction'
  state.events.set('primary', [copy])
  await afterCompaction.read()
  expect(await afterCompaction.respond('tentative')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
  })
  state.messages.push(
    gmailMessage(
      'late-original-decline',
      1200,
      invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
      { sent: true, method: 'REPLY', parent },
    ),
    gmailMessage(
      'late-unrelated-accept',
      1400,
      invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:'),
      { sent: true, method: 'REPLY', parent: '<unrelated@example.net>' },
    ),
  )
  const afterTransition = restart()
  expect(await afterTransition.read()).toMatchObject({
    recordedResponseStatus: 'tentative',
    sentResponseStatus: 'declined',
  })
  state.events.clear()
  expect(await afterTransition.read()).toMatchObject({
    responseStatus: 'declined',
    sentResponseStatus: 'declined',
    canRespond: true,
  })
  expect(await afterTransition.respond('declined')).toMatchObject({ outcome: 'unchanged' })

  // Same UID and sequence don't let old parents cross an explicit RSVP reset.
  state.messages.push(
    gmailMessage(
      'mailbox-reset',
      1300,
      invite('REQUEST', '', 3, '20240703T090000Z').replace('ATTENDEE:', 'ATTENDEE;RSVP=TRUE:'),
    ),
  )
  expect(await afterTransition.read()).toMatchObject({
    responseStatus: 'needsAction',
    sentResponseStatus: null,
  })
  expect(state.sendAttempts).toBe(2)
  expect(state.calendarPatchAttempts).toBe(1)
})

it('uses whole Message-ID claims from plain mail without letting duplicate headers prove ownership', async () => {
  const { state, read, respond } = await rig()
  const parent = '<update@example.net>'
  const plain = gmailMessage('plain', 550)
  const duplicate = { name: 'MESSAGE-ID', value: `junk ${parent}` }
  plain.payload.headers.push(duplicate)
  state.messages.push(acceptedReply(parent), plain)
  expect(await read()).toMatchObject({ canRespond: true, sentResponseStatus: 'accepted' })

  duplicate.value = parent
  const first = plain.payload.headers.find(({ name }) => name === 'Message-ID')!
  for (const value of ['<unrelated@example.net>', parent, `junk ${parent}`]) {
    first.value = value
    expect(await read()).toMatchObject({ canRespond: false, sentResponseStatus: null })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it.each(['valid', 'unreadable'])(
  'withholds an older answer when a disputed equivalent delivery has a %s Sent reply',
  async (reply) => {
    const { state, read, respond } = await rig()
    const disputed = '<update@example.net>'
    const proven = '<redelivery@example.net>'
    const decline = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
    const malformed = decline.replace('UID:', 'UID;VALUE="TEXT",URI:')
    state.messages.push(
      gmailMessage('redelivery', 300, invite('REQUEST', '', 3, '20240702T090000Z')),
      { ...acceptedReply(proven), internalDate: '500' },
      gmailMessage('plain-claim', 600, undefined, { rfcId: disputed }),
      gmailMessage('ordinary-sent', 1000, undefined, { sent: true, parent: disputed }),
      gmailMessage('unrelated-malformed', 1000, malformed, {
        sent: true,
        method: 'REPLY',
        parent: '<unrelated@example.net>',
      }),
    )
    expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
    const disputedReply = gmailMessage(
      'disputed-reply',
      500,
      reply === 'valid' ? decline : malformed,
      {
        sent: true,
        method: 'REPLY',
        parent: disputed,
      },
    )
    state.messages.push(disputedReply)
    for (const timestamp of ['500', '700']) {
      disputedReply.internalDate = timestamp
      expect(await read()).toMatchObject({
        responseStatus: null,
        sentResponseStatus: null,
        canRespond: false,
        responsePending: false,
        unavailableReason: expect.stringMatching(/Gmail.*verify/i),
      })
      await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    state.messages.push(gmailMessage('independent', 800, decline, { sent: true, parent: proven }))
    expect(await read()).toMatchObject({ sentResponseStatus: 'declined', canRespond: true })
    expect(await respond('declined')).toMatchObject({ outcome: 'unchanged' })
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  },
)

it('scopes a Sent calendar leaf with ambiguous MIME declarations by parent and provider order', async () => {
  const { state, read, respond } = await rig()
  const parent = '<update@example.net>'
  const decline = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
  state.messages.push(
    { ...acceptedReply(parent), internalDate: '500' },
    gmailMessage('unrelated-sent', 1000, decline, {
      sent: true,
      parent: '<unrelated@example.net>',
      contentTypes: ['text/calendar; method=REPLY', 'text/calendar; method=REPLY'],
    }),
  )
  expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
  expect(await respond('accepted')).toMatchObject({ outcome: 'unchanged' })

  const related = gmailMessage('related-sent', 300, decline, {
    sent: true,
    parent,
    method: 'REPLY',
  })
  related.payload.parts[1]!.mimeType = 'text/plain'
  state.messages.push(related)
  expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
  related.internalDate = '700'
  for (const mimeType of ['text/plain', 'text/calendar; method=REQUEST']) {
    related.payload.parts[1]!.mimeType = mimeType
    expect(await read()).toMatchObject({
      responseStatus: null,
      sentResponseStatus: null,
      canRespond: false,
    })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }

  state.messages.push(gmailMessage('independent', 800, decline, { sent: true, parent }))
  expect(await read()).toMatchObject({ sentResponseStatus: 'declined', canRespond: true })
  expect(await respond('declined')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

const replyContradictions = [
  'To',
  'From',
  'parent',
  'thread',
  'scope',
  'answer',
  'alternative answer',
  'MIME media type',
  'extra Cc',
  'extra Bcc',
  'malformed Cc',
  'duplicate Bcc',
] as const

function contradictoryReply(
  message: ReturnType<typeof gmailMessage>,
  field: (typeof replyContradictions)[number],
) {
  const full = structuredClone(message)
  if (field === 'To' || field === 'From') {
    full.payload.headers.find(({ name }) => name === field)!.value = guest
  } else if (field === 'extra Cc' || field === 'extra Bcc') {
    full.payload.headers.push({ name: field.slice(6), value: `Guests:\r\n ${guest};` })
  } else if (field === 'malformed Cc') {
    full.payload.headers.push({ name: 'Cc', value: 'Undisclosed:;, (unclosed' })
  } else if (field === 'duplicate Bcc') {
    full.payload.headers.push({ name: 'Bcc', value: '' }, { name: 'bcc', value: '' })
  } else if (field === 'parent') {
    for (const header of full.payload.headers) {
      if (header.name === 'In-Reply-To' || header.name === 'References')
        header.value = '<different-request@example.net>'
    }
  } else if (field === 'thread') {
    full.threadId = 'different-thread'
  } else if (field === 'MIME media type') {
    full.payload.parts[1]!.headers![0]!.value = 'text/plain; method=REPLY'
  } else {
    const body = full.payload.parts[1]!.body
    const source = Buffer.from(body.data!, 'base64url').toString('utf8')
    const changed =
      field === 'scope'
        ? source.replace('folded-uid', 'other-event')
        : source.replace('PARTSTAT=ACCEPTED', 'PARTSTAT=DECLINED')
    if (field === 'alternative answer') {
      full.payload.mimeType = 'multipart/alternative'
      full.payload.parts.push(
        gmailMessage('alternative', 1, changed, { method: 'REPLY' }).payload.parts[1]!,
      )
    } else Object.assign(body, { data: wire(changed), size: Buffer.byteLength(changed) })
  }
  return full
}

it('does not settle a newer reservation through a compacted parent without a corroborating full Sent envelope', async () => {
  const { state, read, respond, restart } = await rig()
  const parent = '<update@example.net>'
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: false })
  state.replyThread = 'separate-thread'
  state.messages = [gmailMessage('redelivery', 300, invite('REQUEST', '', 3, '20240702T090000Z'))]
  await read()
  expect(await respond('tentative')).toMatchObject({ outcome: 'sent', refreshPending: false })

  const anchorReply = state.sent.get('reply-1')!
  const later = { ...acceptedReply(parent), internalDate: '1200' }
  const reopened = restart()
  const staleAnchor = structuredClone(anchorReply)
  state.messages.push(later, staleAnchor)
  state.sentIndexed = false
  // An empty search is fine when the full anchor GET corroborates the reply.
  expect(await reopened.read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
  const blocked = { sentResponseStatus: null, responseStatus: null, canRespond: false }
  // The exact resource still owns its RFC Message-ID and is labelled SENT.
  for (const field of ['To', 'alternative answer'] as const) {
    state.sent.set(anchorReply.id, contradictoryReply(anchorReply, field))
    expect(await reopened.read()).toMatchObject(blocked)
  }
  state.sent.set(anchorReply.id, { ...anchorReply, labelIds: ['INBOX'] })
  expect(await reopened.read()).toMatchObject(blocked)
  await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.messages.splice(-2)

  // An unthreaded send without a returned locator stays reserved until there
  // is an exact receipt or independent proof after the contested receipt.
  state.sentIndexed = false
  state.sendReplyMode = 'empty'
  await reopened.read()
  expect(await reopened.respond('declined')).toMatchObject({
    outcome: 'sent',
    refreshPending: true,
  })
  const pendingReply = state.sent.get('reply-3')!
  const pendingRfcId = pendingReply.payload.headers.find(({ name }) => name === 'Message-ID')!.value
  const duplicate = gmailMessage('plain-id-claim', 900, undefined, {
    sent: true,
    rfcId: pendingRfcId,
    threadId: state.replyThread,
  })
  state.sent.set(duplicate.id, duplicate)
  state.sentIndexed = true
  // The index no longer sees the historical reply and its direct GET is 404,
  // despite threads.get still returning a stale row with the SENT label.
  state.sent.delete(anchorReply.id)
  state.messages.push(later, staleAnchor)
  expect(await reopened.read()).toMatchObject({ ...blocked, responsePending: true })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  for (const field of replyContradictions) {
    state.sent.set(anchorReply.id, contradictoryReply(anchorReply, field))
    expect(await reopened.read(), field).toMatchObject({ ...blocked, responsePending: true })
  }

  state.sent.set(anchorReply.id, anchorReply)
  expect(await reopened.read()).toMatchObject({
    sentResponseStatus: 'accepted',
    responseStatus: 'accepted',
    responsePending: false,
    canRespond: true,
  })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(3)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('settles a new in-thread receipt only from a corroborating full Sent envelope', async () => {
  const { state, read, respond, restart } = await rig()
  state.sentIndexed = false
  state.fullSentMessage = (message) => contradictoryReply(message, 'MIME media type')
  await read()
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    refreshPending: true,
    invitation: { sentResponseStatus: null, responsePending: true, canRespond: false },
  })

  const reopened = restart()
  for (const field of replyContradictions) {
    state.fullSentMessage = (message) => contradictoryReply(message, field)
    expect(await reopened.read(), field).toMatchObject({
      sentResponseStatus: null,
      responseStatus: null,
      responsePending: true,
      canRespond: false,
    })
  }
  await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  state.fullSentMessage = (message) => message
  expect(await reopened.read()).toMatchObject({
    sentResponseStatus: 'accepted',
    responsePending: false,
    canRespond: true,
  })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('orders conflicting Sent alternatives within their parent scope without hiding other invitations', async () => {
  const { state, list, read, respond } = await rig()
  const parent = '<update@example.net>'
  const otherUid = uid.replace('folded-uid', 'other-event')
  const other = gmailMessage('other', 100, invite().replace('folded-uid', 'other-event'))
  const accepted = { ...acceptedReply(parent), internalDate: '500' }
  const disputed = contradictoryReply(
    { ...accepted, id: 'disputed', internalDate: '300' },
    'alternative answer',
  )
  disputed.payload.headers.find(({ name }) => name === 'Message-ID')!.value =
    '<disputed@example.net>'
  const otherProof = gmailMessage(
    'other-reply',
    400,
    invite('REPLY')
      .replace('folded-uid', 'other-event')
      .replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=TENTATIVE:'),
    { sent: true, parent: '<other@example.net>' },
  )
  state.messages.push(other, otherProof, accepted, disputed)
  expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
  for (const timestamp of ['500', '700']) {
    disputed.internalDate = timestamp
    expect(await read()).toMatchObject({
      responseStatus: null,
      sentResponseStatus: null,
      canRespond: false,
    })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(
      (await list()).invitations.find(({ identity }) => identity.uid === otherUid),
    ).toMatchObject({
      responseStatus: 'tentative',
      sentResponseStatus: 'tentative',
      canRespond: true,
    })
  }

  const decline = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
  const independent = gmailMessage('newer-reply', 800, decline, { sent: true, parent })
  independent.payload.mimeType = 'multipart/alternative'
  independent.payload.parts.push(
    gmailMessage('cosmetic', 800, decline.replace('Design sync', 'Cosmetic subject'), {
      method: 'REPLY',
    }).payload.parts[1]!,
  )
  state.messages.push(independent)
  expect(await read()).toMatchObject({ sentResponseStatus: 'declined', canRespond: true })
  expect(await respond('declined')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it.each([
  { method: 'PUBLISH', defect: 'invalid encoding' },
  { method: 'REQUEST', defect: 'invalid encoding' },
  { method: 'REPLY', defect: 'invalid encoding' },
  { method: 'REQUEST', defect: 'media type conflict' },
])(
  'scopes a Sent alternative with $defect without trusting its valid $method sibling',
  async ({ method, defect }) => {
    const { state, list, read, respond } = await rig()
    const parent = '<update@example.net>'
    const decline = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
    const otherUid = uid.replace('folded-uid', 'other-event')
    state.events.set('primary', [{ ...event(), iCalUID: otherUid }])
    const sibling =
      method === 'REPLY' ? decline : invite(method).replace('folded-uid', 'other-event')
    const disputed = (replyParent: string, timestamp: number) => {
      const mail = gmailMessage('disputed', timestamp, decline, { sent: true, parent: replyParent })
      mail.payload.mimeType = 'multipart/alternative'
      if (defect === 'media type conflict') {
        mail.payload.parts[1]!.headers!.push({
          name: 'Content-Type',
          value: 'text/plain; method=REPLY',
        })
      } else mail.payload.parts[1]!.body.data = '!bad!'
      mail.payload.parts.push(
        gmailMessage('sibling', timestamp, sibling, { method }).payload.parts[1]!,
      )
      return mail
    }
    state.messages.push({ ...acceptedReply(parent), internalDate: '500' })
    state.messages.push(disputed('<unrelated@example.net>', 300))
    expect((await list()).invitations).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ uid }),
        sentResponseStatus: 'accepted',
        canRespond: true,
      }),
    ])

    state.messages.pop()
    state.messages.push(disputed(parent, 300))
    expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
    for (const timestamp of ['500', '700']) {
      state.messages.at(-1)!.internalDate = timestamp
      expect(await read()).toMatchObject({
        responseStatus: null,
        sentResponseStatus: null,
        canRespond: false,
      })
      await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    state.messages.push(gmailMessage('independent', 800, decline, { sent: true, parent }))
    expect(await read()).toMatchObject({ sentResponseStatus: 'declined', canRespond: true })
    expect(await respond('declined')).toMatchObject({ outcome: 'unchanged' })
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  },
)

it.each(['invalid base64', 'declared size mismatch'])(
  'scopes an unreadable methodless Sent leaf by parent and order (%s)',
  async (defect) => {
    const { state, list, read, respond } = await rig()
    const parent = '<update@example.net>'
    const decline = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
    const damaged = (id: string, timestamp: number, replyParent?: string) => {
      const sent = replyParent !== undefined
      const source = sent ? decline : invite()
      const mail = gmailMessage(id, timestamp, source, {
        sent,
        parent: replyParent,
        // Underreport by more than base64 padding but stay well within the scan limits.
        declaredSize: Buffer.byteLength(source) - (defect === 'declared size mismatch' ? 10 : 0),
      })
      if (defect === 'invalid base64') mail.payload.parts[1]!.body.data = '!bad!'
      return mail
    }
    const related = damaged('related', 300, parent)
    state.messages.push(
      related,
      { ...acceptedReply(parent), internalDate: '500' },
      damaged('unrelated', 1000, '<unrelated@example.net>'),
    )
    expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
    for (const timestamp of ['500', '700']) {
      related.internalDate = timestamp
      expect(await read()).toMatchObject({ sentResponseStatus: null, canRespond: false })
      await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    state.messages.push(gmailMessage('independent', 800, decline, { sent: true, parent }))
    expect(await read()).toMatchObject({ sentResponseStatus: 'declined', canRespond: true })
    expect(await respond('declined')).toMatchObject({ outcome: 'unchanged' })

    state.messages.push(damaged('incoming', 900))
    expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  },
)

it('keeps transient calendar attachment failures local to possible Sent replies', async () => {
  const { state, list, read, respond } = await rig()
  const parent = '<update@example.net>'
  const decline = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
  const alternative = (id: string, timestamp: number, replyParent: string) => {
    const mail = gmailMessage(id, timestamp, decline, {
      sent: true,
      parent: replyParent,
      attached: true,
    })
    mail.payload.mimeType = 'multipart/alternative'
    mail.payload.parts.push(
      gmailMessage('inline', timestamp, decline, { method: 'REPLY' }).payload.parts[1]!,
    )
    state.attachments.set(id, decline)
    state.attachmentErrors.set(id, 503)
    return mail
  }
  const related = alternative('related', 300, parent)
  const unrelated = alternative('unrelated', 1000, '<unrelated@example.net>')
  const ordinary = gmailMessage('ordinary', 1100, 'PDF data', {
    sent: true,
    parent,
    attached: true,
  })
  ordinary.payload.parts[1]!.mimeType = 'application/pdf'
  ordinary.payload.parts[1]!.filename = 'document.pdf'
  state.attachmentErrors.set(ordinary.id, 401)
  state.messages.push(
    related,
    { ...acceptedReply(parent), internalDate: '500' },
    unrelated,
    ordinary,
  )
  expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })

  related.internalDate = '700'
  expect(await read()).toMatchObject({
    responseStatus: null,
    sentResponseStatus: null,
    canRespond: false,
  })
  await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.attachmentErrors.delete(related.id)
  expect(await read()).toMatchObject({ sentResponseStatus: 'declined', canRespond: true })
  expect(await respond('declined')).toMatchObject({ outcome: 'unchanged' })

  // Account refusals are not leaf-local, even on an unrelated Sent message.
  state.attachmentErrors.set(unrelated.id, 401)
  await expect(list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  state.attachmentErrors.delete(unrelated.id)
  const incoming = gmailMessage('incoming', 1200, invite(), { attached: true, method: 'REQUEST' })
  state.messages.push(incoming)
  state.attachmentErrors.set(incoming.id, 503)
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it.each(['inline', 'attachment'] as const)(
  'does not look up an identity manufactured from invalid UTF-8 REQUEST bytes (%s)',
  async (storage) => {
    const { state, list, read, respond } = await rig()
    const attached = storage === 'attachment'
    const valid = withUnicodeUid(invite())
    state.messages = [gmailMessage('unicode', 200, valid, { attached, method: 'REQUEST' })]
    if (attached) state.attachments.set('unicode', valid)
    state.events.set('primary', [{ ...event(), iCalUID: unicodeUid }])
    expect(await read()).toMatchObject({ identity: { uid: unicodeUid }, canRespond: true })
    expect(state.calendarUidQueries).toContain(unicodeUid)

    const invalid = invalidUidBytes(invite())
    state.messages = [gmailMessage('unicode', 200, invalid, { attached, method: 'REQUEST' })]
    if (attached) state.attachments.set('unicode', invalid)
    state.calendarUidQueries.length = 0
    expect(await list()).toMatchObject({
      invitations: [],
      recoveryReason: expect.stringMatching(/UTF-8/i),
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarUidQueries).toEqual([])
    expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
  },
)

it.each(['inline', 'attachment'] as const)(
  'withholds invalid UTF-8 Sent evidence without releasing an accepted dispatch (%s)',
  async (storage) => {
    const { state, read, respond, restart } = await rig()
    const parent = '<update@example.net>'
    state.messages = [
      gmailMessage('update', 200, withUnicodeUid(invite())),
      gmailMessage(
        'older-answer',
        300,
        withUnicodeUid(invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=ACCEPTED:')),
        { sent: true, parent },
      ),
    ]
    const attached = storage === 'attachment'
    // The attached variant has no MIME method hint. Neither variant may
    // turn the bad UID into the literal U+FFFD in the real invitation.
    const method = attached ? undefined : 'REPLY'
    const invalid = invalidUidBytes(
      invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=TENTATIVE:'),
    )
    const unreadable = gmailMessage('newer-unreadable', 700, invalid, {
      sent: true,
      attached,
      method,
      parent,
    })
    if (attached) state.attachments.set(unreadable.id, invalid)
    const unverified = {
      responseStatus: null,
      sentResponseStatus: null,
      canRespond: false,
      unavailableReason: expect.stringMatching(/Gmail.*verify/i),
    }
    state.messages.push(unreadable)
    expect(await read()).toMatchObject({ ...unverified, responsePending: false })
    await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    state.messages.pop()

    state.replyThread = 'separate-sent-thread'
    state.sentVisible = false
    state.sentInternalDate = 500
    expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
    expect(await respond('tentative')).toMatchObject({ outcome: 'sent', refreshPending: true })

    const receipt = state.sent.get('reply-1')!
    const rfcId = receipt.payload.headers.find(({ name }) => name === 'Message-ID')!.value
    state.sent.set(
      receipt.id,
      gmailMessage(receipt.id, 500, invalid, {
        sent: true,
        attached,
        method,
        parent,
        rfcId,
        threadId: receipt.threadId,
      }),
    )
    state.messages.push(unreadable)
    if (attached) state.attachments.set(receipt.id, invalid)
    state.sentVisible = true
    const reopened = restart()
    const unsettled = { ...unverified, responsePending: true }
    expect(await reopened.read()).toMatchObject(unsettled)
    await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    state.messages.push(
      gmailMessage(
        'independent',
        800,
        withUnicodeUid(invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')),
        { sent: true, parent },
      ),
    )
    expect(await reopened.read()).toMatchObject({
      responsePending: false,
      sentResponseStatus: 'declined',
      canRespond: true,
    })
    expect(await reopened.respond('declined')).toMatchObject({ outcome: 'unchanged' })
    state.messages.pop()
    expect(await restart().read()).toMatchObject(unsettled)
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it('withholds a live Sent reply with a contested RFC ID until a uniquely owned newer answer', async () => {
  const { state, read, respond } = await rig()
  const parent = '<update@example.net>'
  const sent = { ...acceptedReply(parent), internalDate: '500' }
  state.messages.push(sent)
  expect(await read()).toMatchObject({ sentResponseStatus: 'accepted', canRespond: true })
  const claim = gmailMessage('plain-reply-id-claim', 600)
  claim.payload.headers.push({
    name: 'message-id',
    value: sent.payload.headers.find(({ name }) => name === 'Message-ID')!.value,
  })
  state.messages.push(claim)
  expect(await read()).toMatchObject({
    responseStatus: null,
    sentResponseStatus: null,
    canRespond: false,
  })
  await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const unique = gmailMessage(
    'unique-decline',
    500,
    invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
    { sent: true, parent, method: 'REPLY' },
  )
  state.messages.push(unique)
  expect(await read()).toMatchObject({ sentResponseStatus: null, canRespond: false })
  unique.internalDate = '700'
  expect(await read()).toMatchObject({ sentResponseStatus: 'declined', canRespond: true })
  expect(await respond('declined')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts + state.calendarPatchAttempts).toBe(0)
})

it.each(['ok', 'empty'] as const)(
  'keeps a %s off-thread Gmail dispatch reserved when its exact search includes plain Sent mail with the same RFC ID',
  async (sendReplyMode) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = 'sent-elsewhere'
    state.sendReplyMode = sendReplyMode
    state.sentInternalDate = 500
    state.sentVisible = false
    await read()
    expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: true })
    const rfcId = state.sent
      .get('reply-1')!
      .payload.headers.find(({ name }) => name === 'Message-ID')!.value
    const plain = gmailMessage('plain-sent', 600, undefined, {
      sent: true,
      rfcId,
      threadId: 'another-thread',
    })
    state.sent.set(plain.id, plain)
    state.sentVisible = true
    const reopened = restart()
    expect(await reopened.read()).toMatchObject({
      responseStatus: null,
      sentResponseStatus: null,
      responsePending: true,
      canRespond: false,
    })
    await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const later = gmailMessage(
      'newer-answer',
      700,
      invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
      { sent: true, parent: '<update@example.net>', method: 'REPLY' },
    )
    state.messages.push(later)
    expect(await reopened.read()).toMatchObject({
      sentResponseStatus: 'declined',
      responsePending: false,
      canRespond: true,
    })
    expect(await reopened.respond('declined')).toMatchObject({ outcome: 'unchanged' })
    state.messages.pop()
    expect(await restart().read()).toMatchObject({
      sentResponseStatus: null,
      responsePending: true,
      canRespond: false,
    })
    state.sent.delete(plain.id)
    // A send-resource 404 can race the index. Once indexed, the same ID may
    // become readable without another write or even a second public read.
    state.receiptMissOnce = sendReplyMode === 'ok'
    expect(await reopened.read()).toMatchObject({
      sentResponseStatus: 'accepted',
      responsePending: false,
      canRespond: true,
    })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it('keeps a Gmail acknowledgement binding when its journal update fails', async () => {
  const { userData, state, read, respond, restart } = await rig()
  state.replyThread = 'sent-elsewhere'
  const temporary = join(userData, 'google-mail-invitations.json.tmp')
  const acknowledgedId = 'reply-1'
  const otherId = 'different-gmail-id'
  state.beforeSendAcknowledgement = async () => {
    // The request already crossed the durable dispatch gate. Block the actual
    // atomic write without touching the committed journal or its read path.
    await mkdir(temporary)
    const sent = state.sent.get(acknowledgedId)!
    state.sent.set(otherId, { ...sent, id: otherId })
    state.sent.delete(acknowledgedId)
  }
  await read()
  const unresolved = {
    responseStatus: null,
    sentResponseStatus: null,
    responsePending: true,
    canRespond: false,
  }
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'gmail',
    refreshPending: true,
    invitation: unresolved,
  })
  expect(await read()).toMatchObject(unresolved)
  await expect(respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  await rm(temporary, { recursive: true })
  // A new session has only the durable reservation. A matching index/body
  // cannot stand in for the lost acknowledgement, even with writes restored.
  const reopened = restart()
  expect(await reopened.read()).toMatchObject(unresolved)
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await read()).toMatchObject(unresolved)
  expect(await restart().read()).toMatchObject(unresolved)

  // When the exact acknowledged resource appears, read-only Retry settles it.
  const substitute = state.sent.get(otherId)!
  state.sent.delete(otherId)
  state.sent.set(acknowledgedId, { ...substitute, id: acknowledgedId })
  const settled = {
    responseStatus: 'accepted',
    sentResponseStatus: 'accepted',
    responsePending: false,
    canRespond: true,
  }
  expect(await read()).toMatchObject(settled)
  const afterRecovery = restart()
  expect(await afterRecovery.read()).toMatchObject(settled)
  expect(await afterRecovery.respond('accepted')).toMatchObject({ outcome: 'unchanged' })

  // Only the confirmed A can anchor a later answer to the vanished REQUEST.
  // The indexed substitute must not have left independent parent proof.
  state.messages = [
    gmailMessage('redelivery', 700, invite('REQUEST', '', 3, '20240702T090000Z')),
    { ...acceptedReply('<update@example.net>'), internalDate: '1200' },
  ]
  expect(await afterRecovery.read()).toMatchObject(settled)
  state.sent.delete(acknowledgedId)
  state.sent.set(otherId, substitute)
  expect(await restart().read()).toMatchObject({
    responseStatus: null,
    sentResponseStatus: null,
    canRespond: false,
  })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('blocks an acknowledged Gmail reply while another thread claims its exact ID in Trash', async () => {
  const { state, read, respond, restart } = await rig()
  const colliderId = 'duplicate-reply'
  state.beforeSendAcknowledgement = async () => {
    const acknowledged = state.sent.get('reply-1')!
    state.sent.set(colliderId, {
      ...structuredClone(acknowledged),
      id: colliderId,
      threadId: 'separate-trashed-thread',
      labelIds: ['SENT', 'TRASH'],
    })
  }
  await read()
  const pending = {
    responseStatus: null,
    sentResponseStatus: null,
    responsePending: true,
    canRespond: false,
  }
  expect(await respond('accepted')).toMatchObject({
    channel: 'gmail',
    outcome: 'sent',
    refreshPending: true,
    invitation: pending,
  })
  const reopened = restart()
  expect(await reopened.read()).toMatchObject(pending)
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  state.sent.delete(colliderId)
  expect(await reopened.read()).toMatchObject({
    responseStatus: 'accepted',
    sentResponseStatus: 'accepted',
    responsePending: false,
    canRespond: true,
  })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('requires unique account-wide ownership before settling an in-thread Gmail receipt', async () => {
  const { state, read, respond, restart } = await rig()
  state.sendReplyMode = 'response-lost'
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'uncertain', refreshPending: true })
  const reply = state.sent.get('reply-1')!
  const rfcId = reply.payload.headers.find(({ name }) => name === 'Message-ID')!.value
  const plain = gmailMessage('plain-sent', 700, undefined, {
    sent: true,
    rfcId,
    threadId: 'another-thread',
  })
  state.sent.set(plain.id, plain)
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({
    responseStatus: null,
    sentResponseStatus: null,
    responsePending: true,
    canRespond: false,
  })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  state.sent.delete(plain.id)
  expect(await reopened.read()).toMatchObject({
    responseStatus: 'accepted',
    responsePending: false,
    canRespond: true,
  })
  expect(await reopened.respond('accepted')).toMatchObject({ outcome: 'unchanged' })

  // Losing unique ownership after confirmation does not erase the dispatch
  // or turn either the old answer or a different answer into a new send.
  state.sent.set(plain.id, plain)
  expect(await restart().read()).toMatchObject({ responseStatus: null, canRespond: false })
  await expect(respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it.each([
  ['missing strict identity', 'UID:', 'UID;VALUE="TEXT",URI:', 500],
  ['contradictory PARTSTAT', 'PARTSTAT=DECLINED:', 'PARTSTAT=ACCEPTED;PARTSTAT=DECLINED:', 700],
] as const)(
  'keeps a write reserved and blocks each candidate scope of a known Sent parent with %s',
  async (_defect, before, after, timestamp) => {
    const { state, read, respond, restart } = await rig()
    const parent = '<update@example.net>'
    const other = invite().replace('folded-uid', 'other-event')
    state.messages[0]!.payload.parts.push(gmailMessage('part', 200, other).payload.parts[1]!)
    state.messages.push(acceptedReply(parent))
    state.replyThread = 'separate-sent-thread'
    state.sentVisible = false
    state.sentInternalDate = 500
    expect(await read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
    expect(await respond('tentative')).toMatchObject({ outcome: 'sent', refreshPending: true })

    const decline = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
    state.messages.push(
      gmailMessage('unreadable', timestamp, decline.replace(before, after), {
        sent: true,
        parent,
        method: 'REPLY',
      }),
      gmailMessage('ordinary-sent', 1000, undefined, { sent: true, parent }),
    )
    state.sentVisible = true
    const reopened = restart()
    const blocked = {
      recordedResponseStatus: null,
      responseStatus: null,
      sentResponseStatus: null,
      canRespond: false,
      unavailableReason: expect.stringMatching(/Gmail.*verify/i),
    }
    expect((await reopened.list()).invitations).toMatchObject([
      { ...blocked, identity: { uid }, responsePending: true },
      { ...blocked, identity: { uid: uid.replace('folded-uid', 'other-event') } },
    ])
    expect(await reopened.read()).toMatchObject({ ...blocked, responsePending: true })
    await expect(reopened.respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const independent = gmailMessage('independent', 900, decline, { sent: true, parent })
    state.messages.push(
      independent,
      gmailMessage('competing-id', 910, undefined, { rfcId: '<independent@example.net>' }),
    )
    expect(await reopened.read()).toMatchObject({ ...blocked, responsePending: true })
    state.messages.pop()
    expect(await reopened.read()).toMatchObject({
      responseStatus: 'declined',
      sentResponseStatus: 'declined',
      responsePending: false,
      canRespond: true,
    })
    expect(await reopened.respond('declined')).toMatchObject({ outcome: 'unchanged' })
    expect(
      (await reopened.list()).invitations.find((card) => card.identity.uid !== uid),
    ).toMatchObject(blocked)
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarPatchAttempts).toBe(0)
  },
)

it('reports the Calendar answer and the Gmail verification reason for a contested dispatch', async () => {
  const { state, read, respond, restart } = await rig()
  state.replyThread = 'separate-sent-thread'
  state.sendReplyMode = 'response-lost'
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'uncertain', channel: 'gmail' })
  const rfcId = state.sent
    .get('reply-1')!
    .payload.headers.find(({ name }) => name === 'Message-ID')!.value
  const duplicate = gmailMessage('plain-claimant', 600, undefined, {
    sent: true,
    rfcId,
    threadId: 'another-thread',
  })
  state.sent.set(duplicate.id, duplicate)
  const copy = { ...event(), etag: 'W/"read-only"' }
  state.events.set('primary', [copy])
  const reopened = restart()
  const unsettled = {
    recordedResponseStatus: 'declined',
    responseStatus: null,
    sentResponseStatus: null,
    responsePending: true,
    canRespond: false,
    unavailableReason: expect.stringMatching(/Gmail.*verify/i),
  }
  expect(await reopened.read()).toMatchObject(unsettled)
  await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await reopened.read()).toMatchObject(unsettled)
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('keeps a confirmed dispatch unresolved after a parent collision until independent newer Sent proof', async () => {
  const { state, read, respond, restart } = await rig()
  state.replyThread = 'separate-thread'
  state.sentInternalDate = 600
  await read()
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'gmail',
    refreshPending: false,
    invitation: { responseStatus: 'accepted', sentResponseStatus: 'accepted' },
  })

  state.messages.push(
    gmailMessage('redelivery', 650, invite('REQUEST', '', 3, '20240702T090000Z')),
    gmailMessage('plain-claim', 660, undefined, { rfcId: '<update@example.net>' }),
  )
  const reopened = restart()
  const blocked = {
    identity: { messageId: 'redelivery' },
    canRespond: false,
    responseStatus: null,
    sentResponseStatus: null,
    unavailableReason: expect.stringMatching(/Gmail.*verify/i),
  }
  expect(await reopened.read()).toMatchObject(blocked)
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await reopened.read()).toMatchObject(blocked)
  expect(state.sendAttempts).toBe(1)

  const decline = gmailMessage(
    'external-decline',
    600,
    invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
    { sent: true, parent: '<redelivery@example.net>', method: 'REPLY' },
  )
  state.messages.push(decline)
  // Even if the separately filed original receipt disappears, a tie cannot
  // settle the dispute and a later independently owned reply can.
  state.sentVisible = false
  expect(await reopened.read()).toMatchObject(blocked)
  decline.internalDate = '700'
  state.messages.push(
    gmailMessage('competing-reply-id', 710, undefined, { rfcId: '<external-decline@example.net>' }),
  )
  expect(await reopened.read()).toMatchObject(blocked)
  state.messages.pop()
  expect(await reopened.read()).toMatchObject({
    responseStatus: 'declined',
    sentResponseStatus: 'declined',
    canRespond: true,
  })
  expect(await reopened.respond('declined')).toMatchObject({ outcome: 'unchanged' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('cannot order a competing Sent answer against a receipt with a malformed Gmail timestamp', async () => {
  const { state, read, respond, list } = await rig()
  state.replyThread = 'separate-sent-thread'
  state.sendReplyMode = 'empty' // Recover through the exact RFC Message-ID index.
  state.sentInternalDate = 501
  await read()
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', refreshPending: false })
  const receipt = state.sent.get('reply-1')!
  receipt.internalDate = '0x1f5'
  state.messages.push(
    gmailMessage(
      'newer-decline',
      700,
      invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
      { sent: true, parent: '<update@example.net>', method: 'REPLY' },
    ),
  )
  expect(await list()).toMatchObject({
    invitations: [],
    recoveryReason: expect.stringMatching(/Gmail.*full message/i),
  })
  receipt.internalDate = '501'
  expect(await read()).toMatchObject({ responseStatus: 'declined', sentResponseStatus: 'declined' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it.each([
  'missing stamp',
  'invalid stamp',
  'duplicate stamp',
  'text organizer',
  'text attendee',
  'duplicate organizer VALUE (TEXT first)',
  'duplicate organizer VALUE (TEXT last)',
  'duplicate attendee VALUE (TEXT first)',
  'duplicate attendee VALUE (TEXT last)',
  'duplicate From',
  'duplicate To',
  'unclosed From comment',
  'unclosed To comment',
  'unclosed quote',
  'unclosed angle',
  'trailing address junk',
])('does not replace a confirmed answer with a newer Sent REPLY with %s', async (defect) => {
  const { state, read, respond } = await rig()
  await read()
  expect(await respond('accepted')).toMatchObject({ channel: 'gmail', refreshPending: false })
  const stamp = 'DTSTAMP:20240701T090000Z\r\n'
  const valid = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
  const calendarDefects: Record<string, [string, string]> = {
    'missing stamp': [stamp, ''],
    'invalid stamp': [stamp, 'DTSTAMP:20240701T090000\r\n'],
    'duplicate stamp': [stamp, `${stamp}${stamp}`],
    'text organizer': ['ORGANIZER;', 'ORGANIZER;VALUE=TEXT;'],
    'text attendee': ['ATTENDEE;', 'ATTENDEE;VALUE=TEXT;'],
    'duplicate organizer VALUE (TEXT first)': [
      'ORGANIZER;',
      'ORGANIZER;value="TEXT";VALUE=CAL-ADDRESS;',
    ],
    'duplicate organizer VALUE (TEXT last)': [
      'ORGANIZER;',
      'ORGANIZER;value=CAL-ADDRESS;VALUE=TEXT;',
    ],
    'duplicate attendee VALUE (TEXT first)': [
      'ATTENDEE;',
      'ATTENDEE;value="TEXT";VALUE=CAL-ADDRESS;',
    ],
    'duplicate attendee VALUE (TEXT last)': ['ATTENDEE;', 'ATTENDEE;value=CAL-ADDRESS;VALUE=TEXT;'],
  }
  const calendarDefect = calendarDefects[defect]
  const source = calendarDefect ? valid.replace(...calendarDefect) : valid
  const newer = gmailMessage('newer-decline', 700, source, {
    sent: true,
    method: 'REPLY',
    parent: '<update@example.net>',
  })
  if (defect === 'duplicate From' || defect === 'duplicate To')
    newer.payload.headers.push({
      name: defect === 'duplicate From' ? 'from' : 'to',
      value: guest,
    })
  const malformed: Record<string, [string, string]> = {
    'unclosed From comment': ['From', `${person} (unclosed`],
    'unclosed To comment': ['To', `${organizer} (unclosed`],
    'unclosed quote': ['From', `"Me <${person}>`],
    'unclosed angle': ['To', `Host <${organizer}`],
    'trailing address junk': ['To', `${organizer};`],
  }
  const replacement = malformed[defect]
  if (replacement) {
    const [name, value] = replacement
    newer.payload.headers.find((header) => header.name === name)!.value = value
  }
  state.messages.push(newer)
  if (calendarDefect) {
    expect(await read()).toMatchObject({
      responseStatus: null,
      sentResponseStatus: null,
      canRespond: false,
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } else {
    expect(await read()).toMatchObject({
      responseStatus: 'accepted',
      sentResponseStatus: 'accepted',
    })
    expect(await respond('accepted')).toMatchObject({ outcome: 'unchanged', refreshPending: false })
  }
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
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

it('remembers an independently identified wrong-parent instance without authorizing it', async () => {
  const { state, read, respond, restart } = await rig()
  const secondary = 'secondary@example.com'
  state.secondaryCalendars.push({ id: secondary, selected: true, accessRole: 'writer' })
  state.messages = [
    gmailMessage(
      'update',
      200,
      invite().replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT'),
    ),
  ]
  const child = {
    ...event({ id: 'child', occurrence: true }),
    recurringEventId: 'different-parent',
  }
  state.events.set(secondary, [event({ id: 'series', series: true })])
  state.instances.set(secondary, [child])
  // A malformed /instances response, independent of what exact resource GETs return.
  state.rawInstancePage = { kind: 'calendar#events', accessRole: 'writer', items: [child] }
  const blocked = { scope: 'occurrence', canRespond: false, responseTargetKey: null }
  expect(await read()).toMatchObject(blocked)
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  state.rawInstancePage = null
  state.events.clear()
  const reopened = restart()
  expect(await reopened.read()).toMatchObject(blocked)
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.instances.clear()
  expect(await reopened.read()).toMatchObject({ canRespond: true })
  expect(await reopened.respond('accepted')).toMatchObject({ channel: 'gmail', outcome: 'sent' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('skips a cancelled original slot even when the expanded Calendar view still lists it', async () => {
  const { state, list, read, respond } = await rig()
  const room = 'https://meet.google.com/xyz-abcd-efg'
  const stale = upcomingInstance('moved', '2099-07-11', room)
  stale.originalStartTime = { dateTime: '2099-07-09T15:00:00Z' }
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  const master = event({ id: 'series', series: true })
  const series = gmailMessage('series', 400, seriesWithException())
  const request = movedRequest('20240701T090000Z', room)
  state.messages = [series, gmailMessage('old-occurrence', 200, request)]
  state.events.set('primary', [master])
  const cancelled = { ...stale, status: 'cancelled', sequence: 4, updated: '2024-06-01T09:00:00Z' }
  state.instances.set('primary', [cancelled, later])
  // Expanded and exact instances reads can see different provider revisions.
  const page = { kind: 'calendar#events' }
  state.expandedPages = [{ ...page, items: [stale] }]
  const first = await read(thread, 'series')
  expect(first).toMatchObject({ canRespond: true, conferenceUrl: null, htmlLink: master.htmlLink })
  expect((await list()).invitations).toMatchObject([
    { scope: 'series', canRespond: true, conferenceUrl: null, htmlLink: master.htmlLink },
    {
      scope: 'occurrence',
      cancelled: true,
      canRespond: false,
      conferenceUrl: null,
      htmlLink: null,
      responseTargetKey: null,
    },
  ])
  state.expandedPages = [
    { ...page, items: [stale], nextPageToken: '1' },
    { ...page, items: [later] },
  ]
  const nextLink = {
    conferenceUrl: later.hangoutLink,
    htmlLink: later.htmlLink,
    responseTargetKey: first!.responseTargetKey,
  }
  expect(await read(thread, 'series')).toMatchObject(nextLink)
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
    invitation: { ...nextLink, recordedResponseStatus: 'accepted' },
  })
  expect(state.calendarUpdateRequests).toMatchObject([{ eventId: master.id, status: 'accepted' }])
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)

  state.messages.push(gmailMessage('reinstated', 300, request.replace('SEQUENCE:3', 'SEQUENCE:5')))
  // Even a larger expanded sequence isn't enough while the selected mailed
  // revision and the expanded material disagree.
  expect(await read(thread, 'series')).toMatchObject(nextLink)
  const live = { ...stale, sequence: 5 }
  state.instances.set('primary', [live, later])
  state.expandedPages = null
  expect((await list()).invitations).toMatchObject([
    {
      scope: 'series',
      canRespond: true,
      conferenceUrl: room,
      responseTargetKey: first!.responseTargetKey,
    },
    { scope: 'occurrence', cancelled: false, canRespond: true, conferenceUrl: room },
  ])
})

it('withholds an exact occurrence cancelled by newer Calendar evidence, but not after a newer REQUEST', async () => {
  const { state, read, respond } = await rig()
  const room = 'https://meet.google.com/abc-defg-hij'
  const page = 'https://calendar.google.com/calendar/event?eid=mailed'
  const request = (sequence: number, stamp: string) =>
    invite('REQUEST', '', sequence, stamp).replace(
      'END:VEVENT',
      `RECURRENCE-ID:20240711T150000Z\r\nURL:${page}\r\nEND:VEVENT`,
    )
  state.messages = [gmailMessage('update', 200, request(3, '20240701T090000Z'))]
  const child = {
    ...event({ id: 'instance', occurrence: true }),
    status: 'cancelled',
    sequence: 4,
    updated: '2024-06-01T09:00:00Z', // Not the organizer's revision timestamp.
    hangoutLink: room,
  }
  child.attendees[0]!.responseStatus = 'accepted'
  state.events.set('primary', [child])
  expect(await read()).toMatchObject({
    cancelled: true,
    canRespond: false,
    responseTargetKey: null,
    unavailableReason: expect.stringMatching(/cancel/i),
    conferenceUrl: null,
    htmlLink: null,
    responseStatus: null,
    recordedResponseStatus: null,
    sentResponseStatus: null,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  state.primaryPages = [{ kind: 'calendar#events', items: [{ ...child, iCalUID: undefined }] }]
  expect(await read()).toMatchObject({ cancelled: false, canRespond: false })
  state.primaryPages = null

  child.sequence = 3
  child.updated = '2024-07-19T09:00:00Z'
  state.messages.push(gmailMessage('reinstated', 300, request(4, '20240702T090000Z')))
  expect(await read()).toMatchObject({
    identity: { messageId: 'reinstated', sequence: 4 },
    cancelled: false,
    canRespond: false,
    responseTargetKey: null,
    conferenceUrl: room,
    htmlLink: page,
    recordedResponseStatus: null,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['single', 'series'] as const)(
  'withholds a %s REQUEST after a newer bound root cancellation, but not an older tombstone',
  async (scope) => {
    const { state, read, respond } = await rig()
    const room = 'https://meet.google.com/abc-defg-hij'
    const page = 'https://calendar.google.com/calendar/event?eid=mailed'
    const request = (sequence: number) =>
      invite('REQUEST', '', sequence).replace(
        'END:VEVENT',
        `${scope === 'series' ? 'RRULE:FREQ=WEEKLY\r\n' : ''}URL:${page}\r\nEND:VEVENT`,
      )
    state.messages = [gmailMessage('update', 200, request(3))]
    const root = {
      ...event(),
      status: 'cancelled',
      sequence: 4,
      updated: '2024-06-01T09:00:00Z',
      hangoutLink: room,
    }
    root.attendees[0]!.responseStatus = 'accepted'
    // A deleted master need not retain RRULE or its original interval.
    const { start: _start, end: _end, ...tombstone } = root
    state.primaryPages = [{ kind: 'calendar#events', items: [tombstone] }]
    const blocked = {
      scope,
      canRespond: false,
      responseTargetKey: null,
      responseStatus: null,
      recordedResponseStatus: null,
      sentResponseStatus: null,
    }
    expect(await read()).toMatchObject({
      ...blocked,
      cancelled: true,
      conferenceUrl: null,
      htmlLink: null,
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    state.primaryPages = [
      {
        kind: 'calendar#events',
        items: [{ ...tombstone, sequence: 3, summary: 'Different meeting details' }],
      },
    ]
    expect(await read()).toMatchObject({
      ...blocked,
      cancelled: false,
      conferenceUrl: null,
      htmlLink: null,
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    state.primaryPages = [
      { kind: 'calendar#events', items: [{ ...tombstone, organizer: { email: guest } }] },
    ]
    expect(await read()).toMatchObject({
      ...blocked,
      cancelled: false,
      conferenceUrl: room,
      htmlLink: page,
    })

    state.primaryPages = [
      { kind: 'calendar#events', items: [{ ...tombstone, updated: '2024-07-19T09:00:00Z' }] },
    ]
    state.messages.push(gmailMessage('reinstated', 300, request(5)))
    expect(await read()).toMatchObject({
      ...blocked,
      cancelled: false,
      conferenceUrl: room,
      htmlLink: page,
    })
    await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
  },
)

it('keeps series RSVP on the master while unexpanded exceptions suppress stale Join links', async () => {
  const { state, list, read, respond } = await rig()
  state.messages = [gmailMessage('series', 400, seriesWithException())]
  const master = event({ id: 'series', series: true })
  const stale = upcomingInstance('first', '2099-07-09', 'https://meet.google.com/xyz-abcd-efg')
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  const tombstone = { ...stale, status: 'cancelled', sequence: 4 }
  state.events.set('primary', [tombstone, master])
  state.instances.set('primary', [stale])
  expect((await list()).invitations).toMatchObject([
    {
      scope: 'series',
      cancelled: false,
      canRespond: true,
      conferenceUrl: null,
      htmlLink: master.htmlLink,
    },
  ])

  // Only actual mailbox evidence may suppress a live link. A secondary
  // calendar may name the mailbox as a guest without holding its self copy.
  const secondary = 'secondary@example.com'
  const unproven = { ...tombstone, attendees: [{ ...tombstone.attendees[0]!, self: false }] }
  state.secondaryCalendars.push({ id: secondary, selected: true, accessRole: 'writer' })
  state.events.delete('primary')
  state.events.set(secondary, [master, unproven])
  state.instances.set(secondary, [later, stale])
  expect(await read()).toMatchObject({ conferenceUrl: stale.hangoutLink, htmlLink: stale.htmlLink })
  state.events.set(secondary, [master, tombstone])
  expect(await read()).toMatchObject({ conferenceUrl: later.hangoutLink, htmlLink: later.htmlLink })
  expect(await respond('accepted')).toMatchObject({
    channel: 'calendar',
    outcome: 'sent',
    refreshPending: false,
    invitation: {
      scope: 'series',
      recordedResponseStatus: 'accepted',
      conferenceUrl: later.hangoutLink,
      htmlLink: later.htmlLink,
    },
  })
  expect(state.calendarUpdateRequests).toEqual([
    { calendar: secondary, eventId: master.id, sendUpdates: 'all', status: 'accepted' },
  ])
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)

  // An older exception isn't a substitute for proof of the live revision.
  tombstone.sequence = 2
  expect(await read()).toMatchObject({
    recordedResponseStatus: 'accepted',
    conferenceUrl: stale.hangoutLink,
    htmlLink: stale.htmlLink,
  })
})

it.each(['timed primary', 'all-day secondary'] as const)(
  'keeps a sparse %s tombstone out of series Join without blocking master RSVP',
  async (scenario) => {
    const { state, list, read, respond } = await rig()
    const allDay = scenario === 'all-day secondary'
    const calendar = allDay ? 'secondary@example.com' : 'primary'
    const master = event({ id: 'series', series: true, allDay })
    const room = 'https://meet.google.com/abc-defg-hij'
    const occurrence = (
      id: string,
      original: string,
      day: string,
      endDay: string,
      link: string,
    ) => ({
      ...upcomingInstance(id, day, link),
      originalStartTime: allDay ? { date: original } : { dateTime: `${original}T15:00:00Z` },
      start: allDay ? { date: day } : { dateTime: `${day}T15:00:00Z` },
      end: allDay ? { date: endDay } : { dateTime: `${day}T16:00:00Z` },
    })
    const stale = occurrence('moved', '2099-07-09', '2099-07-11', '2099-07-12', room)
    const later = occurrence(
      'later',
      '2099-07-16',
      '2099-07-16',
      '2099-07-17',
      'https://meet.google.com/klm-nopq-rst',
    )
    const tombstone = {
      id: stale.id,
      status: 'cancelled',
      recurringEventId: master.id,
      originalStartTime: allDay
        ? { date: '2099-07-09' }
        : { dateTime: '2099-07-09T11:00:00-04:00', timeZone: 'America/New_York' },
    }
    const source = seriesWithException()
    state.messages = [
      gmailMessage(
        'series',
        400,
        allDay
          ? source.replace(
              'DTSTART:20240718T150000Z\r\nDTEND:20240718T160000Z',
              'DTSTART;VALUE=DATE:20240718\r\nDTEND;VALUE=DATE:20240719',
            )
          : source,
      ),
    ]
    state.events.set(calendar, [master])
    if (allDay)
      state.secondaryCalendars.push({ id: calendar, selected: true, accessRole: 'writer' })
    const uidCollection = (items: unknown[]) => {
      if (allDay) state.secondaryUidItems.set(calendar, items)
      else state.primaryPages = [{ kind: 'calendar#events', items }]
    }
    state.instances.set(calendar, [stale])
    // The query's UID is not proof that a sparse row from another parent
    // belongs to this series, even at the same original slot.
    uidCollection([master, { ...tombstone, id: 'other-child', recurringEventId: 'other-parent' }])
    expect(await read()).toMatchObject({ conferenceUrl: room, htmlLink: stale.htmlLink })

    uidCollection([tombstone, master])
    expect((await list()).invitations).toMatchObject([
      {
        scope: 'series',
        cancelled: false,
        canRespond: true,
        conferenceUrl: null,
        htmlLink: master.htmlLink,
      },
    ])

    uidCollection([master, tombstone])
    state.instances.set(calendar, [later, stale])
    const next = { conferenceUrl: later.hangoutLink, htmlLink: later.htmlLink }
    expect(await read()).toMatchObject({ ...next, cancelled: false, canRespond: true })
    expect(await respond('accepted')).toMatchObject({
      channel: 'calendar',
      outcome: 'sent',
      refreshPending: false,
      invitation: {
        ...next,
        scope: 'series',
        cancelled: false,
        recordedResponseStatus: 'accepted',
      },
    })
    expect(state.calendarUpdateRequests).toEqual([
      { calendar, eventId: master.id, sendUpdates: 'all', status: 'accepted' },
    ])
    expect(state.calendarPatchAttempts).toBe(1)
    expect(state.sendAttempts).toBe(0)
  },
)

it('skips an original slot with a sparse instances tombstone in both the series card and RSVP readback', async () => {
  const { state, list, read, respond } = await rig()
  const master = event({ id: 'series', series: true })
  const room = 'https://meet.google.com/xyz-abcd-efg'
  const stale = {
    ...upcomingInstance('moved', '2099-07-11', room),
    originalStartTime: { dateTime: '2099-07-09T15:00:00Z' },
  }
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  const tombstone: SparseCancellation = {
    id: stale.id,
    status: 'cancelled',
    recurringEventId: master.id,
    originalStartTime: { dateTime: '2099-07-09T11:00:00-04:00' },
  }
  state.messages = [
    gmailMessage('series', 400, seriesWithException()),
    gmailMessage('old-occurrence', 200, movedRequest('20240701T090000Z', room)),
  ]
  // Unexpanded events.list exposes only the master; events.instances alone
  // exposes the tombstone. The expanded view still advertises the old room.
  state.events.set('primary', [master])
  state.sparseInstanceRows.set('primary', [tombstone])
  state.expandedPages = [
    { kind: 'calendar#events', items: [stale], nextPageToken: '1' },
    { kind: 'calendar#events', items: [later] },
  ]
  // Even an exact query must not associate a row from a different parent.
  state.rawInstancePage = {
    kind: 'calendar#events',
    items: [{ ...tombstone, recurringEventId: 'other-parent' }],
  }
  expect(await read(thread, 'series')).toMatchObject({
    conferenceUrl: room,
    htmlLink: stale.htmlLink,
  })
  state.rawInstancePage = null

  const safeLinks = { conferenceUrl: later.hangoutLink, htmlLink: later.htmlLink }
  expect((await list()).invitations).toMatchObject([
    { scope: 'series', ...safeLinks, cancelled: false, canRespond: true },
    {
      scope: 'occurrence',
      identity: { messageId: 'old-occurrence', recurrenceId: '2099-07-09T15:00:00.000Z' },
      cancelled: false,
      canRespond: false,
      responseStatus: null,
      recordedResponseStatus: null,
      responseTargetKey: null,
      conferenceUrl: null,
      htmlLink: null,
    },
  ])
  expect(await read(thread, 'series')).toMatchObject({ ...safeLinks, canRespond: true })
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
    refreshPending: false,
    invitation: {
      ...safeLinks,
      scope: 'series',
      responseStatus: 'accepted',
      recordedResponseStatus: 'accepted',
      responsePending: false,
    },
  })
  expect(state.calendarUpdateRequests).toEqual([
    { calendar: 'primary', eventId: master.id, sendUpdates: 'all', status: 'accepted' },
  ])
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)
})

it('uses a known occurrence resource’s sparse cancellation only to restrict series Join', async () => {
  const { state, read, respond } = await rig()
  const master = event({ id: 'series', series: true })
  const room = 'https://meet.google.com/xyz-abcd-efg'
  const stale = {
    ...upcomingInstance('moved', '2099-07-11', room),
    originalStartTime: { dateTime: '2099-07-09T15:00:00Z' },
  }
  state.events.set('primary', [master])
  state.instances.set('primary', [stale])
  state.messages = [
    gmailMessage('series', 400, seriesWithException()),
    gmailMessage('old-occurrence', 200, movedRequest('20240701T090000Z', room)),
  ]
  expect(await read(thread, 'occurrence')).toMatchObject({ canRespond: true, conferenceUrl: room })
  state.patchMode = 'response-lost'
  expect(await respond('accepted')).toMatchObject({ outcome: 'uncertain', refreshPending: true })

  // Only events.get sees the tombstone while checking the unresolved child
  // response. Neither unexpanded events.list nor events.instances expose it.
  state.patchMode = 'ok'
  state.instances.clear()
  state.primaryPages = [{ kind: 'calendar#events', items: [master] }]
  state.exactCalendarRows.set(
    'primary',
    new Map([
      [
        stale.id,
        {
          id: stale.id,
          status: 'cancelled',
          recurringEventId: master.id,
          originalStartTime: stale.originalStartTime,
        },
      ],
    ]),
  )
  state.expandedPages = [{ kind: 'calendar#events', items: [stale] }]
  const safeLinks = { conferenceUrl: null, htmlLink: master.htmlLink }
  expect(await read(thread, 'series')).toMatchObject({ ...safeLinks, canRespond: true })
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
    refreshPending: false,
    invitation: { ...safeLinks, responseStatus: 'accepted', responsePending: false },
  })
  expect(state.calendarUpdateRequests).toEqual([
    { calendar: 'primary', eventId: master.id, sendUpdates: 'all', status: 'accepted' },
  ])
  expect(state.sendAttempts).toBe(0)
})

it('compares a full known-resource tombstone for series Join without requiring a visible occurrence card', async () => {
  const { state, list, read, respond } = await rig()
  const master = event({ id: 'series', series: true })
  const room = 'https://meet.google.com/xyz-abcd-efg'
  const stale = {
    ...upcomingInstance('moved', '2099-07-11', room),
    originalStartTime: { dateTime: '2099-07-09T15:00:00Z' },
  }
  const later = upcomingInstance('later', '2099-07-16', 'https://meet.google.com/klm-nopq-rst')
  const series = gmailMessage('series', 400, seriesWithException())
  state.messages = [
    series,
    gmailMessage('old-occurrence', 200, movedRequest('20240701T090000Z', room)),
  ]
  state.events.set('primary', [master])
  state.instances.set('primary', [stale])
  // Learn the exact ID from a public read, without dispatching a child RSVP.
  expect(await read(thread, 'occurrence')).toMatchObject({ canRespond: true, conferenceUrl: room })

  // Only events.get sees the cancellation. The original REQUEST and exact
  // instance are omitted, but the expanded view still offers the stale room.
  state.messages = [series]
  state.instances.clear()
  const tombstone = {
    ...stale,
    recurringEventId: master.id,
    status: 'cancelled' as const,
    sequence: 4,
  }
  state.exactCalendarRows.set('primary', new Map([[stale.id, tombstone]]))
  state.expandedPages = [
    { kind: 'calendar#events', items: [stale], nextPageToken: '1' },
    { kind: 'calendar#events', items: [later] },
  ]
  const safeLinks = { conferenceUrl: later.hangoutLink, htmlLink: later.htmlLink }
  expect((await list()).invitations).toMatchObject([
    { scope: 'series', ...safeLinks, cancelled: false, canRespond: true },
  ])
  expect(await read(thread, 'series')).toMatchObject(safeLinks)
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
    refreshPending: false,
    invitation: {
      ...safeLinks,
      scope: 'series',
      cancelled: false,
      responseStatus: 'accepted',
      recordedResponseStatus: 'accepted',
      responsePending: false,
    },
  })
  expect(state.calendarUpdateRequests).toEqual([
    { calendar: 'primary', eventId: master.id, sendUpdates: 'all', status: 'accepted' },
  ])
  expect(state.calendarPatchAttempts).toBe(1)
  expect(state.sendAttempts).toBe(0)

  const reinstated = { ...stale, sequence: 5 }
  state.messages.push(
    gmailMessage(
      'reinstated',
      500,
      movedRequest('20240702T090000Z', room).replace('SEQUENCE:3', 'SEQUENCE:5'),
    ),
  )
  state.instances.set('primary', [reinstated])
  state.expandedPages[0] = { kind: 'calendar#events', items: [reinstated], nextPageToken: '1' }
  // The exact read still reports sequence 4. Only the verified new REQUEST
  // and current occurrence can restore the slot; the old tombstone can't win.
  expect(await read(thread, 'series')).toMatchObject({
    recordedResponseStatus: 'accepted',
    conferenceUrl: reinstated.hangoutLink,
    htmlLink: reinstated.htmlLink,
  })
  expect(await read(thread, 'occurrence')).toMatchObject({
    cancelled: false,
    canRespond: true,
    conferenceUrl: reinstated.hangoutLink,
    htmlLink: reinstated.htmlLink,
  })
})

it('includes hidden expanded invitations for REQUEST but not publications or exports', async () => {
  const { state, read } = await rig()
  const master = event({ id: 'series', series: true })
  const child = upcomingInstance(
    'hidden-child',
    '2099-07-09',
    'https://meet.google.com/xyz-abcd-efg',
  )
  master.attendees[0]!.responseStatus = 'accepted'
  child.attendees[0]!.responseStatus = 'accepted'
  state.events.set('primary', [master])
  state.instances.set('primary', [child])
  state.hiddenInvitationIds.add(child.id)
  state.messages = [gmailMessage('request', 200, seriesWithException())]
  expect(await read()).toMatchObject({
    scope: 'series',
    kind: 'invitation',
    canRespond: true,
    recordedResponseStatus: 'accepted',
    conferenceUrl: child.hangoutLink,
    htmlLink: child.htmlLink,
  })
  for (const method of ['METHOD:PUBLISH\r\n', '']) {
    state.messages = [
      gmailMessage('legacy', 300, seriesWithException().replace('METHOD:REQUEST\r\n', method)),
    ]
    expect(await read()).toMatchObject({
      scope: 'series',
      kind: 'meeting',
      canRespond: false,
      conferenceUrl: null,
      htmlLink: null,
    })
  }
})

it('requires a verified different parent before disregarding a possible Calendar series cancellation', async () => {
  const { state, read, respond, restart } = await rig()
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', 'RECURRENCE-ID:20240711T150000Z\r\nEND:VEVENT'),
  )
  const tombstone = { ...event({ id: 'old-series' }), status: 'cancelled', sequence: 2 }
  const instance = event({ id: 'listed-instance', occurrence: true })
  state.events.set('primary', [tombstone, instance])
  expect(await read()).toMatchObject({
    scope: 'occurrence',
    canRespond: false,
    conferenceUrl: null,
    htmlLink: null,
  })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })

  // The collection may hide the disputed rows without deleting their resources.
  state.primaryPages = [{ kind: 'calendar#events' }]
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ scope: 'occurrence', canRespond: false })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  state.primaryPages = null
  const currentParent = event({ id: 'series', series: true })
  state.events.set('primary', [tombstone, currentParent, instance])
  // A name match alone does not corroborate the original slot in the series.
  expect(await reopened.read()).toMatchObject({ scope: 'occurrence', canRespond: false })
  state.instances.set('primary', [instance])
  tombstone.sequence = identity.sequence
  expect(await reopened.read()).toMatchObject({ scope: 'occurrence', canRespond: false })
  await expect(reopened.respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)

  tombstone.sequence = identity.sequence - 1
  expect(await reopened.read()).toMatchObject({
    scope: 'occurrence',
    cancelled: false,
    canRespond: true,
    htmlLink: instance.htmlLink,
  })
  expect(await reopened.respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
    refreshPending: false,
  })
  expect(state.calendarUpdateRequests).toEqual([
    { calendar: 'primary', eventId: instance.id, sendUpdates: 'all', status: 'accepted' },
  ])
  expect(state.sendAttempts).toBe(0)
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
  expect(state.calendarUpdateRequests).toHaveLength(1)
  const zoned = (observances: string, stamp: string) =>
    invite(
      'REQUEST',
      [
        'DTSTART;TZID=America/New_York:20240118T110000',
        'DTEND;TZID=America/New_York:20240118T120000',
        'RRULE:FREQ=WEEKLY',
      ].join('\r\n'),
      3,
      stamp,
    ).replace(
      'BEGIN:VEVENT',
      [
        'BEGIN:VTIMEZONE',
        'TZID:America/New_York',
        observances,
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
      ].join('\r\n'),
    )
  const googleZone = zoned(
    [
      'BEGIN:DAYLIGHT',
      'DTSTART:19700308T020000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:19701101T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'END:STANDARD',
    ].join('\r\n'),
    '20240702T090000Z',
  )
  const fixed = zoned(
    [
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
    ].join('\r\n'),
    '20240703T090000Z',
  )
  state.messages[0] = gmailMessage('fixed', 300, fixed)
  expect(await read()).toMatchObject({
    scope: 'series',
    start: '2024-01-18T16:00:00.000Z',
    canRespond: false,
  })
  await expect(respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)

  state.messages[0] = gmailMessage('standard-zone', 400, googleZone)
  expect(await read()).toMatchObject({ scope: 'series', canRespond: true })
  expect(await respond('tentative')).toMatchObject({ channel: 'calendar', refreshPending: false })
  state.events.clear()
  expect(await read()).toMatchObject({ scope: 'series', canRespond: true })
  expect(await respond('declined')).toMatchObject({ channel: 'gmail', refreshPending: false })
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

it.each(['thread', 'separate-thread'])(
  'keeps the latest of seventeen same-lineage answers available for an explicit change (%s)',
  async (replyThread) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = replyThread
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
      invitation: { responseStatus: 'tentative' },
    })
    expect(state.sendAttempts).toBe(18)
    expect(state.calendarUpdateRequests).toHaveLength(0)
  },
)

it.each(['full message', 'exact Message-ID index'] as const)(
  'keeps a %s 503 local to the affected Gmail response',
  async (resource) => {
    const { state, read, respond, restart } = await rig()
    const other = gmailMessage('other', 100, invite().replace('folded-uid', 'other-uid'))
    const copy = { ...event(), iCalUID: uid.replace('folded-uid', 'other-uid') }
    state.events.set('primary', [copy])
    state.messages.push(other)
    state.replyThread = 'separate-thread'
    state.sentVisible = false
    expect(await read()).toMatchObject({ canRespond: true })
    expect(await respond('accepted')).toMatchObject({
      channel: 'gmail',
      outcome: 'sent',
      refreshPending: true,
    })

    const receipt = state.sent.get('reply-1')!
    const rfcId = receipt.payload.headers.find(({ name }) => name === 'Message-ID')!.value
    state.sentVisible = true
    if (resource === 'full message') state.receiptErrors.set(receipt.id, 503)
    else state.sentSearchErrors.set(`rfc822msgid:${rfcId.slice(1, -1)}`, 503)

    const reopened = restart()
    const pending = {
      responsePending: true,
      canRespond: false,
      responseStatus: null,
      sentResponseStatus: null,
    }
    // The other card is still readable; neither the index nor the full
    // envelope alone is enough to settle the pending response.
    const { invitations } = await reopened.list()
    expect(invitations).toHaveLength(2)
    expect(invitations.find(({ identity }) => identity.uid === uid)).toMatchObject(pending)
    const independent = invitations.find(({ identity }) => identity.uid === copy.iCalUID)!
    expect(independent).toMatchObject({ canRespond: true, recordedResponseStatus: 'declined' })
    expect(await reopened.read()).toMatchObject(pending)
    await expect(reopened.respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(
      await reopened.call('respondToMailInvitation', {
        ...thread,
        identity: independent.identity,
        expectedBindingRevision: independent.bindingRevision,
        expectedResponseTargetKey: independent.responseTargetKey,
        answer: 'tentative',
      }),
    ).toMatchObject({
      channel: 'calendar',
      outcome: 'sent',
      invitation: { recordedResponseStatus: 'tentative' },
    })
    state.receiptErrors.clear()
    state.sentSearchErrors.clear()
    const recovered = await reopened.list()
    expect(recovered.invitations.find(({ identity }) => identity.uid === uid)).toMatchObject({
      responsePending: false,
      canRespond: true,
      responseStatus: 'accepted',
      sentResponseStatus: 'accepted',
    })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarUpdateRequests).toMatchObject([{ eventId: copy.id, status: 'tentative' }])
  },
)

it.each([
  { receiptError: 403, sentSearchError: null, code: 'FORBIDDEN' },
  { receiptError: 429, sentSearchError: null, code: 'RATE_LIMITED' },
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
      ...(code === 'UNAUTHORIZED' || code === 'FORBIDDEN' ? { next: expect.any(String) } : {}),
    })
    await expect(respond('tentative')).rejects.toMatchObject({ code })
    state.receiptError = 404
    state.sentSearchError = null
    // The index may return a missing individual message, not a missing collection.
    expect(await reopened.read()).toMatchObject({ responsePending: true, canRespond: false })
    state.receiptError = null
    expect(await reopened.read()).toMatchObject({ responseStatus: 'accepted', canRespond: true })
    expect(state.sendAttempts).toBe(1)
    expect(state.calendarUpdateRequests).toHaveLength(0)
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
  const quoted = gmailMessage('quoted', 300, invite('REQUEST', '', 4)).payload
  quoted.parts.push(
    gmailMessage('cancelled', 300, invite('CANCEL', 'STATUS:CANCELLED', 4)).payload.parts[1]!,
  )
  const wrapped = {
    mimeType: 'application/octet-stream',
    filename: '',
    body: { size: 0, data: '' },
    headers: [
      {
        name: 'Content-Type',
        value: String.raw`(forwarded (with \) escape)) message/rfc822; name="Meeting (forwarded).eml"`,
      },
    ],
    parts: [quoted],
  }
  forward.payload.parts.push(wrapped)
  state.messages = [filenameLess, forward]
  expect(await hints()).toEqual([true, false])
  expect((await list()).invitations).toEqual([
    expect.objectContaining({
      canRespond: true,
      identity: expect.objectContaining({ messageId: 'header-only' }),
    }),
  ])

  const header = wrapped.headers[0]!
  const declared = header.value
  for (const contentType of ['(unclosed message/rfc822', 'application/octet-stream']) {
    header.value = contentType
    expect(await list()).toMatchObject({
      invitations: [],
      recoveryReason: expect.stringMatching(/MIME/),
    })
  }
  header.value = declared
  wrapped.mimeType = 'multipart/mixed'
  expect(await list()).toMatchObject({
    invitations: [],
    recoveryReason: expect.stringMatching(/conflicting MIME/),
  })
  wrapped.mimeType = 'application/octet-stream'

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

it.each(['thread', 'separate-thread'])(
  'discloses and resolves a Calendar disagreement with a verified reply in %s',
  async (replyThread) => {
    const { state, read, respond, restart } = await rig()
    state.replyThread = replyThread
    await read()
    expect(await respond('accepted')).toMatchObject({
      outcome: 'sent',
      channel: 'gmail',
      refreshPending: false,
      invitation: { recordedResponseStatus: null, sentResponseStatus: 'accepted' },
    })
    const copy = event()
    copy.attendees[0]!.responseStatus = 'tentative'
    state.events.set('primary', [copy])
    expect(await read()).toMatchObject({
      responseStatus: 'tentative',
      recordedResponseStatus: 'tentative',
      sentResponseStatus: 'accepted',
      canRespond: true,
      unavailableReason: null,
    })
    expect(await respond('tentative')).toMatchObject({
      outcome: 'unchanged',
      channel: 'calendar',
      refreshPending: false,
      invitation: { recordedResponseStatus: 'tentative', sentResponseStatus: 'accepted' },
    })
    expect(state.calendarPatchAttempts).toBe(0)
    expect(state.sendAttempts).toBe(1)

    const settled = {
      responseStatus: 'declined',
      recordedResponseStatus: 'declined',
      sentResponseStatus: null,
      canRespond: true,
      unavailableReason: null,
    }
    expect(await respond('declined')).toMatchObject({
      outcome: 'sent',
      channel: 'calendar',
      refreshPending: false,
      invitation: settled,
    })
    expect(await restart().read()).toMatchObject(settled)
    expect(state.calendarPatchAttempts).toBe(1)
    expect(state.calendarUpdateRequests).toEqual([
      { calendar: 'primary', eventId: copy.id, sendUpdates: 'all', status: 'declined' },
    ])
    expect(copy.attendees).toEqual(event().attendees)
    expect(state.sendAttempts).toBe(1)
  },
)

it('blocks a new Calendar response if the latest Sent answers are ambiguous', async () => {
  const { state, read, respond } = await rig()
  const copy = event()
  copy.attendees[0]!.responseStatus = 'tentative'
  state.events.set('primary', [copy])
  const parent = '<update@example.net>'
  const reply = invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:')
  state.messages.push(
    { ...acceptedReply(parent), internalDate: '500' },
    gmailMessage('competing-sent', 500, reply, { sent: true, parent }),
  )
  expect(await read()).toMatchObject({
    responseStatus: null,
    recordedResponseStatus: 'tentative',
    sentResponseStatus: null,
    canRespond: false,
    unavailableReason: expect.any(String),
  })
  await expect(respond('declined')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('leaves a Calendar write unsettled when a competing Sent answer appears in readback', async () => {
  const { state, read, respond } = await rig()
  state.events.set('primary', [event()])
  state.afterPatch = () => state.messages.push(acceptedReply('<update@example.net>'))
  await read()
  expect(await respond('tentative')).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
    refreshPending: true,
    invitation: {
      responseStatus: 'tentative',
      recordedResponseStatus: 'tentative',
      sentResponseStatus: 'accepted',
    },
  })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('reports tied Sent answers during Calendar readback without hiding the recorded answer', async () => {
  const { state, read, respond } = await rig()
  state.events.set('primary', [event()])
  const parent = '<update@example.net>'
  state.afterPatch = () =>
    state.messages.push(
      { ...acceptedReply(parent), internalDate: '500' },
      gmailMessage(
        'tied-decline',
        500,
        invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
        { sent: true, parent, method: 'REPLY' },
      ),
    )
  await read()
  expect(await respond('accepted')).toMatchObject({
    outcome: 'sent',
    channel: 'calendar',
    refreshPending: true,
    invitation: {
      responseStatus: null,
      recordedResponseStatus: 'accepted',
      sentResponseStatus: null,
      canRespond: false,
      unavailableReason: expect.stringMatching(/Gmail.*verify/i),
    },
  })
  expect(await read()).toMatchObject({ canRespond: false })
  await expect(respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('does not dispatch Calendar if final preflight finds the requested answer on its target', async () => {
  const { state, read, respond } = await rig()
  const copy = event()
  state.events.set('primary', [copy])
  expect(await read()).toMatchObject({ responseStatus: 'declined' })
  state.refreshOnPrimaryCopy = true
  state.onRefresh = async () => {
    copy.attendees[0]!.responseStatus = 'tentative'
    copy.etag = '"external-rsvp"'
  }
  expect(await respond('tentative')).toMatchObject({
    outcome: 'unchanged',
    channel: 'calendar',
    refreshPending: false,
    invitation: { responseStatus: 'tentative' },
  })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('uses a newer correlated Sent answer once a confirmed Calendar copy disappears', async () => {
  const { state, read, respond, restart } = await rig()
  const copy = event()
  copy.attendees[0]!.responseStatus = 'needsAction'
  state.events.set('primary', [copy])
  const older = acceptedReply('<update@example.net>')
  state.messages.push(older)
  expect(await read()).toMatchObject({
    canRespond: true,
    responseStatus: 'accepted',
    recordedResponseStatus: 'needsAction',
    sentResponseStatus: 'accepted',
  })
  expect(await respond('tentative')).toMatchObject({ channel: 'calendar', refreshPending: false })
  state.events.clear()
  const reopened = restart()
  expect(await reopened.read()).toMatchObject({ canRespond: true, responseStatus: 'tentative' })
  state.messages.push(
    gmailMessage(
      'newer-sent',
      700,
      invite('REPLY').replace('ATTENDEE:', 'ATTENDEE;PARTSTAT=DECLINED:'),
      { sent: true, parent: '<update@example.net>', method: 'REPLY' },
    ),
  )
  expect(await reopened.read()).toMatchObject({ canRespond: true, responseStatus: 'declined' })
  expect(await reopened.respond('declined')).toMatchObject({
    outcome: 'unchanged',
    channel: 'gmail',
  })
  expect(state.calendarUpdateRequests).toHaveLength(1)
  expect(state.sendAttempts).toBe(0)
})

it('applies attendee removal only to the connected guest, even for a series-wide removal', async () => {
  const { state, read, list, respond } = await rig()
  const slot = 'RECURRENCE-ID:20240718T150000Z'
  state.messages[0] = gmailMessage(
    'update',
    200,
    invite().replace('END:VEVENT', `${slot}\r\nEND:VEVENT`),
  )
  await read()
  expect(await respond('accepted')).toMatchObject({ outcome: 'sent', refreshPending: false })
  const cancel = invite('CANCEL', '', 4, '20240703T090000Z')
  state.messages.push(gmailMessage('other-removed', 300, cancel.replace(person, guest)))
  expect((await list()).invitations).toEqual([
    expect.objectContaining({
      scope: 'occurrence',
      cancelled: false,
      canRespond: true,
      responseStatus: 'accepted',
    }),
  ])
  state.messages.push(gmailMessage('self-removed', 400, cancel))
  expect(await read(thread, 'occurrence')).toMatchObject({ cancelled: true, canRespond: false })
  await expect(respond('tentative')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.sendAttempts).toBe(1)
  expect(state.calendarPatchAttempts).toBe(0)
})

it('does not answer for an owned secondary calendar address instead of the invited mailbox', async () => {
  const { state, read, respond } = await rig()
  const secondary = 'owned@example.com'
  const copy = event()
  copy.attendees[0]!.email = secondary
  state.hiddenCalendars = [secondary]
  state.events.set(secondary, [copy])
  expect(await read()).toMatchObject({ canRespond: false })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('compares fresh inline MIME bytes even when the message ID and part metadata are unchanged', async () => {
  const { state, read, respond } = await rig()
  const current = state.messages[0]!
  await read()
  state.refreshOnQuery = true
  state.onRefresh = async () => {
    current.payload.parts[1]!.body.data = wire(invite().replace('Upstairs', 'Basement'))
  }
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(await read()).toMatchObject({ location: 'Basement' })
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it('blocks contradictory MIME alternatives, but not independent mixed invitations or equivalent encodings', async () => {
  const { state, list, read, respond } = await rig()
  await read()
  const message = state.messages[0]!
  const second = (source: string) => gmailMessage('ignored', 100, source).payload.parts[1]!
  message.payload.parts.push(second(invite().replace('folded-uid', 'other-uid')))
  expect((await list()).invitations).toHaveLength(2)
  message.payload.mimeType = 'multipart/alternative'
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  await expect(respond('accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  message.payload.parts[2] = second(invite('REQUEST', '', 4))
  expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  const equivalent = second(invite().replaceAll('\r\n', '\n'))
  message.payload.parts[2] = equivalent
  equivalent.mimeType = 'application/ics'
  equivalent.headers!.push({ name: 'Content-Type', value: 'text/calendar' })
  expect((await list()).invitations).toEqual([expect.objectContaining({ canRespond: true })])
  equivalent.mimeType = 'text/plain'
  equivalent.filename = 'meeting.ics'
  equivalent.headers![0]!.value = 'text/plain'
  expect((await list()).invitations).toEqual([expect.objectContaining({ canRespond: true })])
  expect(state.calendarPatchAttempts + state.sendAttempts).toBe(0)
})

it.each(['depth', 'width', 'header count', 'header bytes'])(
  'rejects an oversized reader MIME projection (%s)',
  async (kind) => {
    const { state, list, call } = await rig()
    const { payload } = state.messages[0]!
    const part = payload.parts[0]!
    if (kind === 'header bytes')
      payload.headers.push({ name: 'X-Large', value: 'x'.repeat(64 * 1024) })
    else if (kind === 'header count')
      payload.headers.push(
        ...Array.from({ length: 200 }, (_, i) => ({ name: `X-${i}`, value: 'small' })),
      )
    else if (kind === 'width') payload.parts.push(...Array.from({ length: 2048 }, () => part))
    else {
      let nested = part
      for (let depth = 0; depth < 32; depth++) {
        const parent = { ...part, mimeType: 'multipart/mixed', parts: [nested] }
        nested = parent
      }
      payload.parts.push(nested)
    }
    await expect(call('thread', { id: 'thread' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await list()).toMatchObject({ invitations: [], recoveryReason: expect.any(String) })
  },
)
