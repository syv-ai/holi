import { DRIVE_SHORTCUT_MIME, isDriveFileId } from '../shared/drive-files'
import type { DriveFile, DriveFilePage, EventAttachment } from '../shared/event-attachments'
import type { GoogleApi } from './api'

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const FOLDER = 'application/vnd.google-apps.folder'
const DRIVE_FIELDS = 'id,name,mimeType,webViewLink,trashed,capabilities(canShare)'

type Validate = () => Promise<void>
type DriveMetadata = {
  id?: string
  name?: string
  mimeType?: string
  webViewLink?: string
  trashed?: boolean
  capabilities?: { canShare?: boolean }
}

export type DriveAttachmentCandidate = {
  id: string
  /** Can identify a previously attached file even when it cannot be shared. */
  webViewLink?: string
  attachment?: Omit<EventAttachment, 'fileId'>
}

function viewLink(file: DriveMetadata | null): string | undefined {
  const link = file?.webViewLink
  if (typeof link !== 'string' || !URL.canParse(link)) return
  const url = new URL(link)
  if (url.protocol === 'https:' && !url.username && !url.password) return link
}

function shareable(file: DriveMetadata | null): (DriveFile & { webViewLink: string }) | null {
  const webViewLink = viewLink(file)
  if (
    !isDriveFileId(file?.id) ||
    typeof file.name !== 'string' ||
    !file.name ||
    typeof file.mimeType !== 'string' ||
    !file.mimeType ||
    file.mimeType === FOLDER ||
    file.mimeType === DRIVE_SHORTCUT_MIME ||
    file.trashed === true ||
    file.capabilities?.canShare !== true ||
    !webViewLink
  )
    return null
  return { id: file.id, name: file.name, mimeType: file.mimeType, webViewLink }
}

export async function driveFiles(
  api: GoogleApi,
  query: string,
  pageToken: string | undefined,
  validate: Validate,
  signal?: AbortSignal,
): Promise<DriveFilePage> {
  const escaped = query.replace(/[\\']/g, (character) => `\\${character}`)
  const result = await api.get<{ files?: DriveMetadata[]; nextPageToken?: string }>(
    DRIVE_FILES,
    {
      q: `trashed = false and mimeType != '${FOLDER}' and mimeType != '${DRIVE_SHORTCUT_MIME}'${escaped ? ` and name contains '${escaped}'` : ''}`,
      pageSize: '100',
      fields: `nextPageToken,files(${DRIVE_FIELDS})`,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      pageToken,
    },
    validate,
    { signal },
  )
  return {
    files: (result.files ?? []).flatMap((metadata) => {
      const file = shareable(metadata)
      return file ? [{ id: file.id, name: file.name, mimeType: file.mimeType }] : []
    }),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  }
}

export async function driveAttachmentCandidate(
  api: GoogleApi,
  id: string,
  validate: Validate,
  signal: AbortSignal,
): Promise<DriveAttachmentCandidate> {
  if (!isDriveFileId(id)) return { id }
  const file = await api.get<DriveMetadata | null>(
    `${DRIVE_FILES}/${id}`,
    { fields: DRIVE_FIELDS, supportsAllDrives: 'true' },
    validate,
    { signal },
  )
  if (file?.id !== id || file.mimeType === FOLDER || file.mimeType === DRIVE_SHORTCUT_MIME)
    return { id }
  const eligible = shareable(file)
  if (!eligible) return { id, webViewLink: viewLink(file) }
  const { name, mimeType, webViewLink } = eligible
  return { id, webViewLink, attachment: { fileUrl: webViewLink, title: name, mimeType } }
}
