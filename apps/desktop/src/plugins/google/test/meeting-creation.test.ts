import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import { createCapabilityRegistry, type Door } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import type { GoogleAccountsManager } from '../main/accounts'
import type { GoogleSession } from '../main/session'
import { GOOGLE_NAMESPACES, googleCapabilities } from '../main/capabilities'
import {
  createMeetingCreation,
  type MeetingInput,
  type MeetingOperation,
} from '../main/meeting-creation'

const input: MeetingInput = {
  operation: '11111111-1111-4111-8111-111111111111',
  sub: 'synthetic-a',
  title: 'Synthetic planning',
  start: '2027-01-12T10:00:00Z',
  end: '2027-01-12T11:00:00Z',
  allDay: false,
  location: 'Synthetic room',
  description: 'Agenda\nNext steps',
  guests: ['guest@example.com'],
  meet: false,
}
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function rig() {
  const userData = await mkdtemp(join(tmpdir(), 'holi-meeting-test-'))
  dirs.push(userData)
  const links: Record<string, string> = { 'owner/repo': input.sub, 'owner/other': input.sub }
  const legacy: Record<string, { accountSub: string; connectionId: string } | null> = {}
  const accounts = {
    legacyConnection: (remote: string) => legacy[remote] ?? null,
    sessionFor: async (remote: string) => {
      const sub = links[remote]
      return sub
        ? ({
            accountSub: sub,
            getAccessToken: async () => {
              const gate = tokenGate
              tokenGate = null
              if (gate) await gate()
              return `synthetic-token-${sub}`
            },
          } as GoogleSession)
        : null
    },
  } as GoogleAccountsManager
  let supported = true
  let conference: 'pending' | 'success' | 'failure' = 'success'
  let mode:
    | 'normal'
    | 'lost'
    | 'malformed'
    | 'conflict'
    | 'missing'
    | 'read-error'
    | 'refused-read-error'
    | 'mismatch'
    | 'refused' = 'normal'
  let postGate: (() => Promise<void>) | null = null
  let metadataGate: (() => void) | null = null
  let tokenGate: (() => Promise<void>) | null = null
  const events = new Map<string, Record<string, unknown>>()
  const calls: {
    method: string
    url: URL
    body: Record<string, unknown> | null
    token: string | null
  }[] = []
  const response = (event: Record<string, unknown>) => ({
    ...event,
    htmlLink: 'https://calendar.google.com/calendar/event?eid=synthetic',
    ...(event.conferenceData
      ? {
          conferenceData: {
            ...(event.conferenceData as object),
            createRequest: {
              ...(event.conferenceData as { createRequest: object }).createRequest,
              status: { statusCode: conference },
            },
            ...(conference === 'success'
              ? {
                  entryPoints: [
                    { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
                  ],
                }
              : {}),
          },
        }
      : {}),
  })
  const fetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ method, url: u, body, token: new Headers(init?.headers).get('Authorization') })
    if (u.pathname.endsWith('/primary')) {
      metadataGate?.()
      return Response.json({
        conferenceProperties: { allowedConferenceSolutionTypes: supported ? ['hangoutsMeet'] : [] },
      })
    }
    if (method === 'POST') {
      // The durable journal exists before any outbound send.
      const files = await readdir(join(userData, 'google-meetings'))
      const held = JSON.parse(
        await readFile(
          join(
            userData,
            'google-meetings',
            files.find((p) => p.endsWith('.json'))!,
          ),
          'utf8',
        ),
      ) as MeetingOperation
      expect(held.attempts).toBeGreaterThan(0)
      if (postGate) await postGate()
      if (mode === 'missing') throw new Error('Synthetic transport timeout')
      if (mode === 'refused' || mode === 'refused-read-error')
        return Response.json({ error: { message: 'Invalid location' } }, { status: 400 })
      events.set(String(body!.id), body!)
      if (mode === 'lost' || mode === 'read-error') throw new Error('Synthetic lost response')
      if (mode === 'conflict') return Response.json({}, { status: 409 })
      if (mode === 'malformed') return new Response('not JSON', { status: 200 })
      return Response.json(response(body!))
    }
    if (mode === 'read-error' || mode === 'refused-read-error')
      return Response.json({}, { status: 503 })
    const event = events.get(u.pathname.split('/').at(-1)!)
    if (!event) return Response.json({}, { status: 404 })
    if (mode === 'mismatch')
      return Response.json({ ...response(event), summary: 'Different event' })
    return Response.json(response(event))
  })
  const make = () => createMeetingCreation({ userData, accounts, fetch })
  let meetings = make()
  const registry = createCapabilityRegistry()
  const register = () =>
    registry.register(
      GOOGLE_NAMESPACES,
      googleCapabilities({
        accounts,
        meetings,
        dataFor: async () => null,
        settings: {
          read: async () => ({ calendars: {}, imageSenders: [], imagesFromAllSenders: false }),
          write: async () => {},
        },
      }),
    )
  register()
  const run = async (name: string, params: unknown, door: Door = 'ui', remote = 'owner/repo') =>
    (
      await registry.run(
        `google.${name}`,
        door,
        {
          remote,
          root: '',
          bundle: null,
          snapshot: async () => emptyVaultSnapshot(),
          claims: async () => [],
          core: noCoreServices(),
        },
        params,
      )
    ).value
  return {
    run,
    calls,
    events,
    links,
    legacy,
    make,
    meetings,
    accounts,
    userData,
    supported: (value: boolean) => {
      supported = value
    },
    mode: (value: typeof mode) => {
      mode = value
    },
    conference: (value: typeof conference) => {
      conference = value
    },
    metadataGate: (value: typeof metadataGate) => {
      metadataGate = value
    },
    tokenGate: (value: typeof tokenGate) => {
      tokenGate = value
    },
    gate: (value: typeof postGate) => {
      postGate = value
    },
  }
}

it('inserts primary invitations through the UI with exact query/body and separate stable ids', async () => {
  const r = await rig()
  const op = (await r.run('createMeeting', {
    ...input,
    meet: true,
    guests: [' Guest@Example.com ', 'guest@example.com'],
  })) as MeetingOperation
  const post = r.calls.find((c) => c.method === 'POST')!
  expect(post.url.pathname).toBe('/calendar/v3/calendars/primary/events')
  expect(post.url.searchParams.get('sendUpdates')).toBe('all')
  expect(post.url.searchParams.get('conferenceDataVersion')).toBe('1')
  expect(post.body).toEqual({
    id: input.operation.replaceAll('-', ''),
    summary: input.title,
    start: { dateTime: input.start, timeZone: 'UTC' },
    end: { dateTime: input.end, timeZone: 'UTC' },
    location: input.location,
    description: input.description,
    attendees: [{ email: 'guest@example.com' }],
    extendedProperties: { private: { holiMeeting: op.fingerprint } },
    conferenceData: {
      createRequest: {
        requestId: op.conferenceRequestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  })
  expect(op.eventId).toMatch(/^[0-9a-v]{32}$/)
  expect(op.eventId).not.toBe(op.conferenceRequestId)
  expect(op).toMatchObject({
    accepted: true,
    conference: 'success',
    attempts: 1,
    conferenceUrl: 'https://meet.google.com/abc-defg-hij',
  })
})

it('solo all-day creation is silent and omits attendees/conference data', async () => {
  const r = await rig()
  await r.run('createMeeting', {
    ...input,
    location: '',
    guests: [],
    allDay: true,
    start: '2027-01-12',
    end: '2027-01-13',
  })
  const post = r.calls.find((c) => c.method === 'POST')!
  expect(post.url.search).toBe('?sendUpdates=none')
  expect(post.body).toMatchObject({
    start: { date: '2027-01-12' },
    end: { date: '2027-01-13' },
    description: 'Agenda\nNext steps',
  })
  expect(post.body).not.toHaveProperty('attendees')
  expect(post.body).not.toHaveProperty('conferenceData')
})

it('refuses a retry whose description changes while the prior send is unresolved', async () => {
  const r = await rig()
  r.mode('missing')
  await r.meetings.submit('owner/repo', input)
  const posts = r.calls.filter((call) => call.method === 'POST').length
  await expect(
    r.make().submit('owner/repo', { ...input, description: 'Changed agenda' }),
  ).rejects.toThrow(/unresolved/)
  expect(r.calls.filter((call) => call.method === 'POST')).toHaveLength(posts)
})

it('keeps the description optional across an unresolved send and restart', async () => {
  const r = await rig()
  const withoutDescription = { ...input }
  delete withoutDescription.description
  r.mode('missing')
  const operation = await r.run('createMeeting', withoutDescription)
  const restarted = r.make()
  expect((await restarted.state('owner/repo', input.sub)).operation).toEqual(operation)
  r.mode('normal')
  expect(await restarted.submit('owner/repo', withoutDescription)).toMatchObject({ accepted: true })
  for (const post of r.calls.filter((call) => call.method === 'POST'))
    expect(post.body).not.toHaveProperty('description')
})

it('does not acknowledge a recovered event with a different description', async () => {
  const r = await rig()
  r.mode('missing')
  const operation = (await r.run('createMeeting', input)) as MeetingOperation
  const sent = r.calls.find((call) => call.method === 'POST')!.body!
  r.events.set(operation.eventId, { ...sent, description: 'Different details' })
  r.mode('normal')
  await expect(r.run('checkMeeting', { sub: input.sub })).rejects.toThrow(/does not match/)
  expect(r.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
})

it('refuses unsupported Meet before any send without requiring new OAuth scopes', async () => {
  const r = await rig()
  r.supported(false)
  await expect(r.run('createMeeting', { ...input, meet: true })).rejects.toThrow(/not supported/)
  expect(r.calls.every((c) => c.method === 'GET')).toBe(true)
  expect(await r.run('meetingState', { sub: input.sub })).toEqual({
    meetSupported: false,
    operation: null,
  })
})

it.each([
  { title: ' ' },
  { start: 'not a date' },
  { end: input.start },
  { guests: ['bad@example.com\r\nBcc:x@y.z'] },
  { guests: ['not-an-email'] },
  { meet: 'yes' },
  { allDay: true, start: '2027-02-30', end: '2027-03-05' },
  { operation: 'not-a-uuid' },
  { start: '2027-01-12T10:00:00' },
  { guests: Array(101).fill('a@example.com') },
])('validates before network writes: %j', async (patch) => {
  const r = await rig()
  await expect(r.run('createMeeting', { ...input, ...patch })).rejects.toThrow()
  expect(r.calls).toHaveLength(0)
})

it.each(['createMeeting', 'meetingState', 'checkMeeting', 'finishMeeting'])(
  'registry rejects both CLI and app doors for %s',
  async (name) => {
    const r = await rig()
    for (const door of ['cli', 'app'] as const) {
      await expect(r.run(name, input, door)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `no such method: google.${name}`,
      })
    }
    expect(r.calls).toHaveLength(0)
  },
)

it.each(['lost', 'malformed', 'conflict'] as const)(
  'reconciles %s without a duplicate invitation',
  async (mode) => {
    const r = await rig()
    r.mode(mode)
    expect(await r.run('createMeeting', input)).toMatchObject({ accepted: true, attempts: 1 })
    expect(await r.run('createMeeting', input)).toMatchObject({ accepted: true, attempts: 1 })
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  },
)

it('serializes overlapping identical submissions and refuses a changed intent', async () => {
  const r = await rig()
  const first = r.run('createMeeting', input)
  const second = r.run('createMeeting', input)
  const other = r.run('createMeeting', { ...input, title: 'Changed' })
  const rejected = expect(other).rejects.toThrow(/unresolved/)
  expect(await first).toMatchObject({ accepted: true })
  expect(await second).toMatchObject({ accepted: true })
  await rejected
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
})

it('clears a definite first refusal after exact-id 404 so corrected intent can be submitted', async () => {
  const r = await rig()
  r.mode('refused')
  await expect(r.run('createMeeting', input)).rejects.toThrow(/Invalid location/)
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  expect(
    ((await r.run('meetingState', { sub: input.sub })) as { operation: unknown }).operation,
  ).toBeNull()
  const restarted = r.make()
  r.mode('normal')
  const corrected = await restarted.submit('owner/repo', { ...input, title: 'Corrected' })
  expect(corrected).toMatchObject({ accepted: true, input: { title: 'Corrected' } })
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
})

it('persists a first refusal across transient recovery and releases it after restart and exact-id 404', async () => {
  const r = await rig()
  r.mode('refused-read-error')
  await expect(r.run('createMeeting', input)).rejects.toThrow(/Invalid location/)
  const firstPosts = r.calls.filter((c) => c.method === 'POST')
  expect(firstPosts).toHaveLength(1)
  const journal = JSON.parse(
    await readFile(
      join(r.userData, 'google-meetings', (await readdir(join(r.userData, 'google-meetings')))[0]!),
      'utf8',
    ),
  ) as MeetingOperation
  expect(journal).toMatchObject({ refused: true, attempts: 1 })

  const restarted = r.make()
  r.mode('normal')
  expect(await restarted.check('owner/repo', input.sub)).toBeNull()
  expect((await restarted.state('owner/repo', input.sub)).operation).toBeNull()
  const corrected = await restarted.submit('owner/repo', { ...input, title: 'Corrected' })
  expect(corrected).toMatchObject({ accepted: true, input: { title: 'Corrected' }, attempts: 1 })
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  expect(r.calls.filter((c) => c.method === 'POST')[1]!.body!.id).toBe(
    input.operation.replaceAll('-', ''),
  )
})

it('does not treat a later refusal after uncertain delivery as definitive', async () => {
  const r = await rig()
  r.mode('missing')
  const unresolved = (await r.run('createMeeting', input)) as MeetingOperation
  r.mode('refused')
  await r.run('createMeeting', input)
  const restarted = r.make()
  expect((await restarted.state('owner/repo', input.sub)).operation).toMatchObject({
    eventId: unresolved.eventId,
    attempts: 2,
  })
  await expect(restarted.submit('owner/repo', { ...input, title: 'Corrected' })).rejects.toThrow(
    /unresolved/,
  )
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
})

it('clears old refusal evidence before an explicit retry can become uncertain', async () => {
  const r = await rig()
  r.mode('refused-read-error')
  await expect(r.run('createMeeting', input)).rejects.toThrow(/Invalid location/)
  r.mode('missing')
  const retried = await r.run('createMeeting', input)
  expect(retried).toMatchObject({ accepted: false, attempts: 2 })
  const restarted = r.make()
  expect((await restarted.state('owner/repo', input.sub)).operation).toMatchObject({
    accepted: false,
    attempts: 2,
  })
  await expect(restarted.submit('owner/repo', { ...input, title: 'Corrected' })).rejects.toThrow(
    /unresolved/,
  )
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
})

it('persists unknown delivery across restart; recovery 404 never retries or clears it', async () => {
  const r = await rig()
  r.mode('missing')
  const op = (await r.run('createMeeting', input)) as MeetingOperation
  expect(op.accepted).toBe(false)
  const restarted = r.make()
  expect((await restarted.state('owner/repo', input.sub)).operation).toEqual(op)
  expect(await restarted.check('owner/repo', input.sub)).toEqual(op)
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  await expect(restarted.finish('owner/repo', input.sub, input.operation)).rejects.toThrow()
  await expect(
    restarted.submit('owner/repo', { ...input, operation: '22222222-2222-4222-8222-222222222222' }),
  ).rejects.toThrow(/unresolved/)
  r.mode('normal')
  const retried = await restarted.submit('owner/repo', input)
  expect(retried).toMatchObject({
    eventId: op.eventId,
    conferenceRequestId: op.conferenceRequestId,
    accepted: true,
    attempts: 2,
  })
  const posts = r.calls.filter((c) => c.method === 'POST')
  expect(posts[0]!.body).toEqual(posts[1]!.body)
})

it('recovers a legacy receipt only for its explicitly owned remote and current connection', async () => {
  const r = await rig()
  const oldSub = input.sub
  const currentId = 'opaque-current-connection'
  r.mode('read-error')
  const uncertain = (await r.run('createMeeting', input)) as MeetingOperation
  const oldPost = r.calls.find((call) => call.method === 'POST')!
  expect(uncertain.accepted).toBe(false)

  r.links['owner/repo'] = currentId
  r.legacy['owner/repo'] = { accountSub: oldSub, connectionId: currentId }
  const reconstructed = r.make()
  const before = r.calls.length
  expect((await reconstructed.state('owner/repo', currentId)).operation).toMatchObject({
    input: { sub: oldSub },
    fingerprint: uncertain.fingerprint,
    eventId: uncertain.eventId,
  })
  r.mode('normal')
  expect((await reconstructed.check('owner/repo', currentId))?.input.sub).toBe(oldSub)
  expect(r.calls.slice(before).filter((call) => call.method === 'POST')).toHaveLength(0)
  expect(
    r.calls
      .slice(before)
      .some((call) => call.url.pathname.endsWith(`/events/${uncertain.eventId}`)),
  ).toBe(true)
  expect(oldPost.body?.id).toBe(uncertain.eventId)
  expect(oldPost.body?.summary).toBe(input.title)

  const foreignBefore = r.calls.length
  await expect(reconstructed.state('owner/other', currentId)).rejects.toThrow()
  await expect(reconstructed.state('owner/repo', 'different-current-id')).rejects.toThrow()
  expect(r.calls.slice(foreignBefore)).toHaveLength(0)
})

it('read failures preserve the submitted operation and never automatically send', async () => {
  const r = await rig()
  r.mode('read-error')
  const op = await r.run('createMeeting', input)
  await expect(r.run('checkMeeting', { sub: input.sub })).rejects.toThrow()
  expect(
    ((await r.run('meetingState', { sub: input.sub })) as { operation: unknown }).operation,
  ).toEqual(op)
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
})

it('verifies operation and payload identity before acknowledging a recovered id', async () => {
  const r = await rig()
  r.mode('missing')
  const op = (await r.run('createMeeting', input)) as MeetingOperation
  r.events.set(op.eventId, { id: op.eventId, summary: input.title })
  await expect(r.run('checkMeeting', { sub: input.sub })).rejects.toThrow(/does not match/)
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
})

it.each(['pending', 'failure'] as const)(
  'distinguishes accepted event from %s Meet; checks never recreate it',
  async (status) => {
    const r = await rig()
    r.conference(status)
    const op = (await r.run('createMeeting', { ...input, meet: true })) as MeetingOperation
    expect(op).toMatchObject({ accepted: true, conference: status })
    expect(await r.run('checkMeeting', { sub: input.sub })).toMatchObject({
      accepted: true,
      conference: status,
    })
    r.conference('success')
    expect(await r.run('checkMeeting', { sub: input.sub })).toMatchObject({
      accepted: true,
      conference: 'success',
    })
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  },
)

it('refuses transport when the account relinks while the token getter is pending', async () => {
  const r = await rig()
  let release!: () => void
  r.tokenGate(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const pending = r.meetings.submit('owner/repo', input)
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(release).toBeTypeOf('function')
  r.links['owner/repo'] = 'synthetic-b'
  release()
  await expect(pending).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  expect(await r.make().state('owner/repo', 'synthetic-b')).toMatchObject({ operation: null })
})

it('binds tokens to the submitted account and refuses late results after relinking', async () => {
  const r = await rig()
  r.gate(async () => {
    r.links['owner/repo'] = 'synthetic-b'
  })
  await expect(r.run('createMeeting', input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect(r.calls.filter((c) => c.method === 'POST').map((c) => c.token)).toEqual([
    'Bearer synthetic-token-synthetic-a',
  ])
  await expect(r.run('createMeeting', input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect(
    ((await r.run('meetingState', { sub: 'synthetic-b' })) as { operation: unknown }).operation,
  ).toBeNull()
  r.links['owner/repo'] = input.sub
  expect(await r.run('checkMeeting', { sub: input.sub })).toMatchObject({ accepted: true })
  expect(
    (
      (await r.run('meetingState', { sub: input.sub }, 'ui', 'owner/other')) as {
        operation: unknown
      }
    ).operation,
  ).toBeNull()
})

it('dismisses only accepted intent; stale duplicate calls retain the event id', async () => {
  const r = await rig()
  const op = (await r.run('createMeeting', input)) as MeetingOperation
  await r.run('finishMeeting', { sub: input.sub, operation: input.operation })
  expect(
    ((await r.run('meetingState', { sub: input.sub })) as { operation: unknown }).operation,
  ).toBeNull()
  expect(await r.run('createMeeting', input)).toMatchObject({ eventId: op.eventId, accepted: true })
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
})

it('refuses an account relink during Meet preflight before sending', async () => {
  const r = await rig()
  r.metadataGate(() => {
    r.links['owner/repo'] = 'synthetic-b'
  })
  await expect(r.run('createMeeting', { ...input, meet: true })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
})

it('serializes different plugin owners sharing a journal path', async () => {
  const r = await rig()
  const secondOwner = r.make()
  await Promise.all([
    r.meetings.submit('owner/repo', input),
    secondOwner.submit('owner/repo', input),
  ])
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
})

it('coalesces overlapping uncertain submissions rather than treating a double click as a retry', async () => {
  const r = await rig()
  r.mode('missing')
  const otherOwner = r.make()
  const results = await Promise.all([
    r.run('createMeeting', input),
    r.run('createMeeting', input),
    otherOwner.submit('owner/repo', input),
  ])
  for (const result of results) expect(result).toMatchObject({ accepted: false, attempts: 1 })
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  r.mode('normal')
  expect(await r.run('createMeeting', input)).toMatchObject({ accepted: true, attempts: 2 })
  expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(2)
})
