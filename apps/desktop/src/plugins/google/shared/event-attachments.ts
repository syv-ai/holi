export const ATTACHMENT_LIMIT = 25

export interface EventAttachmentTarget {
  expectedAccountSub: string
  calendarId: string
  eventId: string
}

export interface EventAttachment {
  fileId?: string
  title: string
  fileUrl: string
  mimeType?: string
  iconLink?: string
}

export interface EventAttachments {
  attachments: EventAttachment[]
  canAttach: boolean
  reason?: string
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
}

export interface DriveFilePage {
  files: DriveFile[]
  nextPageToken?: string
}

export interface AttachmentSharingResult {
  fileId: string
  guest: string
  /** `blocked` means an unresolved write prevents new grants on this file. */
  status: 'granted' | 'already-accessible' | 'failed' | 'unknown' | 'blocked'
  message?: string
}

export interface AttachEventFilesResult {
  attachments: EventAttachment[]
  attachmentStatus: 'attached' | 'failed' | 'unknown'
  /** Outcome of this attach attempt's Calendar PATCH, not the current attachment state.
   * Omitted by read-only access checks, which cannot establish a past write's outcome. */
  calendarWriteStatus?: 'not-written' | 'confirmed' | 'unknown'
  /** Whether `attachments` is the complete current Calendar set, even if selections are missing. */
  attachmentsVerified?: boolean
  message?: string
  sharing: AttachmentSharingResult[]
  /** The complete current guest list, even if empty. Omitted when it could not be confirmed. */
  guestsChecked?: string[]
  /** The attachment and guest outcomes still apply; further work needs Google consent. */
  reconnect?: boolean
  /** Whether access was confirmed for every selected attachment and current guest. */
  sharingComplete?: boolean
}
