import { CapabilityError } from '../../../main/plugin-api'
import { DRIVE_SHORTCUT_MIME, isDriveFileId } from '../shared/drive-files'
import {
  ATTACHMENT_LIMIT,
  type AttachEventFilesResult,
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
import { driveAttachmentCandidate, type DriveAttachmentCandidate } from './drive-files'
import type { PermissionReceipts } from './permission-receipts'
import { GoogleReconnectRequiredError } from './session'

const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const CONFLICT_RETRIES = 2
const LIMIT_MESSAGE = `Google Calendar supports at most ${ATTACHMENT_LIMIT} attachments.`
const UNKNOWN_MESSAGE = 'Could not confirm that all selected files were attached.'
const TIMEOUT_MESSAGE = 'The guest access check timed out. Some access may not have been checked.'
const OPERATION_TIMEOUT_MS = 30_000

type OperationOptions = {
  receipts: PermissionReceipts
  signal?: AbortSignal
  /** Drive work can require consent that Calendar reads don't. */
  validateDrive?: Validate
}

export function attachmentDeadline(): AbortSignal {
  return AbortSignal.timeout(OPERATION_TIMEOUT_MS)
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

function editability(current: Snapshot): { reason: string } | { guests: string[] } {
  const { calendar, event } = current
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
  return guestList(current)
}

function guestList({ calendar, event }: Snapshot): { reason: string } | { guests: string[] } {
  if (!['reader', 'writer', 'owner'].includes(calendar.accessRole ?? '')) {
    return { reason: 'This account cannot read the event guest list.' }
  }
  const reason = 'Google did not provide a complete guest list.'
  if (
    event.attendeesOmitted ||
    (event.attendees !== undefined && !Array.isArray(event.attendees))
  ) {
    return { reason }
  }
  const organizerEmail = event.organizer?.email
  if (organizerEmail !== undefined && typeof organizerEmail !== 'string') return { reason }
  const organizer = organizerEmail?.toLowerCase()
  const guests = new Set<string>()
  for (const person of event.attendees ?? []) {
    if (person?.resource || person?.organizer || (event.organizer?.self === true && person?.self))
      continue
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
  signal?: AbortSignal,
): Promise<EventAttachments> {
  const current = await snapshot(api, target, validate, signal)
  const editable = editability(current)
  return {
    attachments: displayed(current.event),
    ...('reason' in editable ? { canAttach: false, reason: editable.reason } : { canAttach: true }),
  }
}

const attached = (event: CalendarEvent, id: string) =>
  event.attachments?.some(
    ({ fileId, mimeType }) => fileId === id && mimeType !== DRIVE_SHORTCUT_MIME,
  ) === true

const failed = (message: string, event?: CalendarEvent): AttachEventFilesResult => ({
  attachments: event ? displayed(event) : [],
  attachmentStatus: 'failed',
  sharing: [],
  sharingComplete: false,
  message,
})

const attachFailed = (message: string, event?: CalendarEvent): AttachEventFilesResult => ({
  ...failed(message, event),
  calendarWriteStatus: 'not-written',
})

/** Only for a refusal before any write could have taken effect. */
export function attachmentUpdateRefused(
  error: unknown,
  event?: CalendarEvent,
): AttachEventFilesResult {
  if (googleReconnectNeeded(error) || error instanceof GoogleReconnectRequiredError) {
    return { ...attachFailed('Reconnect Google before attaching files.', event), reconnect: true }
  }
  const reason =
    error instanceof CapabilityError && error.code === 'FORBIDDEN'
      ? 'Google attachment access changed. Reload the event.'
      : 'Could not complete the attachment update. No files were attached by this update.'
  return attachFailed(reason, event)
}

const selection = (fileIds: string[]) => [...new Set(fileIds)]

export async function attachEventFiles(
  api: GoogleApi,
  target: EventAttachmentTarget,
  fileIds: string[],
  validate: Validate,
  options: OperationOptions,
): Promise<AttachEventFilesResult> {
  const ids = selection(fileIds)
  if (ids.length > ATTACHMENT_LIMIT) return attachFailed(LIMIT_MESSAGE)
  if (!ids.length || !ids.every(isDriveFileId))
    return attachFailed('Select valid Google Drive files.')

  const signal = options.signal ?? attachmentDeadline()
  const validateWrite = options.validateDrive ?? validate
  let current: Snapshot
  try {
    current = await snapshot(api, target, validate, signal)
  } catch (error) {
    return attachmentUpdateRefused(error)
  }

  let files: DriveAttachmentCandidate[] = ids.map((id) => ({ id }))
  const resolved = new Set<string>()
  const alreadyAttached = new Set<string>()
  const grantIds = new Set<string>()
  let calendarWriteStatus: NonNullable<AttachEventFilesResult['calendarWriteStatus']> =
    'not-written'
  for (let conflicts = 0; ; conflicts++) {
    const { event } = current
    if (!files.every(({ id }) => attached(event, id))) {
      const editable = editability(current)
      if ('reason' in editable) return attachFailed(editable.reason, event)
      try {
        files = await Promise.all(
          files.map(async (file) => {
            if (resolved.has(file.id) || attached(event, file.id)) return file
            const candidate = await driveAttachmentCandidate(api, file.id, validateWrite, signal)
            resolved.add(file.id)
            return candidate
          }),
        )
      } catch (error) {
        return attachmentUpdateRefused(error, event)
      }
    }

    // A stale selection (including after a rejected ETag) never authorizes
    // sharing files that were already on any prewrite snapshot.
    const newFiles = files.filter((file) => {
      if (!attached(event, file.id)) return true
      alreadyAttached.add(file.id)
      return false
    })
    if (newFiles.length === 0) break
    // A matching URL can prevent a duplicate, but only Calendar's explicit
    // Drive file ID can establish presence or authorize an access check.
    if (
      newFiles.some(({ webViewLink }) =>
        event.attachments?.some(
          ({ fileId, fileUrl }) => !isDriveFileId(fileId) && fileUrl === webViewLink,
        ),
      )
    ) {
      return {
        ...attachFailed(
          'A selected file matches an existing Calendar attachment without a usable Drive file ID. No attachments were changed.',
          event,
        ),
        attachmentsVerified: true,
      }
    }
    const additions = newFiles.flatMap((file) => (file.attachment ? [file.attachment] : []))
    if (additions.length !== newFiles.length)
      return attachFailed('A selected Drive file cannot be attached and shared.', event)
    // Send the original attachment objects unchanged; Calendar PATCH replaces
    // the whole array. fileId is read-only and only Google resolves it.
    const merged = [...(event.attachments ?? []), ...additions]
    if (merged.length > ATTACHMENT_LIMIT) return attachFailed(LIMIT_MESSAGE, event)
    if (conflicts > CONFLICT_RETRIES)
      return attachFailed('The event kept changing. No attachment update was made.', event)

    try {
      await api.request(
        'PATCH',
        `${eventUrl(target)}?supportsAttachments=true&sendUpdates=none`,
        { attachments: merged },
        validateWrite,
        { ifMatch: current.event.etag, signal },
      )
      calendarWriteStatus = 'confirmed'
      for (const file of newFiles) {
        if (!alreadyAttached.has(file.id)) grantIds.add(file.id)
      }
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
      calendarWriteStatus = 'unknown'
    }
    // Verify the current event before sharing. A read can show the files are
    // present, but cannot attribute them to a PATCH whose response was lost.
    try {
      current = await snapshot(api, target, validate, signal)
    } catch (error) {
      return {
        attachments: [],
        attachmentStatus: 'unknown',
        calendarWriteStatus,
        attachmentsVerified: false,
        message: UNKNOWN_MESSAGE,
        sharing: [],
        sharingComplete: false,
        ...(googleReconnectNeeded(error) ? { reconnect: true } : {}),
      }
    }
    break
  }

  const access = await reconcileGuestAccess(
    api,
    target,
    ids,
    current,
    validate,
    validateWrite,
    signal,
    options.receipts,
    grantIds,
  )
  return { ...access, calendarWriteStatus }
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
  if (!ids.length || !ids.every(isDriveFileId)) return failed('Select valid Google Drive files.')

  const signal = options.signal ?? attachmentDeadline()
  const current = await snapshot(api, target, validate, signal)
  // Calendar supplies the resolved Drive ID for Drive attachments. Do not
  // consult a Drive ACL for a selected file that is no longer on the event.
  return reconcileGuestAccess(
    api,
    target,
    ids,
    current,
    validate,
    options.validateDrive ?? validate,
    signal,
    options.receipts,
  )
}

async function reconcileGuestAccess(
  api: GoogleApi,
  target: EventAttachmentTarget,
  selectedIds: string[],
  current: Snapshot,
  validate: Validate,
  validateDrive: Validate,
  signal: AbortSignal,
  receipts: PermissionReceipts,
  grantIds?: ReadonlySet<string>,
): Promise<AttachEventFilesResult> {
  const fileIds = selectedIds.filter((id) => attached(current.event, id))
  const confirmed = new Set(fileIds)
  const readOnlyFileIds = grantIds && new Set(fileIds.filter((id) => !grantIds.has(id)))
  const canGrant = grantIds && fileIds.some((id) => grantIds.has(id))
  const accessFor = canGrant ? editability : guestList
  const initial = accessFor(current)
  const guests = 'guests' in initial ? initial.guests : []
  const startedWith = new Set(guests)
  let changed = false
  let unverified = false
  let reason = 'reason' in initial ? initial.reason : undefined

  const refresh = async () => {
    current = await snapshot(api, target, validate, signal)
    const access = accessFor(current)
    if ('reason' in access) {
      reason = access.reason
      changed = true
    } else if (
      access.guests.length !== startedWith.size ||
      access.guests.some((guest) => !startedWith.has(guest))
    ) {
      changed = true
    }
    if (selectedIds.some((id) => attached(current.event, id) !== confirmed.has(id))) changed = true
    return access
  }

  const result = await ensureGuestViewers(api, fileIds, guests, {
    receipts,
    signal,
    validate: validateDrive,
    readOnlyFileIds,
    ...(canGrant
      ? {
          validateGuest: async (guest, fileId) => {
            const access = await refresh()
            if (
              !confirmed.has(fileId) ||
              !attached(current.event, fileId) ||
              !('guests' in access) ||
              !access.guests.includes(guest)
            )
              throw new Error('The guest or attachment is no longer eligible for sharing.')
          },
        }
      : {}),
  })
  let reconnect = result.reconnect
  if (!canGrant && (!confirmed.size || !guests.length)) {
    // With no ACLs to request, still surface missing Drive consent.
    try {
      await untilGoogleAbort(signal, validateDrive)
    } catch (error) {
      reconnect ||= googleReconnectNeeded(error)
    }
  }
  let guestsChecked: string[] | undefined
  try {
    // Calendar, not Drive, determines what's attached and who's still a guest.
    // Report the latest complete list, not the guests we attempted to share with.
    await refresh()
    const latest = guestList(current)
    if ('guests' in latest) guestsChecked = latest.guests
  } catch (error) {
    reconnect ||= googleReconnectNeeded(error)
    unverified = true
  }

  const complete = !unverified && selectedIds.every((id) => attached(current.event, id))
  const incompleteAccess = result.sharing.filter(
    ({ status }) => status !== 'already-accessible' && status !== 'granted',
  )
  const sharingComplete =
    complete && !reason && !changed && !reconnect && !signal.aborted && !incompleteAccess.length
  const message = [
    complete ? undefined : UNKNOWN_MESSAGE,
    signal.aborted ? TIMEOUT_MESSAGE : undefined,
    reason ? `Guest access is incomplete. ${reason}` : undefined,
    incompleteAccess.some(({ fileId }) => readOnlyFileIds?.has(fileId))
      ? 'Holi checks guest access without granting it when it cannot confirm that it attached the file in this update.'
      : undefined,
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
    attachments: unverified ? [] : displayed(current.event),
    attachmentStatus: complete ? 'attached' : 'unknown',
    attachmentsVerified: !unverified,
    sharing: result.sharing,
    sharingComplete,
    ...(guestsChecked === undefined ? {} : { guestsChecked }),
    ...(message ? { message } : {}),
    ...(reconnect ? { reconnect: true } : {}),
  }
}
