import type { AttachmentSharingResult } from '../shared/event-attachments'
import type { GoogleApi } from './api'
import { GoogleApiError } from './api'

const DRIVE = 'https://www.googleapis.com/drive/v3'
const STRONG_ROLES = new Set([
  'reader',
  'commenter',
  'writer',
  'organizer',
  'fileOrganizer',
  'owner',
])

type Permission = {
  id?: string
  type?: string
  emailAddress?: string
  role?: string
  deleted?: boolean
  expirationTime?: string
}
type Page = { permissions?: Permission[]; nextPageToken?: string }

async function permissions(api: GoogleApi, fileId: string): Promise<Permission[]> {
  const all: Permission[] = []
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({
      fields: 'nextPageToken,permissions(id,emailAddress,type,role,deleted,expirationTime)',
      pageSize: '100',
    })
    if (pageToken) query.set('pageToken', pageToken)
    const page = (await api.request(
      'GET',
      `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?${query}`,
    )) as Page | null
    if (page?.permissions) all.push(...page.permissions)
    pageToken = page?.nextPageToken
  } while (pageToken)
  return all
}

function hasAccess(list: Permission[], guest: string): boolean {
  const now = Date.now()
  return list.some(
    (p) =>
      p.type === 'user' &&
      p.emailAddress?.toLowerCase() === guest.toLowerCase() &&
      !p.deleted &&
      STRONG_ROLES.has(p.role ?? '') &&
      (!p.expirationTime || Date.parse(p.expirationTime) > now),
  )
}

function message(error: unknown): string {
  return error instanceof GoogleApiError && error.status === 403
    ? 'Google denied permission to share this file.'
    : 'Could not confirm file access.'
}

export async function ensureGuestViewers(
  api: GoogleApi,
  fileIds: readonly string[],
  guests: readonly string[],
  validate: () => Promise<void>,
  validateGuest: (guest: string) => Promise<void>,
): Promise<AttachmentSharingResult[]> {
  const results: AttachmentSharingResult[] = []
  for (const fileId of fileIds)
    for (const guest of guests) {
      try {
        await validate()
        const existing = await permissions(api, fileId)
        if (hasAccess(existing, guest)) {
          results.push({ fileId, guest, status: 'already-accessible' })
          continue
        }
        try {
          await api.request(
            'POST',
            `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=true`,
            { type: 'user', role: 'reader', emailAddress: guest },
            async () => {
              await validate()
              await validateGuest(guest)
            },
          )
          results.push({ fileId, guest, status: 'granted' })
        } catch (error) {
          if (error instanceof GoogleApiError && error.status >= 400 && error.status < 500) {
            results.push({ fileId, guest, status: 'failed', message: message(error) })
            continue
          }
          try {
            if (hasAccess(await permissions(api, fileId), guest))
              results.push({ fileId, guest, status: 'already-accessible' })
            else results.push({ fileId, guest, status: 'unknown', message: message(error) })
          } catch {
            results.push({ fileId, guest, status: 'unknown', message: message(error) })
          }
        }
      } catch (error) {
        results.push({
          fileId,
          guest,
          status: error instanceof GoogleApiError ? 'failed' : 'unknown',
          message: message(error),
        })
      }
    }
  return results
}
