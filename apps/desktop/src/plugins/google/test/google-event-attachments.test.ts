import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GoogleApi } from '../main/api'
import {
  attachEventFiles,
  checkEventFileAccess,
  driveFiles,
  eventAttachments,
} from '../main/event-attachments'
import { createPermissionReceipts } from '../main/permission-receipts'
import type { EventAttachment } from '../shared/event-attachments'

const target = {
  calendarId: 'organizer@example.com',
  eventId: 'event1',
  expectedAccountSub: '1234',
}
const organizer = { email: target.calendarId, self: true }
const file = (id: string) => ({
  kind: 'drive#file',
  id,
  name: `Drive file ${id}`,
  webViewLink: `https://docs.google.com/document/d/${id}/edit`,
  mimeType: 'application/vnd.google-apps.document',
  trashed: false,
  capabilities: { canShare: true },
})
const attachment = (id: string) => ({
  fileId: id,
  fileUrl: file(id).webViewLink,
  title: file(id).name,
  mimeType: file(id).mimeType,
})
const original = {
  fileUrl: 'https://example.com/agenda.pdf',
  title: 'Agenda',
  mimeType: 'application/pdf',
  iconLink: 'https://example.com/pdf-icon',
}
const solo = {
  kind: 'calendar#event',
  id: target.eventId,
  etag: '"1001"',
  status: 'confirmed',
  eventType: 'default',
  organizer,
  summary: 'Planning',
  description: 'Keep this',
  attachments: [original] as EventAttachment[],
}
const resource = { resource: true, email: 'room@example.com' }
const json = (body: unknown, status = 200) => Response.json(body, { status })
const validate = async () => {}

let userData: string
let receipts: ReturnType<typeof createPermissionReceipts>
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'holi-event-attachments-'))
  receipts = createPermissionReceipts(userData)
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

function transport(handle: (url: URL, request: RequestInit) => Response | Promise<Response>) {
  return new GoogleApi({
    accessToken: async () => 'synthetic-token',
    fetch: async (input, init) => handle(new URL(String(input)), init ?? {}),
  })
}

function calendarList(url: URL) {
  return (
    url.pathname === `/calendar/v3/users/me/calendarList/${encodeURIComponent(target.calendarId)}`
  )
}
function calendarEvent(url: URL) {
  return (
    url.pathname ===
    `/calendar/v3/calendars/${encodeURIComponent(target.calendarId)}/events/${target.eventId}`
  )
}

/** Calendar uses a quoted ETag and resolves the read-only Drive fileId from
 * the attachment URL, including in the result of a subsequent events.get. */
function patched(event: typeof solo, url: URL, init: RequestInit) {
  expect(new Headers(init.headers).get('If-Match')).toBe(event.etag)
  expect(Object.fromEntries(url.searchParams)).toEqual({
    supportsAttachments: 'true',
    sendUpdates: 'none',
  })
  const body = JSON.parse(String(init.body)) as { attachments: EventAttachment[] }
  expect(Object.keys(body)).toEqual(['attachments'])
  return {
    ...event,
    etag: '"1003"',
    attachments: body.attachments.map((item) => {
      const id = item.fileUrl.match(
        /^https:\/\/docs\.google\.com\/document\/d\/([^/]+)\/edit$/,
      )?.[1]
      return id ? { ...item, fileId: id } : item
    }),
  }
}

describe('Calendar attachments over Google transport', () => {
  it('shows an existing attachment and adds a Drive file to a solo event without notifying anyone', async () => {
    let event = solo
    const api = transport((url, req) => {
      if (calendarList(url) && !req.method)
        return json({ id: target.calendarId, accessRole: 'owner' })
      if (calendarEvent(url)) {
        if (req.method === 'PATCH') event = patched(event, url, req)
        return json(event)
      }
      if (url.pathname === '/drive/v3/files/selected' && !req.method) return json(file('selected'))
      throw new Error('Unexpected Google request')
    })
    await expect(eventAttachments(api, target, validate)).resolves.toEqual({
      canAttach: true,
      attachments: [original],
    })
    const result = await attachEventFiles(api, target, ['selected'], validate, { receipts })
    expect(result).toEqual({
      attachmentStatus: 'attached',
      attachments: [original, attachment('selected')],
      sharing: [],
      sharingComplete: true,
    })
    expect(event.description).toBe(solo.description)
  })

  it('re-merges a 412 without duplicates and shares only with the latest real guest', async () => {
    let event = { ...solo, attendees: [{ email: 'old@example.com' }] }
    const grants: Record<string, unknown>[] = []
    const api = transport((url, req) => {
      if (calendarList(url) && !req.method) return json({ accessRole: 'writer' })
      if (calendarEvent(url)) {
        if (req.method === 'PATCH') {
          if (event.etag === solo.etag) {
            event = {
              ...event,
              etag: '"1002"',
              attachments: [original, attachment('concurrent')],
              attendees: [
                organizer,
                resource,
                { email: 'new@example.com' },
                { email: 'leaving@example.com' },
              ],
            }
            return json({ error: { code: 412, message: 'Precondition Failed' } }, 412)
          }
          event = { ...event, ...patched(event, url, req) }
        }
        return json(event)
      }
      if (url.pathname === '/drive/v3/files/selected' && !req.method) return json(file('selected'))
      if (url.pathname === '/drive/v3/files/selected/permissions') {
        if (req.method === 'GET') {
          if (grants.length > 0) {
            event = { ...event, etag: '"1004"', attendees: [{ email: 'new@example.com' }] }
          }
          return json({ permissions: grants.map((grant) => ({ ...grant, id: 'new-permission' })) })
        }
        if (req.method === 'POST') {
          grants.push(JSON.parse(String(req.body)))
          return json({ id: 'new-permission' })
        }
      }
      throw new Error('Unexpected Google request')
    })
    const result = await attachEventFiles(api, target, ['selected', 'selected'], validate, {
      receipts,
    })
    expect(result).toMatchObject({
      attachmentStatus: 'attached',
      attachments: [original, attachment('concurrent'), attachment('selected')],
      sharingComplete: false,
      sharing: [
        { status: 'granted', fileId: 'selected', guest: 'new@example.com' },
        { status: 'failed', fileId: 'selected', guest: 'leaving@example.com' },
      ],
    })
    expect(grants).toEqual([{ type: 'user', role: 'reader', emailAddress: 'new@example.com' }])
  })

  it.each([
    { role: 'reader', change: {} },
    { role: 'writer', change: { organizer: { self: false } } },
    { role: 'owner', change: { attendeesOmitted: true } },
    { role: 'owner', change: { status: 'cancelled' } },
    { role: 'owner', change: { etag: '*' } },
    {
      role: 'owner',
      change: { attachments: Array.from({ length: 25 }, (_, i) => attachment(`existing_${i}`)) },
    },
  ])('refuses an unsafe or over-limit update (%j)', async ({ role, change }) => {
    const writes: string[] = []
    const api = transport((url, req) => {
      if (req.method) writes.push(req.method)
      if (calendarList(url)) return json({ accessRole: role })
      if (calendarEvent(url)) return json({ ...solo, ...change })
      return json(file('selected'))
    })
    const result = await attachEventFiles(api, target, ['selected'], validate, { receipts })
    expect(result).toMatchObject({ attachmentStatus: 'failed', sharing: [] })
    expect(result.attachments).toEqual(change.attachments ?? solo.attachments)
    expect(writes).toEqual([])
  })

  it('reads back a lost PATCH and reports partial attachment and sharing outcomes without replay', async () => {
    let event = {
      ...solo,
      attendees: [{ email: 'denied@example.com' }, { email: 'uncertain@example.com' }],
    }
    const patches: unknown[] = []
    const permissionCreates: string[] = []
    const api = transport((url, req) => {
      if (calendarList(url)) return json({ accessRole: 'owner' })
      if (calendarEvent(url)) {
        if (req.method === 'PATCH') {
          patches.push(req.body)
          event = { ...event, etag: '"1003"', attachments: [original, attachment('found')] }
          throw new Error('connection lost')
        }
        return json(event)
      }
      if (url.pathname.endsWith('/permissions') && req.method === 'GET')
        return json({ permissions: [] })
      if (url.pathname.endsWith('/permissions') && req.method === 'POST') {
        const guest = JSON.parse(String(req.body)).emailAddress as string
        permissionCreates.push(`${url.pathname}:${guest}`)
        if (guest === 'denied@example.com')
          return json({ error: { message: 'private details' } }, 403)
        throw new Error('connection lost')
      }
      return json(file(url.pathname.split('/').at(-1)!))
    })
    const result = await attachEventFiles(api, target, ['found', 'missing'], validate, { receipts })
    expect(result).toMatchObject({
      attachmentStatus: 'unknown',
      attachments: [original, attachment('found')],
      sharing: [
        { fileId: 'found', guest: 'denied@example.com', status: 'failed' },
        { fileId: 'found', guest: 'uncertain@example.com', status: 'unknown' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('private details')
    expect(patches).toHaveLength(1)
    expect(permissionCreates).toEqual([
      '/drive/v3/files/found/permissions:denied@example.com',
      '/drive/v3/files/found/permissions:uncertain@example.com',
    ])
  })
})

it('quotes the Drive search term, preserves pagination, and excludes unusable results', async () => {
  const api = transport((url) => {
    if (calendarList(url)) return json({ accessRole: 'owner' })
    if (calendarEvent(url)) return json(solo)
    expect(url.searchParams.get('q')).toContain(String.raw`name contains 'O\'Neil\\Draft'`)
    if (url.searchParams.get('pageToken') === 'next') return json({ files: [file('usable')] })
    return json({
      nextPageToken: 'next',
      files: [
        { ...file('folder'), mimeType: 'application/vnd.google-apps.folder' },
        { ...file('shortcut'), mimeType: 'application/vnd.google-apps.shortcut' },
        { ...file('trash'), trashed: true },
        { ...file('unshareable'), capabilities: { canShare: false } },
        { ...file('no_link'), webViewLink: undefined },
      ],
    })
  })
  const query = String.raw`O'Neil\Draft`
  const page = await driveFiles(api, target, query, undefined, validate)
  expect(page).toEqual({ files: [], nextPageToken: 'next' })
  await expect(driveFiles(api, target, query, page.nextPageToken, validate)).resolves.toEqual({
    files: [{ id: 'usable', name: file('usable').name, mimeType: file('usable').mimeType }],
  })
})

it('refuses a submitted shortcut without changing the event or creating permissions', async () => {
  const writes: string[] = []
  const api = transport((url, req) => {
    if (req.method === 'PATCH' || req.method === 'POST') writes.push(req.method)
    if (calendarList(url)) return json({ accessRole: 'owner' })
    if (calendarEvent(url)) return json(solo)
    return json({ ...file('shortcut'), mimeType: 'application/vnd.google-apps.shortcut' })
  })
  await expect(
    attachEventFiles(api, target, ['shortcut'], validate, { receipts }),
  ).resolves.toMatchObject({
    attachmentStatus: 'failed',
    attachments: [original],
    sharingComplete: false,
  })
  expect(writes).toEqual([])
})

it('does not replay an unverified permission and checks the current attachment and access without writing', async () => {
  const guest = 'verify@example.com'
  let event = { ...solo, attendees: [{ email: guest }] }
  const notifications: string[] = []
  let patches = 0
  let permissionVisible = false
  const api = transport((url, req) => {
    if (calendarList(url)) return json({ accessRole: 'owner' })
    if (calendarEvent(url)) {
      if (req.method === 'PATCH') {
        patches++
        event = { ...event, ...patched(event, url, req) }
      }
      return json(event)
    }
    if (url.pathname.endsWith('/permissions')) {
      if (req.method === 'POST') {
        notifications.push(JSON.parse(String(req.body)).emailAddress)
        // A write response does not establish that Drive's ACL has this guest.
        return json({ id: 'not-yet-visible' })
      }
      return json({
        permissions: permissionVisible
          ? [{ id: 'not-yet-visible', type: 'user', role: 'reader', emailAddress: guest }]
          : [],
      })
    }
    return json(file('uncertain'))
  })
  const submit = () => attachEventFiles(api, target, ['uncertain'], validate, { receipts })
  const check = () => checkEventFileAccess(api, target, ['uncertain'], validate, { receipts })
  for (const run of [submit, submit]) {
    await expect(run()).resolves.toMatchObject({
      attachmentStatus: 'attached',
      sharingComplete: false,
      sharing: [{ guest, status: 'unknown' }],
    })
  }
  const newGuest = 'not-shared@example.com'
  event = { ...event, attendees: [{ email: guest }, { email: newGuest }] }
  await expect(check()).resolves.toMatchObject({
    attachmentStatus: 'attached',
    sharingComplete: false,
    sharing: [
      { guest, status: 'unknown' },
      { guest: newGuest, status: 'failed' },
    ],
  })
  event = { ...event, attendees: [{ email: guest }] }
  permissionVisible = true
  await expect(check()).resolves.toMatchObject({
    attachmentStatus: 'attached',
    sharingComplete: true,
    sharing: [{ guest, status: 'already-accessible' }],
  })
  event = { ...event, attachments: [original] }
  await expect(check()).resolves.toMatchObject({
    attachments: [original],
    attachmentStatus: 'unknown',
    sharingComplete: false,
    sharing: [],
  })
  expect(patches).toBe(1)
  expect(notifications).toEqual([guest])
})

it.each([
  { attendees: [{ email: 'existing@example.com' }, { email: 'joined@example.com' }] },
  { attendeesOmitted: true },
])('reports incomplete access when the event changes during an ACL read (%j)', async (change) => {
  const guest = 'existing@example.com'
  let event = { ...solo, attachments: [attachment('in-change')], attendees: [{ email: guest }] }
  const notifications: unknown[] = []
  const api = transport((url, req) => {
    if (calendarList(url)) return json({ accessRole: 'owner' })
    if (calendarEvent(url)) return json(event)
    if (url.pathname.endsWith('/permissions')) {
      if (req.method === 'POST') notifications.push(req.body)
      event = { ...event, ...change }
      return json({ permissions: [{ type: 'user', emailAddress: guest, role: 'writer' }] })
    }
    return json(file('in-change'))
  })
  await expect(
    attachEventFiles(api, target, ['in-change'], validate, { receipts }),
  ).resolves.toMatchObject({
    attachmentStatus: 'attached',
    sharingComplete: false,
    message: expect.any(String),
    sharing: [{ guest, status: 'already-accessible' }],
  })
  expect(notifications).toEqual([])
})

it('preserves verified access and an uncertain POST at the deadline without attempting later guests', async () => {
  const guests = ['verified@example.com', 'in-flight@example.com', 'not-started@example.com']
  const event = {
    ...solo,
    attendees: guests.map((email) => ({ email })),
    attachments: [attachment('deadline')],
  }
  const deadline = new AbortController()
  const permissions: object[] = []
  const notifications: string[] = []
  const api = transport((url, req) => {
    if (calendarList(url)) return json({ accessRole: 'owner' })
    if (calendarEvent(url)) return json(event)
    if (url.pathname.endsWith('/permissions')) {
      if (req.method === 'GET') return json({ permissions })
      const body = JSON.parse(String(req.body))
      notifications.push(body.emailAddress)
      if (notifications.length === 2) {
        deadline.abort(new DOMException('Operation expired', 'TimeoutError'))
        return Promise.reject(req.signal?.reason)
      }
      permissions.push({ id: 'created', ...body })
      return json({ id: 'created' })
    }
    return json(file('deadline'))
  })
  await expect(
    attachEventFiles(api, target, ['deadline'], validate, { receipts, signal: deadline.signal }),
  ).resolves.toMatchObject({
    attachmentStatus: 'attached',
    sharingComplete: false,
    sharing: [
      { guest: guests[0], status: 'granted' },
      { guest: guests[1], status: 'unknown' },
      { guest: guests[2], status: 'failed' },
    ],
  })
  expect(notifications).toEqual(guests.slice(0, 2))
})
