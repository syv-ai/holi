import type { AttachmentSharingResult } from '../shared/event-attachments'
import {
  GoogleApiError,
  googleReconnectNeeded,
  isUncertainGoogleWrite,
  untilGoogleAbort,
  type GoogleApi,
} from './api'

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
  id?: string
  type?: string
  emailAddress?: string
  role?: string
  deleted?: boolean
  expirationTime?: string
}
type Page = { permissions?: Permission[]; nextPageToken?: string }

async function permissions(
  api: GoogleApi,
  url: string,
  { signal, validate }: SharingOptions,
): Promise<Permission[]> {
  const all: Permission[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({
      fields: 'nextPageToken,permissions(id,emailAddress,type,role,deleted,expirationTime)',
      supportsAllDrives: 'true',
      pageSize: '100',
    })
    if (pageToken) query.set('pageToken', pageToken)
    const page = (await api.request('GET', `${url}?${query}`, undefined, validate, {
      signal,
    })) as Page | null
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
  await untilGoogleAbort(signal, validate)
  return all
}

function access(list: Permission[], guest: string): Permission | 'absent' | 'unverified' {
  const now = Date.now()
  let unverified = false
  for (const permission of list) {
    if (permission.type !== 'user' || permission.deleted === true) continue
    const email = permission.emailAddress
    if (typeof email === 'string' && email.toLowerCase() !== guest.toLowerCase()) continue
    const expiry =
      permission.expirationTime === undefined ? Infinity : Date.parse(permission.expirationTime)
    if (expiry <= now) continue
    if (email && ACCESS_ROLES.has(permission.role ?? '') && expiry > now) return permission
    unverified = true
  }
  return unverified ? 'unverified' : 'absent'
}

function message(error?: unknown): string {
  return error instanceof GoogleApiError && error.status === 403
    ? 'Google denied permission to share this file.'
    : 'Could not confirm file access.'
}

type SharingOptions = {
  accountSub: string
  signal: AbortSignal
  validate: Validate
  /** Omit for an access check that never writes. */
  validateGuest?: (guest: string, fileId: string) => Promise<void>
}

// Drive forbids concurrent permission operations on one file, even across
// accounts. Keep the read, decision, create and read-back in the same queue.
const fileQueues = new Map<string, Promise<void>>()
const uncertainGrants = new Set<string>()

async function withFilePermissions(
  fileId: string,
  signal: AbortSignal,
  work: () => Promise<void>,
): Promise<void> {
  const previous = fileQueues.get(fileId) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => done)
  fileQueues.set(fileId, tail)
  void tail.then(() => {
    if (fileQueues.get(fileId) === tail) fileQueues.delete(fileId)
  })
  try {
    await untilGoogleAbort(signal, () => previous)
    signal.throwIfAborted()
    await work()
  } finally {
    // A cancelled waiter releases its own slot, not the one ahead of it.
    release()
  }
}

const grantKey = (accountSub: string, fileId: string, guest: string) =>
  JSON.stringify([accountSub, fileId, guest.toLowerCase()])

/** Broadcast grants are never created or inferred. Each result describes one
 * Google Drive file and one Calendar guest, not a guess about group membership. */
export async function ensureGuestViewers(
  api: GoogleApi,
  fileIds: readonly string[],
  guests: readonly string[],
  options: SharingOptions,
): Promise<{ sharing: AttachmentSharingResult[]; reconnect: boolean }> {
  const { signal, accountSub, validate, validateGuest } = options
  const sharing: AttachmentSharingResult[] = []
  let reconnect = false
  for (const fileId of fileIds) {
    if (!guests.length) break
    const url = `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions`
    let index = 0
    try {
      if (!reconnect && !signal.aborted) {
        await withFilePermissions(fileId, signal, async () => {
          let list: Permission[] | undefined
          for (; index < guests.length && !signal.aborted && !reconnect; index++) {
            const guest = guests[index]!
            const target = { fileId, guest }
            const key = grantKey(accountSub, fileId, guest)
            try {
              list ??= await permissions(api, url, options)
              const existing = access(list, guest)
              if (typeof existing !== 'string') {
                uncertainGrants.delete(key)
                sharing.push({ ...target, status: 'already-accessible' })
                continue
              }
              if (uncertainGrants.has(key) || existing === 'unverified') {
                sharing.push({ ...target, status: 'unknown', message: message() })
                continue
              }
              if (!validateGuest) {
                sharing.push({
                  ...target,
                  status: 'failed',
                  message: 'No viewer access was found.',
                })
                continue
              }

              let createdId: unknown
              try {
                const permission = (await api.request(
                  'POST',
                  `${url}?supportsAllDrives=true&sendNotificationEmail=true&fields=id`,
                  { type: 'user', role: 'reader', emailAddress: guest },
                  async () => {
                    await validateGuest(guest, fileId)
                    await validate()
                  },
                  { signal },
                )) as { id?: string } | null
                createdId = permission?.id
              } catch (error) {
                if (!isUncertainGoogleWrite(error)) throw error
              }

              // A successful response is not proof of the user's current role.
              // Keep the receipt until a read confirms access, including across
              // vaults, retries and reconnects for this account in this process.
              uncertainGrants.add(key)
              list = undefined
              list = await permissions(api, url, options)
              const verified = access(list, guest)
              if (typeof verified !== 'string') {
                uncertainGrants.delete(key)
                const matched =
                  typeof createdId === 'string' &&
                  verified.id === createdId &&
                  verified.role === 'reader'
                sharing.push({ ...target, status: matched ? 'granted' : 'already-accessible' })
              } else {
                sharing.push({ ...target, status: 'unknown', message: message() })
              }
            } catch (error) {
              reconnect ||= googleReconnectNeeded(error)
              sharing.push({
                ...target,
                status: uncertainGrants.has(key) ? 'unknown' : 'failed',
                message: signal.aborted ? 'The guest access check timed out.' : message(error),
              })
            }
          }
        })
      }
    } catch (error) {
      if (!signal.aborted) throw error
    }
    for (; index < guests.length; index++) {
      const guest = guests[index]!
      const uncertain = uncertainGrants.has(grantKey(accountSub, fileId, guest))
      sharing.push({
        fileId,
        guest,
        status: uncertain ? 'unknown' : 'failed',
        message: uncertain ? message() : 'Guest access was not checked.',
      })
    }
  }
  return { sharing, reconnect }
}
