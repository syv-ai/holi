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
  status: 'granted' | 'already-accessible' | 'failed' | 'unknown'
  message?: string
}

export interface AttachEventFilesResult {
  attachments: EventAttachment[]
  attachmentStatus: 'attached' | 'failed' | 'unknown'
  message?: string
  sharing: AttachmentSharingResult[]
  /** The attachment and guest outcomes still apply; further work needs Google consent. */
  reconnect?: boolean
  /** Whether access was confirmed for every selected attachment and current guest. */
  sharingComplete?: boolean
}
