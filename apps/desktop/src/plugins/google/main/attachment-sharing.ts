import type { AttachmentSharingResult } from '../shared/event-attachments'
import { GoogleApiError, isUncertainGoogleWrite, type GoogleApi } from './api'

const DRIVE = 'https://www.googleapis.com/drive/v3'
// Drive reports the effective role here, including permissions inherited from
// a parent. There is no reason to touch a sufficient existing grant.
const ACCESS_ROLES = new Set([
  'reader',
  'commenter',
  'writer',
  'organizer',
  'fileOrganizer',
  'owner',
])

type Validate = () => Promise<void>
type Permission = {
  type?: string
  emailAddress?: string
  role?: string
  deleted?: boolean
  expirationTime?: string
}
type Page = { permissions?: Permission[]; nextPageToken?: string }

async function permissions(api: GoogleApi, url: string, validate: Validate): Promise<Permission[]> {
  const all: Permission[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({
      fields: 'nextPageToken,permissions(emailAddress,type,role,deleted,expirationTime)',
      supportsAllDrives: 'true',
      pageSize: '100',
    })
    if (pageToken) query.set('pageToken', pageToken)
    const page = (await api.request('GET', `${url}?${query}`, undefined, validate)) as Page | null
    if (
      !page ||
      typeof page !== 'object' ||
      Array.isArray(page) ||
      (page.permissions !== undefined &&
        (!Array.isArray(page.permissions) ||
          page.permissions.some((permission) => typeof permission?.type !== 'string'))) ||
      (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string')
    )
      throw new Error('Could not read the file permissions.')
    all.push(...(page.permissions ?? []))
    pageToken = page.nextPageToken
    if (pageToken) {
      // Never create on an incomplete list: the next page may have a stronger grant.
      if (seen.has(pageToken) || seen.size >= 99) throw new Error('Incomplete file permissions.')
      seen.add(pageToken)
    }
  } while (pageToken)
  await validate()
  return all
}

function access(list: Permission[], guest: string): 'has-access' | 'absent' | 'unverified' {
  const now = Date.now()
  let unverified = false
  for (const permission of list) {
    if (permission.type !== 'user' || permission.deleted === true) continue
    const email = permission.emailAddress
    if (typeof email === 'string' && email.toLowerCase() !== guest.toLowerCase()) continue
    const expiry =
      permission.expirationTime === undefined ? Infinity : Date.parse(permission.expirationTime)
    if (expiry <= now) continue
    if (email && ACCESS_ROLES.has(permission.role ?? '') && expiry > now) return 'has-access'
    unverified = true
  }
  return unverified ? 'unverified' : 'absent'
}

function message(error?: unknown): string {
  return error instanceof GoogleApiError && error.status === 403
    ? 'Google denied permission to share this file.'
    : 'Could not confirm file access.'
}

/** Broadcast grants are never created or inferred. Each result describes one
 * Google Drive file and one Calendar guest, not a guess about group membership. */
export async function ensureGuestViewers(
  api: GoogleApi,
  fileIds: readonly string[],
  guests: readonly string[],
  validate: Validate,
  validateGuest: (guest: string, fileId: string) => Promise<void>,
): Promise<AttachmentSharingResult[]> {
  const results: AttachmentSharingResult[] = []
  for (const fileId of fileIds) {
    const url = `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions`
    for (const guest of guests) {
      const target = { fileId, guest }
      try {
        const existing = access(await permissions(api, url, validate), guest)
        if (existing === 'has-access') {
          results.push({ ...target, status: 'already-accessible' })
          continue
        }
        if (existing === 'unverified') {
          results.push({ ...target, status: 'unknown', message: message() })
          continue
        }
      } catch (error) {
        results.push({ ...target, status: 'failed', message: message(error) })
        continue
      }

      try {
        const permission = (await api.request(
          'POST',
          `${url}?supportsAllDrives=true&sendNotificationEmail=true&fields=id`,
          { type: 'user', role: 'reader', emailAddress: guest },
          async () => {
            await validate()
            await validateGuest(guest, fileId)
          },
        )) as { id?: string } | null
        if (typeof permission?.id === 'string' && permission.id) {
          results.push({ ...target, status: 'granted' })
          continue
        }
      } catch (error) {
        if (!isUncertainGoogleWrite(error)) {
          results.push({ ...target, status: 'failed', message: message(error) })
          continue
        }
      }

      // Do not replay a POST whose outcome is unknown. Read-back can confirm
      // access, not whether it was this particular POST that established it.
      const verified = await permissions(api, url, validate)
        .then((list) => access(list, guest) === 'has-access')
        .catch(() => false)
      results.push(
        verified
          ? { ...target, status: 'already-accessible' }
          : { ...target, status: 'unknown', message: message() },
      )
    }
  }
  return results
}
