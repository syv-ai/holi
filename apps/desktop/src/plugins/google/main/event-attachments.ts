import type {
  EventAttachmentTarget,
  EventAttachments,
  DriveFilePage,
  AttachEventFilesResult,
} from '../shared/event-attachments'
import type { GoogleApi } from './api'

const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const LIMIT = 25

type Event = {
  id: string
  etag?: string
  organizer?: { self?: boolean; email?: string }
  attendees?: Array<{ email?: string; resource?: boolean; self?: boolean; responseStatus?: string }>
  attachments?: Array<{
    fileId?: string
    title?: string
    fileUrl?: string
    mimeType?: string
    iconLink?: string
  }>
  supportsAttachments?: boolean
}

export async function eventAttachments(
  api: GoogleApi,
  target: EventAttachmentTarget,
  validate: () => Promise<void>,
): Promise<EventAttachments> {
  await validate()
  const event = await api.get<Event>(
    `${CALENDAR}/calendars/${encodeURIComponent(target.calendarId)}/events/${encodeURIComponent(target.eventId)}`,
    { supportsAttachments: 'true' },
  )
  return {
    attachments: event.attachments ?? [],
    canAttach: event.supportsAttachments === true && event.organizer?.self === true,
  }
}

export async function driveFiles(
  api: GoogleApi,
  query = '',
  pageToken?: string,
): Promise<DriveFilePage> {
  const escaped = query.replace(/[\\']/g, (character) => `\\${character}`)
  const params: Record<string, string> = {
    q: `trashed = false${escaped ? ` and name contains '${escaped}'` : ''}`,
    pageSize: '100',
    fields: 'nextPageToken,files(id,name,mimeType)',
  }
  if (pageToken) params.pageToken = pageToken
  const result = await api.get<{ files?: DriveFilePage['files']; nextPageToken?: string }>(
    `${DRIVE}/files`,
    params,
  )
  return {
    files: result.files ?? [],
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  }
}

export async function attachEventFiles(
  api: GoogleApi,
  target: EventAttachmentTarget,
  fileIds: string[],
  validate: () => Promise<void>,
): Promise<AttachEventFilesResult> {
  const ids = [...new Set(fileIds)]
  if (ids.length > LIMIT)
    return {
      attachments: [],
      attachmentStatus: 'failed',
      message: 'Google Calendar supports at most 25 attachments.',
    }
  await validate()
  let event: Event
  try {
    event = await api.get<Event>(
      `${CALENDAR}/calendars/${encodeURIComponent(target.calendarId)}/events/${encodeURIComponent(target.eventId)}`,
      { supportsAttachments: 'true' },
    )
  } catch {
    return {
      attachments: [],
      attachmentStatus: 'failed',
      message: 'Could not read the calendar event.',
    }
  }
  if (event.supportsAttachments !== true || event.organizer?.self !== true)
    return {
      attachments: event.attachments ?? [],
      attachmentStatus: 'failed',
      message: 'This event cannot be changed by this account.',
    }
  if ((event.attendees ?? []).length === 0 && event.attendees === undefined)
    return {
      attachments: event.attachments ?? [],
      attachmentStatus: 'failed',
      message: 'Guest information is incomplete.',
    }
  const resolved = await Promise.all(
    ids.map(async (id) => {
      const file = await api.get<{
        id: string
        name: string
        mimeType: string
        webViewLink: string
        iconLink?: string
      }>(`${DRIVE}/files/${encodeURIComponent(id)}`, {
        fields: 'id,name,mimeType,webViewLink,iconLink',
      })
      return {
        fileId: file.id,
        title: file.name,
        fileUrl: file.webViewLink,
        mimeType: file.mimeType,
        ...(file.iconLink ? { iconLink: file.iconLink } : {}),
      }
    }),
  )
  const current = event.attachments ?? []
  const merged = [
    ...current,
    ...resolved.filter((item) => !current.some((existing) => existing.fileId === item.fileId)),
  ]
  await validate()
  try {
    await api.request(
      'PATCH',
      `${CALENDAR}/calendars/${encodeURIComponent(target.calendarId)}/events/${encodeURIComponent(target.eventId)}?supportsAttachments=true`,
      { attachments: merged },
      validate,
      { ifMatch: event.etag },
    )
  } catch {
    return {
      attachments: current,
      attachmentStatus: 'unknown',
      message: 'The attachment update could not be confirmed.',
    }
  }
  return { attachments: merged, attachmentStatus: 'attached', sharing: [] }
}
