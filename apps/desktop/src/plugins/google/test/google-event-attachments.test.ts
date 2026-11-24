import { describe, expect, it } from 'vitest'
import { GoogleApi } from '../main/api'
import { attachEventFiles, driveFiles, eventAttachments } from '../main/event-attachments'
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

function transport(handle: (url: URL, request: RequestInit) => Response) {
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
    const result = await attachEventFiles(api, target, ['selected'], validate)
    expect(result).toEqual({
      attachmentStatus: 'attached',
      attachments: [original, attachment('selected')],
      sharing: [],
    })
    expect(event.description).toBe(solo.description)
  })

  it('re-merges a 412 without duplicates and shares only with the latest real guest', async () => {
    let event = { ...solo, attendees: [{ email: 'old@example.com' }] }
    const grants: unknown[] = []
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
          return json({ permissions: [] })
        }
        if (req.method === 'POST') {
          grants.push(JSON.parse(String(req.body)))
          return json({ id: 'new-permission' })
        }
      }
      throw new Error('Unexpected Google request')
    })
    const result = await attachEventFiles(api, target, ['selected', 'selected'], validate)
    expect(result).toMatchObject({
      attachmentStatus: 'attached',
      attachments: [original, attachment('concurrent'), attachment('selected')],
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
    const result = await attachEventFiles(api, target, ['selected'], validate)
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
    const result = await attachEventFiles(api, target, ['found', 'missing'], validate)
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
    expect(url.searchParams.get('q')).toContain(String.raw`name contains 'O\'Neil\\Draft'`)
    if (url.searchParams.get('pageToken') === 'next') return json({ files: [file('usable')] })
    return json({
      nextPageToken: 'next',
      files: [
        { ...file('folder'), mimeType: 'application/vnd.google-apps.folder' },
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
