/** Person-created meetings only. A submitted operation is immutable and recorded
 * before the POST, outside the vault. Reads never replay it. Event ids deduplicate
 * inserts; conference request ids alone do not. No queue or background sender.
 *
 * Google contracts: Calendar v3 events.insert (base32hex id, sendUpdates,
 * conferenceDataVersion), calendars.get (calendar.readonly already granted),
 * and conferenceProperties.allowedConferenceSolutionTypes. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { CapabilityError, paramsObject, stringParam } from '../../../main/plugin-api'
import { GoogleApi, GoogleApiError } from './api'
import type { GoogleAccountsManager } from './accounts'

const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary'

export interface MeetingInput {
  operation: string
  sub: string
  title: string
  start: string
  end: string
  allDay: boolean
  location: string
  guests: string[]
  meet: boolean
}

export interface MeetingOperation {
  input: MeetingInput
  eventId: string
  conferenceRequestId: string
  fingerprint: string
  attempts: number
  accepted: boolean
  dismissed?: boolean
  conference: 'none' | 'pending' | 'success' | 'failure'
  htmlLink: string | null
  conferenceUrl: string | null
}

export interface MeetingState {
  meetSupported: boolean
  operation: MeetingOperation | null
}

const bad = (message: string): never => {
  throw new CapabilityError('BAD_REQUEST', message)
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Narrow trusted shape; unknown fields can never reach events.insert. */
export function meetingParams(raw: unknown): MeetingInput {
  const p = paramsObject(raw)
  const operation = stringParam(p, 'operation')
  if (!uuid.test(operation)) bad('Invalid meeting operation.')
  const title = stringParam(p, 'title').trim()
  if (!title || title.length > 1000) bad('Give it a title (at most 1000 characters).')
  if (typeof p.allDay !== 'boolean' || typeof p.meet !== 'boolean') bad('Invalid meeting options.')
  const allDay = p.allDay as boolean
  const start = stringParam(p, 'start')
  const end = stringParam(p, 'end')
  for (const value of [start, end]) {
    const day = value.slice(0, 10)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day
    )
      bad('Invalid meeting date.')
    if (allDay) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        bad('Invalid meeting date.')
    } else if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      bad('Meeting times must include a timezone.')
    }
  }
  if (Date.parse(end) <= Date.parse(start)) bad('It has to end after it starts.')
  if (!Array.isArray(p.guests) || p.guests.length > 100) bad('Use at most 100 guest addresses.')
  const guests: string[] = []
  for (const rawAddress of p.guests as unknown[]) {
    if (typeof rawAddress !== 'string') bad('Guests must be email addresses.')
    const address = (rawAddress as string).trim().toLowerCase()
    const [local = '', domain = ''] = address.split('@')
    if (
      address.length > 254 ||
      local.length > 64 ||
      local.startsWith('.') ||
      local.endsWith('.') ||
      local.includes('..') ||
      domain.split('.').some((label) => label.length > 63) ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
        address,
      )
    ) {
      bad('Enter a valid email address for each guest.')
    }
    if (!guests.includes(address)) guests.push(address)
  }
  return {
    operation: operation.toLowerCase(),
    sub: stringParam(p, 'sub'),
    title,
    start,
    end,
    allDay,
    location: stringParam(p, 'location').trim(),
    guests: guests.sort(),
    meet: p.meet as boolean,
  }
}

function bodyOf(op: MeetingOperation) {
  const i = op.input
  const endpoint = (value: string) =>
    i.allDay ? { date: value } : { dateTime: value, timeZone: 'UTC' }
  return {
    id: op.eventId,
    summary: i.title,
    start: endpoint(i.start),
    end: endpoint(i.end),
    ...(i.location ? { location: i.location } : {}),
    ...(i.guests.length ? { attendees: i.guests.map((email) => ({ email })) } : {}),
    extendedProperties: { private: { holiMeeting: op.fingerprint } },
    ...(i.meet
      ? {
          conferenceData: {
            createRequest: {
              requestId: op.conferenceRequestId,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  }
}

interface CreatedEvent {
  id?: string
  summary?: string
  location?: string
  status?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  attendees?: { email?: string; self?: boolean }[]
  extendedProperties?: { private?: { holiMeeting?: string } }
  htmlLink?: string
  hangoutLink?: string
  conferenceData?: {
    createRequest?: { requestId?: string; status?: { statusCode?: string } }
    entryPoints?: { entryPointType?: string; uri?: string }[]
  }
}

function accept(op: MeetingOperation, event: CreatedEvent | null): boolean {
  if (
    !event ||
    event.id !== op.eventId ||
    event.status === 'cancelled' ||
    event.extendedProperties?.private?.holiMeeting !== op.fingerprint
  )
    return false
  const i = op.input
  const sameTime = (raw: string | undefined, expected: string) =>
    i.allDay ? raw === expected : Date.parse(raw ?? '') === Date.parse(expected)
  if (
    event.summary !== i.title ||
    (event.location ?? '') !== i.location ||
    !sameTime(event.start?.date ?? event.start?.dateTime, i.start) ||
    !sameTime(event.end?.date ?? event.end?.dateTime, i.end)
  )
    return false
  const guests = [
    ...new Set(
      (event.attendees ?? [])
        .filter((a) => !a.self || i.guests.includes(a.email?.toLowerCase() ?? ''))
        .map((a) => a.email?.toLowerCase()),
    ),
  ].sort()
  if (JSON.stringify(guests) !== JSON.stringify(i.guests)) return false
  op.accepted = true
  const safeUrl = (value: string | undefined, host: string) => {
    try {
      const u = new URL(value ?? '')
      return u.protocol === 'https:' && u.hostname === host ? u.href : null
    } catch {
      return null
    }
  }
  op.htmlLink =
    safeUrl(event.htmlLink, 'www.google.com') ?? safeUrl(event.htmlLink, 'calendar.google.com')
  if (i.meet) {
    const conference = event.conferenceData
    const code = conference?.createRequest?.status?.statusCode
    op.conferenceUrl = safeUrl(
      conference?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? event.hangoutLink,
      'meet.google.com',
    )
    op.conference = op.conferenceUrl ? 'success' : code === 'failure' ? 'failure' : 'pending'
  }
  return true
}

// Activations for different vaults share the same userData. Serialize by exact
// journal path even across those owners; unrelated accounts do not block each other.
const flights = new Map<string, Promise<unknown>>()
const submissions = new Map<string, { fingerprint: string; promise: Promise<MeetingOperation> }>()
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = flights.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(work)
  flights.set(key, next)
  try {
    return await next
  } finally {
    if (flights.get(key) === next) flights.delete(key)
  }
}

/** The consumed seam: state/recovery are read-only at Google; submit is the
 * sole outbound action. Clearing is allowed only once acceptance is known. */
export function createMeetingCreation(deps: {
  userData: string
  accounts: GoogleAccountsManager
  fetch?: typeof globalThis.fetch
}) {
  const pathFor = (remote: string, sub: string) =>
    join(deps.userData, 'google-meetings', `${hash(JSON.stringify([remote, sub]))}.json`)
  const boundApi = async (remote: string, sub: string): Promise<GoogleApi> => {
    const session = await deps.accounts.sessionFor(remote)
    if (!session || session.accountSub !== sub)
      throw new CapabilityError(
        'UNAUTHORIZED',
        'The Google account changed. Reopen the meeting in the original account.',
      )
    return new GoogleApi({
      fetch: deps.fetch,
      accessToken: async () => {
        const current = await deps.accounts.sessionFor(remote)
        if (!current || current.accountSub !== sub) throw new Error('The Google account changed.')
        return session.getAccessToken()
      },
    })
  }
  const read = async (path: string): Promise<MeetingOperation | null> => {
    try {
      const op = JSON.parse(await readFile(path, 'utf8')) as MeetingOperation
      const input = meetingParams(op.input)
      if (
        op.fingerprint !== hash(JSON.stringify(input)) ||
        op.eventId !== input.operation.replaceAll('-', '') ||
        !uuid.test(op.conferenceRequestId) ||
        typeof op.accepted !== 'boolean' ||
        !Number.isSafeInteger(op.attempts) ||
        op.attempts < 1 ||
        (op.dismissed !== undefined && (op.dismissed !== true || !op.accepted))
      )
        throw new Error('invalid journal')
      return op
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(
        'Could not read the submitted meeting. Do not recreate it; check Google Calendar.',
      )
    }
  }
  const write = async (path: string, op: MeetingOperation) => {
    await mkdir(join(deps.userData, 'google-meetings'), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomUUID()}.tmp`
    const file = await open(tmp, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(op))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  }
  const supported = async (api: GoogleApi) => {
    const calendar = await api.get<{
      conferenceProperties?: { allowedConferenceSolutionTypes?: string[] }
    }>(BASE)
    return (
      calendar.conferenceProperties?.allowedConferenceSolutionTypes?.includes('hangoutsMeet') ===
      true
    )
  }
  const recover = async (api: GoogleApi, path: string, op: MeetingOperation) => {
    try {
      const event = await api.get<CreatedEvent>(`${BASE}/events/${op.eventId}`)
      if (!accept(op, event))
        throw new Error(
          'The stored event does not match this meeting. Check Google Calendar; do not recreate it.',
        )
      await write(path, op)
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.status === 404)) throw error
      // Not found is not proof that an earlier POST did not reach Google.
      // Retain the operation; only an explicit submit may retry the same id.
    }
    return op
  }
  return {
    async state(remote: string, sub: string): Promise<MeetingState> {
      const path = pathFor(remote, sub)
      return serial(path, async () => {
        const api = await boundApi(remote, sub)
        const operation = await read(path)
        const meetSupported = await supported(api)
        await boundApi(remote, sub)
        return { meetSupported, operation: operation?.dismissed ? null : operation }
      })
    },
    async check(remote: string, sub: string): Promise<MeetingOperation | null> {
      const path = pathFor(remote, sub)
      return serial(path, async () => {
        const api = await boundApi(remote, sub)
        const op = await read(path)
        if (!op || op.dismissed) return null
        const result = await recover(api, path, op)
        await boundApi(remote, sub)
        return result
      })
    },
    async submit(remote: string, input: MeetingInput): Promise<MeetingOperation> {
      input = meetingParams(input)
      const path = pathFor(remote, input.sub)
      const fingerprint = hash(JSON.stringify(input))
      const active = submissions.get(path)
      if (active) {
        if (active.fingerprint !== fingerprint)
          throw new CapabilityError(
            'BAD_REQUEST',
            'A submitted meeting is unresolved. Check its status before creating another.',
          )
        return active.promise
      }
      // Serialization alone is not single-flight: after an unknown outcome a
      // queued double click would be a second POST. Share this exact result,
      // including uncertainty, with callers already overlapping this attempt.
      const promise = serial(path, async () => {
        const api = await boundApi(remote, input.sub)
        let op = await read(path)
        if (op?.dismissed && op.fingerprint !== fingerprint) op = null
        if (op && (op.fingerprint !== fingerprint || op.input.operation !== input.operation)) {
          throw new CapabilityError(
            'BAD_REQUEST',
            'A submitted meeting is unresolved. Check its status before creating another.',
          )
        }
        if (op) {
          op = await recover(api, path, op)
          if (op.accepted) {
            await boundApi(remote, input.sub)
            return op
          }
        }
        if (input.meet && !(await supported(api)))
          throw new CapabilityError(
            'BAD_REQUEST',
            'Google Meet is not supported by this primary calendar.',
          )
        op ??= {
          input,
          eventId: input.operation.replaceAll('-', ''),
          conferenceRequestId: randomUUID(),
          fingerprint,
          attempts: 0,
          accepted: false,
          conference: input.meet ? 'pending' : 'none',
          htmlLink: null,
          conferenceUrl: null,
        }
        op.attempts += 1
        await write(path, op)
        // No token/client can be resolved from a newly linked account.
        await boundApi(remote, input.sub)
        try {
          const event = await api.postJson<CreatedEvent>(
            `${BASE}/events?sendUpdates=${input.guests.length ? 'all' : 'none'}${input.meet ? '&conferenceDataVersion=1' : ''}`,
            bodyOf(op),
          )
          if (accept(op, event)) await write(path, op)
        } catch {
          // Timeout, 409 or any refusal: inspect the exact id, never insert a
          // second event. The original exception is not proof of non-delivery.
        }
        // Bounded read-only recovery, also covering malformed 2xx responses and
        // asynchronous conference creation. No timer, replay or new event id.
        if (!op.accepted || op.conference === 'pending') {
          try {
            await recover(api, path, op)
          } catch {
            /* remains recoverable */
          }
        }
        await boundApi(remote, input.sub)
        return op
      })
      submissions.set(path, { fingerprint, promise })
      try {
        return await promise
      } finally {
        if (submissions.get(path)?.promise === promise) submissions.delete(path)
      }
    },
    async finish(remote: string, sub: string, operation: string): Promise<void> {
      const path = pathFor(remote, sub)
      return serial(path, async () => {
        await boundApi(remote, sub)
        const op = await read(path)
        if (!op || op.input.operation !== operation || !op.accepted)
          throw new CapabilityError(
            'BAD_REQUEST',
            'Check the submitted meeting before dismissing it.',
          )
        op.dismissed = true
        await write(path, op)
      })
    },
  }
}

export type MeetingCreation = ReturnType<typeof createMeetingCreation>
