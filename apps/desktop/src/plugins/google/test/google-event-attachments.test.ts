import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GoogleApi } from '../main/api'
import { driveFiles } from '../main/drive-files'
import { attachEventFiles, checkEventFileAccess, eventAttachments } from '../main/event-attachments'
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
function calendarEvent(url: URL, eventId = target.eventId) {
  return (
    url.pathname ===
    `/calendar/v3/calendars/${encodeURIComponent(target.calendarId)}/events/${eventId}`
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
      calendarWriteStatus: 'confirmed',
      attachmentsVerified: true,
      attachments: [original, attachment('selected')],
      sharing: [],
      guestsChecked: [],
      sharingComplete: true,
    })
    expect(event.description).toBe(solo.description)
  })

  it.each([
    { snapshot: 'initial read', conflict: false, expectedPatches: 0 },
    { snapshot: '412 refetch', conflict: true, expectedPatches: 1 },
  ])(
    'refuses a matching URL-only attachment on the $snapshot',
    async ({ conflict, expectedPatches }) => {
      const { fileUrl, title, mimeType } = attachment('selected')
      const urlOnly = { fileUrl, title, mimeType }
      const currentAttachments = [original, urlOnly]
      let event = {
        ...solo,
        attachments: conflict ? solo.attachments : currentAttachments,
        attendees: [{ email: 'guest@example.com' }],
      }
      let patches = 0
      const permissionRequests: string[] = []
      const api = transport((url, req) => {
        if (calendarList(url)) return json({ accessRole: 'owner' })
        if (calendarEvent(url)) {
          if (req.method === 'PATCH') {
            patches++
            if (conflict && patches === 1) {
              event = { ...event, etag: '"1002"', attachments: currentAttachments }
              return json({ error: { code: 412, message: 'Precondition Failed' } }, 412)
            }
            event = { ...event, ...patched(event, url, req) }
          }
          return json(event)
        }
        if (url.pathname === '/drive/v3/files/selected' && !req.method)
          return json(file('selected'))
        if (url.pathname.endsWith('/permissions')) permissionRequests.push(req.method ?? 'GET')
        throw new Error('Unexpected Google request')
      })
      const result = await attachEventFiles(api, target, ['selected'], validate, { receipts })
      expect(result).toMatchObject({
        attachmentStatus: 'failed',
        calendarWriteStatus: 'not-written',
        attachmentsVerified: true,
        sharingComplete: false,
        sharing: [],
        message: expect.stringMatching(/without a usable Drive file ID/i),
      })
      expect(result.attachments).toEqual(currentAttachments)
      expect(event.attachments).toEqual(currentAttachments)
      expect(patches).toBe(expectedPatches)
      expect(permissionRequests).toEqual([])
    },
  )

  it('does not confirm presence or check access if Calendar saves only the URL', async () => {
    let event = { ...solo, attendees: [{ email: 'guest@example.com' }] }
    const permissionRequests: string[] = []
    const api = transport((url, req) => {
      if (calendarList(url)) return json({ accessRole: 'owner' })
      if (calendarEvent(url)) {
        if (req.method === 'PATCH') {
          // Calendar accepts the write but provides no resolved Drive ID.
          const { attachments } = JSON.parse(String(req.body)) as { attachments: EventAttachment[] }
          event = { ...event, etag: '"1002"', attachments }
        }
        return json(event)
      }
      if (url.pathname === '/drive/v3/files/selected' && !req.method) return json(file('selected'))
      if (url.pathname.endsWith('/permissions')) permissionRequests.push(req.method ?? 'GET')
      throw new Error('Unexpected Google request')
    })
    const result = await attachEventFiles(api, target, ['selected'], validate, { receipts })
    expect(result).toMatchObject({
      attachmentStatus: 'unknown',
      calendarWriteStatus: 'confirmed',
      attachmentsVerified: true,
      sharingComplete: false,
      sharing: [],
    })
    const { fileUrl, title, mimeType } = attachment('selected')
    expect(result.attachments).toEqual([original, { fileUrl, title, mimeType }])
    expect(permissionRequests).toEqual([])
  })

  it('re-merges a 412 without sharing the selection another writer attached', async () => {
    const occurrence = { ...target, eventId: 'series_20261124T100000Z' }
    let event = {
      ...solo,
      id: occurrence.eventId,
      recurringEventId: 'series',
      attendees: [{ email: 'old@example.com' }],
    }
    const grants: Record<string, unknown>[] = []
    const permissionCreates: string[] = []
    const api = transport((url, req) => {
      if (req.method === 'POST') permissionCreates.push(url.pathname)
      if (calendarList(url) && !req.method) return json({ accessRole: 'writer' })
      if (calendarEvent(url, occurrence.eventId)) {
        if (req.method === 'PATCH') {
          if (event.etag === solo.etag) {
            event = {
              ...event,
              etag: '"1002"',
              attachments: [original, attachment('concurrent')],
              description: 'Concurrent description',
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
      if (url.pathname === '/drive/v3/files/concurrent' && !req.method)
        return json(file('concurrent'))
      if (url.pathname === '/drive/v3/files/concurrent/permissions' && req.method === 'GET')
        return json({ permissions: [] })
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
    const result = await attachEventFiles(
      api,
      occurrence,
      ['concurrent', 'selected', 'selected'],
      validate,
      { receipts },
    )
    expect(result).toMatchObject({
      attachmentStatus: 'attached',
      calendarWriteStatus: 'confirmed',
      attachments: [original, attachment('concurrent'), attachment('selected')],
      guestsChecked: ['new@example.com'],
      sharingComplete: false,
      sharing: [
        { status: 'failed', fileId: 'concurrent', guest: 'new@example.com' },
        { status: 'failed', fileId: 'concurrent', guest: 'leaving@example.com' },
        { status: 'granted', fileId: 'selected', guest: 'new@example.com' },
        { status: 'failed', fileId: 'selected', guest: 'leaving@example.com' },
      ],
    })
    expect(event.description).toBe('Concurrent description')
    expect(permissionCreates).toEqual(['/drive/v3/files/selected/permissions'])
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
    expect(result).toMatchObject({
      attachmentStatus: 'failed',
      calendarWriteStatus: 'not-written',
      sharing: [],
    })
    expect(result.attachments).toEqual(change.attachments ?? solo.attachments)
    expect(writes).toEqual([])
  })

  it.each([
    { reply: '412 response to a stale write', concurrent: true },
    { reply: 'success response to our own write', concurrent: false },
  ])(
    'checks attachment presence and access without writing again after losing the $reply',
    async ({ concurrent }) => {
      const existing = 'existing@example.com'
      const withoutAccess = 'without-access@example.com'
      const selected = concurrent ? ['found', 'missing'] : ['found']
      let event = { ...solo, attendees: [{ email: existing }, { email: withoutAccess }] }
      const patchTags: Array<string | null> = []
      const permissionCreates: string[] = []
      const api = transport((url, req) => {
        if (calendarList(url)) return json({ accessRole: 'owner' })
        if (calendarEvent(url)) {
          if (req.method !== 'PATCH') return json(event)
          const ifMatch = new Headers(req.headers).get('If-Match')
          patchTags.push(ifMatch)
          if (concurrent && patchTags.length === 1) {
            event = { ...event, etag: '"1002"', attachments: [original, attachment('found')] }
          }
          const stale = ifMatch !== null && ifMatch !== event.etag
          if (!stale) event = { ...event, ...patched(event, url, req) }
          const reply = stale
            ? json({ error: { code: 412, message: 'Precondition Failed' } }, 412)
            : json(event)
          if (patchTags.length === 1) throw new Error('connection lost before receiving the reply')
          return reply
        }
        if (req.method === 'POST' && url.pathname.endsWith('/permissions')) {
          permissionCreates.push(url.pathname)
          return json({ error: { message: 'Permission denied' } }, 403)
        }
        if (req.method === 'GET' && url.pathname === '/drive/v3/files/found/permissions') {
          return json({
            permissions: [{ id: 'existing', type: 'user', emailAddress: existing, role: 'reader' }],
          })
        }
        const id = selected.find((id) => url.pathname === `/drive/v3/files/${id}`)
        if (id && !req.method) return json(file(id))
        throw new Error('Unexpected Google request')
      })
      const result = await attachEventFiles(api, target, selected, validate, { receipts })
      expect(result).toMatchObject({
        attachmentStatus: concurrent ? 'unknown' : 'attached',
        calendarWriteStatus: 'unknown',
        attachmentsVerified: true,
        attachments: [original, attachment('found')],
        sharingComplete: false,
        sharing: [
          { fileId: 'found', guest: existing, status: 'already-accessible' },
          { fileId: 'found', guest: withoutAccess, status: 'failed' },
        ],
      })
      expect(patchTags).toEqual([solo.etag])
      expect(permissionCreates).toEqual([])
    },
  )
})

it('quotes the Drive search term, preserves pagination, and excludes unusable results', async () => {
  const api = transport((url) => {
    expect(url.pathname).toBe('/drive/v3/files')
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
  const page = await driveFiles(api, query, undefined, validate)
  expect(page).toEqual({ files: [], nextPageToken: 'next' })
  await expect(driveFiles(api, query, page.nextPageToken, validate)).resolves.toEqual({
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
  const newGuest = 'not-shared@example.com'
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
        const recipient = JSON.parse(String(req.body)).emailAddress as string
        notifications.push(recipient)
        // A write response does not establish that Drive's ACL has this guest.
        return json({ id: 'not-yet-visible' })
      }
      return json({
        permissions: [
          ...(permissionVisible
            ? [{ id: 'not-yet-visible', type: 'user', role: 'reader', emailAddress: guest }]
            : []),
        ],
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
  event = { ...event, attendees: [{ email: guest }, { email: newGuest }] }
  await expect(check()).resolves.toMatchObject({
    attachmentStatus: 'attached',
    sharingComplete: false,
    sharing: [
      { guest, status: 'unknown' },
      { guest: newGuest, status: 'failed' },
    ],
  })
  expect(notifications).toEqual([guest])
  // Even after Drive acknowledged the original request, a stale attach
  // selection cannot send a grant to a new guest of an already-attached file.
  await expect(submit()).resolves.toMatchObject({
    attachmentStatus: 'attached',
    calendarWriteStatus: 'not-written',
    attachmentsVerified: true,
    attachments: [original, attachment('uncertain')],
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
  // The selected file was removed outside Holi; the current Calendar set is
  // authoritative even though it cannot confirm the old selection.
  event = { ...event, attachments: [original, attachment('replacement')] }
  const afterRemoval = await check()
  expect(afterRemoval).toMatchObject({
    attachments: [original, attachment('replacement')],
    attachmentsVerified: true,
    attachmentStatus: 'unknown',
    sharingComplete: false,
    guestsChecked: [guest],
    sharing: [],
  })
  expect(afterRemoval).not.toHaveProperty('calendarWriteStatus')
  expect(patches).toBe(1)
  expect(notifications).toEqual([guest])
})

it('reports a refused read-only Drive permissions check as an access-check failure', async () => {
  const guest = 'guest@example.com'
  const event = { ...solo, attachments: [attachment('selected')], attendees: [{ email: guest }] }
  const writes: string[] = []
  const api = transport((url, req) => {
    if (req.method && req.method !== 'GET') writes.push(req.method)
    if (calendarList(url)) return json({ accessRole: 'reader' })
    if (calendarEvent(url)) return json(event)
    if (url.pathname === '/drive/v3/files/selected/permissions' && req.method === 'GET') {
      return json(
        { error: { errors: [{ reason: 'insufficientPermissions' }], message: 'private details' } },
        403,
      )
    }
    throw new Error('Unexpected Google request')
  })
  const result = await checkEventFileAccess(api, target, ['selected'], validate, { receipts })
  expect(result).toMatchObject({
    attachmentsVerified: true,
    attachmentStatus: 'attached',
    reconnect: true,
    sharingComplete: false,
    sharing: [
      {
        fileId: 'selected',
        guest,
        status: 'failed',
        message: expect.stringMatching(/check access/i),
      },
    ],
  })
  expect(result.sharing[0]?.message).not.toMatch(/share|private details/i)
  expect(writes).toEqual([])
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
  const result = await attachEventFiles(api, target, ['in-change'], validate, { receipts })
  expect(result).toMatchObject({
    attachmentStatus: 'attached',
    calendarWriteStatus: 'not-written',
    attachmentsVerified: true,
    sharingComplete: false,
    message: expect.any(String),
    sharing: [{ guest, status: 'already-accessible' }],
  })
  if (change.attendeesOmitted) expect(result).not.toHaveProperty('guestsChecked')
  else expect(result.guestsChecked).toEqual([guest, 'joined@example.com'])
  expect(notifications).toEqual([])
})

it('preserves the Calendar write and guest access outcomes when Drive exhausts the deadline', async () => {
  const guests = ['verified@example.com', 'in-flight@example.com', 'not-started@example.com']
  let event = { ...solo, attendees: guests.map((email) => ({ email })) }
  const deadline = new AbortController()
  const permissions: object[] = []
  const notifications: string[] = []
  const api = transport((url, req) => {
    if (calendarList(url)) return json({ accessRole: 'owner' })
    if (calendarEvent(url)) {
      if (req.method === 'PATCH') event = { ...event, ...patched(event, url, req) }
      return json(event)
    }
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
    attachmentStatus: 'unknown',
    calendarWriteStatus: 'confirmed',
    attachmentsVerified: false,
    attachments: [],
    sharingComplete: false,
    sharing: [
      { guest: guests[0], status: 'granted' },
      { guest: guests[1], status: 'unknown' },
      { guest: guests[2], status: 'blocked' },
    ],
  })
  expect(notifications).toEqual(guests.slice(0, 2))
})
