import { CapabilityError } from '../../../main/plugin-api'
import {
  ATTACHMENT_LIMIT,
  type AttachEventFilesResult,
  type DriveFile,
  type DriveFilePage,
  type EventAttachment,
  type EventAttachments,
  type EventAttachmentTarget,
} from '../shared/event-attachments'
import {
  GoogleApiError,
  googleReconnectNeeded,
  isUncertainGoogleWrite,
  untilGoogleAbort,
  type GoogleApi,
} from './api'
import { ensureGuestViewers } from './attachment-sharing'
import type { PermissionReceipts } from './permission-receipts'
import { GoogleReconnectRequiredError } from './session'

const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const FOLDER = 'application/vnd.google-apps.folder'
const SHORTCUT = 'application/vnd.google-apps.shortcut'
const DRIVE_FIELDS = 'id,name,mimeType,webViewLink,trashed,capabilities(canShare)'
const CONFLICT_RETRIES = 2
const LIMIT_MESSAGE = `Google Calendar supports at most ${ATTACHMENT_LIMIT} attachments.`
const UNKNOWN_MESSAGE = 'Could not confirm that all selected files were attached.'
const TIMEOUT_MESSAGE = 'The guest access check timed out. Some access may not have been checked.'
const OPERATION_TIMEOUT_MS = 30_000

type OperationOptions = { receipts: PermissionReceipts; signal?: AbortSignal }

function operationSignal(options: OperationOptions): AbortSignal {
  const timeout = AbortSignal.timeout(OPERATION_TIMEOUT_MS)
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
}

type Validate = () => Promise<void>
type CalendarAttachment = Omit<EventAttachment, 'title'> & { title?: string }
type CalendarEvent = {
  id: string
  etag?: string
  organizer?: { self?: boolean; email?: string }
  attendees?: Array<{ email?: string; resource?: boolean; self?: boolean; organizer?: boolean }>
  attendeesOmitted?: boolean
  attachments?: CalendarAttachment[]
  status?: string
  eventType?: string
  locked?: boolean
}
type Snapshot = {
  calendar: { accessRole?: string }
  event: CalendarEvent
}
type DriveMetadata = {
  id?: string
  name?: string
  mimeType?: string
  webViewLink?: string
  trashed?: boolean
  capabilities?: { canShare?: boolean }
}
type ShareableFile = DriveFile & { webViewLink: string }

function segment(id: string): string {
  // URL normalizes dot segments even when they are percent-encoded.
  if (!id || id === '.' || id === '..') throw new Error('Invalid Google resource id.')
  return encodeURIComponent(id)
}

const eventUrl = (target: EventAttachmentTarget) =>
  `${CALENDAR}/calendars/${segment(target.calendarId)}/events/${segment(target.eventId)}`

async function snapshot(
  api: GoogleApi,
  target: EventAttachmentTarget,
  validate: Validate,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const calendar = await api.get<Snapshot['calendar']>(
    `${CALENDAR}/users/me/calendarList/${segment(target.calendarId)}`,
    {},
    validate,
    { signal },
  )
  // Read the full event, without maxAttendees or a field mask. Solo events
  // normally omit attendees; attendeesOmitted explicitly says not to trust it.
  const event = await api.get<CalendarEvent>(eventUrl(target), {}, validate, { signal })
  await untilGoogleAbort(signal, validate)
  if (
    typeof calendar?.accessRole !== 'string' ||
    event?.id !== target.eventId ||
    (event.attachments !== undefined &&
      (!Array.isArray(event.attachments) ||
        event.attachments.some((item) => typeof item?.fileUrl !== 'string' || !item.fileUrl)))
  ) {
    throw new Error('Could not read the Google event attachments.')
  }
  return { calendar, event }
}

function displayed(event: CalendarEvent): EventAttachment[] {
  return (event.attachments ?? []).map(({ fileId, fileUrl, title, mimeType, iconLink }) => ({
    fileUrl,
    title: typeof title === 'string' && title ? title : 'Attachment',
    ...(typeof fileId === 'string' ? { fileId } : {}),
    ...(typeof mimeType === 'string' ? { mimeType } : {}),
    ...(typeof iconLink === 'string' ? { iconLink } : {}),
  }))
}

function editability({ calendar, event }: Snapshot): { reason: string } | { guests: string[] } {
  if (
    (calendar.accessRole !== 'owner' && calendar.accessRole !== 'writer') ||
    event.organizer?.self !== true ||
    event.status === 'cancelled' ||
    event.locked === true ||
    (event.eventType !== undefined && event.eventType !== 'default')
  ) {
    return { reason: 'This event cannot be changed by this account.' }
  }
  // A wildcard/weak tag is not a precondition on the event we read.
  if (typeof event.etag !== 'string' || !/^"[\x21\x23-\x7e]+"$/.test(event.etag)) {
    return { reason: 'The event has no usable version tag.' }
  }
  const reason = 'Google did not provide a complete guest list.'
  if (
    event.attendeesOmitted ||
    (event.attendees !== undefined && !Array.isArray(event.attendees))
  ) {
    return { reason }
  }
  const guests = new Set<string>()
  const organizer = event.organizer.email?.toLowerCase()
  for (const person of event.attendees ?? []) {
    if (person?.resource || person?.self || person?.organizer) continue
    if (typeof person?.email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(person.email)) {
      return { reason }
    }
    const email = person.email.toLowerCase()
    if (email !== organizer) guests.add(email)
  }
  return { guests: [...guests] }
}

export async function eventAttachments(
  api: GoogleApi,
  target: EventAttachmentTarget,
  validate: Validate,
): Promise<EventAttachments> {
  const current = await snapshot(api, target, validate)
  const editable = editability(current)
  return {
    attachments: displayed(current.event),
    ...('reason' in editable ? { canAttach: false, reason: editable.reason } : { canAttach: true }),
  }
}

const driveId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]+$/.test(id)

function shareable(file: DriveMetadata | null): file is ShareableFile {
  if (
    !driveId(file?.id) ||
    typeof file.name !== 'string' ||
    !file.name ||
    typeof file.mimeType !== 'string' ||
    !file.mimeType ||
    file.mimeType === FOLDER ||
    file.mimeType === SHORTCUT ||
    file.trashed === true ||
    file.capabilities?.canShare !== true ||
    typeof file.webViewLink !== 'string'
  )
    return false
  if (!URL.canParse(file.webViewLink)) return false
  const url = new URL(file.webViewLink)
  return url.protocol === 'https:' && !url.username && !url.password
}

export async function driveFiles(
  api: GoogleApi,
  target: EventAttachmentTarget,
  query: string,
  pageToken: string | undefined,
  validate: Validate,
): Promise<DriveFilePage> {
  const escaped = query.replace(/[\\']/g, (character) => `\\${character}`)
  const result = await api.get<{ files?: DriveMetadata[]; nextPageToken?: string }>(
    DRIVE_FILES,
    {
      q: `trashed = false and mimeType != '${FOLDER}' and mimeType != '${SHORTCUT}'${escaped ? ` and name contains '${escaped}'` : ''}`,
      pageSize: '100',
      fields: `nextPageToken,files(${DRIVE_FIELDS})`,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      pageToken,
    },
    async () => {
      const editable = editability(await snapshot(api, target, validate))
      if ('reason' in editable) throw new CapabilityError('FORBIDDEN', editable.reason)
    },
  )
  return {
    files: (result.files ?? [])
      .filter(shareable)
      .map(({ id, name, mimeType }) => ({ id, name, mimeType })),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  }
}

type SelectedFile = { id: string; webViewLink?: string }

const attached = (event: CalendarEvent, file: SelectedFile) =>
  event.attachments?.some(
    (item) =>
      item.mimeType !== SHORTCUT &&
      (item.fileId ? item.fileId === file.id : item.fileUrl === file.webViewLink),
  ) === true

const failed = (message: string, event?: CalendarEvent): AttachEventFilesResult => ({
  attachments: event ? displayed(event) : [],
  attachmentStatus: 'failed',
  sharing: [],
  sharingComplete: false,
  message,
})

/** Only for a refusal before any write could have taken effect. */
export function attachmentUpdateRefused(
  error: unknown,
  event?: CalendarEvent,
): AttachEventFilesResult {
  if (googleReconnectNeeded(error) || error instanceof GoogleReconnectRequiredError) {
    return { ...failed('Reconnect Google before attaching files.', event), reconnect: true }
  }
  const reason =
    error instanceof CapabilityError && error.code === 'FORBIDDEN'
      ? 'Google attachment access changed. Reload the event.'
      : 'Could not complete the attachment update. No files were attached by this update.'
  return failed(reason, event)
}

const selection = (fileIds: string[]) => [...new Set(fileIds)]

async function driveMetadata(api: GoogleApi, id: string, validate: Validate, signal: AbortSignal) {
  return api.get<DriveMetadata>(
    `${DRIVE_FILES}/${id}`,
    { fields: DRIVE_FIELDS, supportsAllDrives: 'true' },
    validate,
    { signal },
  )
}

export async function attachEventFiles(
  api: GoogleApi,
  target: EventAttachmentTarget,
  fileIds: string[],
  validate: Validate,
  options: OperationOptions,
): Promise<AttachEventFilesResult> {
  const ids = selection(fileIds)
  if (ids.length > ATTACHMENT_LIMIT) return failed(LIMIT_MESSAGE)
  if (!ids.length || !ids.every(driveId)) return failed('Select valid Google Drive files.')

  const signal = operationSignal(options)
  let current: Snapshot | undefined
  let files: ShareableFile[]
  try {
    current = await snapshot(api, target, validate, signal)
    const initialAccess = editability(current)
    if ('reason' in initialAccess) return failed(initialAccess.reason, current.event)
    const resolved = await Promise.all(
      ids.map(async (id) => {
        const file = await driveMetadata(api, id, validate, signal)
        return shareable(file) && file.id === id ? file : null
      }),
    )
    await untilGoogleAbort(signal, validate)
    files = resolved.filter((file) => file !== null)
    if (files.length !== ids.length)
      return failed('A selected Drive file cannot be attached and shared.', current.event)
  } catch (error) {
    return attachmentUpdateRefused(error, current?.event)
  }

  for (let conflicts = 0; ; conflicts++) {
    const editable = editability(current)
    if ('reason' in editable) return failed(editable.reason, current.event)
    const { event } = current
    const newFiles = files.filter((file) => !attached(event, file))
    // Send the original attachment objects unchanged; Calendar PATCH replaces
    // the whole array. fileId is read-only and only Google resolves it.
    const merged = [
      ...(current.event.attachments ?? []),
      ...newFiles.map((file) => ({
        fileUrl: file.webViewLink,
        title: file.name,
        mimeType: file.mimeType,
      })),
    ]
    if (merged.length > ATTACHMENT_LIMIT) return failed(LIMIT_MESSAGE, current.event)
    if (newFiles.length === 0) break
    if (conflicts > CONFLICT_RETRIES)
      return failed('The event kept changing. No attachment update was made.', current.event)

    try {
      await api.request(
        'PATCH',
        `${eventUrl(target)}?supportsAttachments=true&sendUpdates=none`,
        { attachments: merged },
        validate,
        { ifMatch: current.event.etag, signal },
      )
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 412) {
        // Google rejected the stale precondition. Only this known refusal
        // permits an automatic replay, after re-fetching and re-merging.
        try {
          current = await snapshot(api, target, validate, signal)
        } catch (error) {
          return attachmentUpdateRefused(error, current.event)
        }
        continue
      }
      if (!isUncertainGoogleWrite(error)) return attachmentUpdateRefused(error, current.event)
    }
    // A response (or a lost one) isn't the current event. Before sharing,
    // confirm what is actually attached and which guests it has now.
    try {
      current = await snapshot(api, target, validate, signal)
    } catch (error) {
      return {
        attachments: [],
        attachmentStatus: 'unknown',
        message: UNKNOWN_MESSAGE,
        sharing: [],
        sharingComplete: false,
        ...(googleReconnectNeeded(error) ? { reconnect: true } : {}),
      }
    }
    break
  }

  return reconcileGuestAccess(
    api,
    target,
    files,
    current,
    validate,
    signal,
    options.receipts,
    'share',
  )
}

/** Check Calendar and Drive state without ever sending an invitation or a grant. */
export async function checkEventFileAccess(
  api: GoogleApi,
  target: EventAttachmentTarget,
  fileIds: string[],
  validate: Validate,
  options: OperationOptions,
): Promise<AttachEventFilesResult> {
  const ids = selection(fileIds)
  if (ids.length > ATTACHMENT_LIMIT) return failed(LIMIT_MESSAGE)
  if (!ids.length || !ids.every(driveId)) return failed('Select valid Google Drive files.')

  const signal = operationSignal(options)
  const current = await snapshot(api, target, validate, signal)
  // Calendar supplies the resolved Drive ID for Drive attachments. Do not
  // consult a Drive ACL for a selected file that is no longer on the event.
  return reconcileGuestAccess(
    api,
    target,
    ids.map((id) => ({ id })),
    current,
    validate,
    signal,
    options.receipts,
    'check',
  )
}

async function reconcileGuestAccess(
  api: GoogleApi,
  target: EventAttachmentTarget,
  files: SelectedFile[],
  current: Snapshot,
  validate: Validate,
  signal: AbortSignal,
  receipts: PermissionReceipts,
  mode: 'share' | 'check',
): Promise<AttachEventFilesResult> {
  const confirmed = new Map(
    files.filter((file) => attached(current.event, file)).map((file) => [file.id, file]),
  )
  const editable = editability(current)
  const guests = 'guests' in editable ? editable.guests : []
  const startedWith = new Set(guests)
  let changed = false
  let unverified = false
  let reason = 'reason' in editable ? editable.reason : undefined

  const refresh = async () => {
    current = await snapshot(api, target, validate, signal)
    const access = editability(current)
    if ('reason' in access) {
      reason = access.reason
      changed = true
    } else if (
      access.guests.length !== startedWith.size ||
      access.guests.some((guest) => !startedWith.has(guest))
    ) {
      changed = true
    }
    if (files.some((file) => attached(current.event, file) !== confirmed.has(file.id)))
      changed = true
    return access
  }

  const result = await ensureGuestViewers(api, [...confirmed.keys()], guests, {
    receipts,
    signal,
    validate,
    ...(mode === 'share'
      ? {
          validateGuest: async (guest, fileId) => {
            const access = await refresh()
            const file = confirmed.get(fileId)
            if (
              !file ||
              !attached(current.event, file) ||
              !('guests' in access) ||
              !access.guests.includes(guest)
            )
              throw new Error('The guest or attachment is no longer eligible for sharing.')
          },
        }
      : {}),
  })
  let reconnect = result.reconnect
  if (confirmed.size && !reconnect && !signal.aborted) {
    try {
      // Only one final pass: report new guests as unprocessed instead of
      // granting access on an unbounded series of concurrent event edits.
      await refresh()
    } catch (error) {
      reconnect = googleReconnectNeeded(error)
      unverified = true
    }
  }

  const complete = files.every((file) => attached(current.event, file))
  const sharingComplete =
    complete &&
    !reason &&
    !changed &&
    !unverified &&
    !reconnect &&
    !signal.aborted &&
    result.sharing.every(({ status }) => status === 'already-accessible' || status === 'granted')
  const message = [
    complete ? undefined : UNKNOWN_MESSAGE,
    signal.aborted ? TIMEOUT_MESSAGE : undefined,
    reason ? `Guest access is incomplete. ${reason}` : undefined,
    changed && !reason
      ? 'The attachments or guest list changed. Some access may not have been checked.'
      : undefined,
    unverified && !signal.aborted
      ? 'Could not confirm the current guest list and attachments.'
      : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  return {
    attachments: displayed(current.event),
    attachmentStatus: complete ? 'attached' : 'unknown',
    sharing: result.sharing,
    sharingComplete,
    ...(message ? { message } : {}),
    ...(reconnect ? { reconnect: true } : {}),
  }
}
