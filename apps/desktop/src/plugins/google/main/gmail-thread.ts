import type { GoogleApi } from './api'
import { CalendarScanError, type RawPart } from './gmail-mime'

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface RawMessage {
  id?: string
  /** Absent on a loose draft that belongs to no conversation. */
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: RawPart
}

export interface RawThread {
  id?: string
  messages?: RawMessage[]
}

export function isGmailMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
}

type ThreadMessage = RawMessage & { id: string }

function record(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validInternalDate(value: unknown): boolean {
  // Gmail sends a signed int64 as a decimal string, not a JS number or ISO date.
  if (typeof value !== 'string' || !/^-?[0-9]{1,19}$/.test(value)) return false
  const millis = BigInt(value)
  const limit = 1n << 63n
  return millis >= -limit && millis < limit
}

function isFullPayload(payload: RawPart | undefined): boolean {
  if (
    !payload ||
    !record(payload) ||
    typeof payload.mimeType !== 'string' ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:;[^\r\n]*)?$/.test(
      payload.mimeType,
    )
  )
    return false
  const { body, parts } = payload
  if (parts !== undefined && !Array.isArray(parts)) return false
  if (
    body !== undefined &&
    (!record(body) ||
      (body.size !== undefined && (!Number.isSafeInteger(body.size) || body.size < 0)) ||
      (body.data !== undefined && typeof body.data !== 'string') ||
      (body.attachmentId !== undefined &&
        (typeof body.attachmentId !== 'string' || !body.attachmentId)))
  )
    return false
  // A container may have an empty body, but the full response must include
  // its children. A zero-byte leaf or attachment may have no inline data.
  return (
    Boolean(parts?.length) ||
    (!/^multipart\//i.test(payload.mimeType) &&
      body !== undefined &&
      (body.size === 0 || body.data !== undefined || body.attachmentId !== undefined))
  )
}

function validMessageMetadata(message: RawMessage): boolean {
  return (
    (message.labelIds === undefined ||
      (Array.isArray(message.labelIds) &&
        message.labelIds.every((label) => typeof label === 'string'))) &&
    (message.internalDate === undefined || validInternalDate(message.internalDate)) &&
    (message.snippet === undefined || typeof message.snippet === 'string')
  )
}

function fullMessageMatches(
  message: RawMessage,
  id: string,
  threadId: string | null,
): message is ThreadMessage {
  return (
    record(message) &&
    isGmailMessageId(message.id) &&
    message.id === id &&
    (threadId === null ? isGmailMessageId(message.threadId) : message.threadId === threadId) &&
    validMessageMetadata(message) &&
    isFullPayload(message.payload)
  )
}

/** The unmasked full-message contract also applies to a Sent message read by ID. */
export function validateFullMessage(
  message: RawMessage,
  id: string,
  threadId: string | null,
): ThreadMessage {
  if (!fullMessageMatches(message, id, threadId))
    throw new CalendarScanError('Gmail returned an invalid full message response')
  return message
}

function invalidThreadResponse(format: 'metadata' | 'full') {
  return new CalendarScanError(`Gmail returned an invalid ${format} thread response`)
}

/** Validate the unmasked threads.get envelope before projecting any mail.
 * Metadata may omit the message's threadId; a full response must bind both
 * the thread and every one of its messages to the requested conversation. */
export function threadMessages(
  thread: RawThread,
  id: string,
  format: 'metadata' | 'full',
): ThreadMessage[] {
  if (
    !thread ||
    typeof thread !== 'object' ||
    Array.isArray(thread) ||
    thread.id !== id ||
    !Array.isArray(thread.messages) ||
    thread.messages.length === 0
  )
    throw invalidThreadResponse(format)
  if (thread.messages.length > 2048)
    throw new CalendarScanError('Gmail thread messages exceed the scan limits')
  const seen = new Set<string>()
  return thread.messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !isGmailMessageId(message.id) ||
      seen.has(message.id) ||
      (format === 'full'
        ? !fullMessageMatches(message, message.id, id)
        : (message.threadId !== undefined && message.threadId !== id) ||
          !validMessageMetadata(message))
    )
      throw invalidThreadResponse(format)
    seen.add(message.id)
    return message as ThreadMessage
  })
}

export async function fetchFullThread(api: GoogleApi, threadId: string): Promise<ThreadMessage[]> {
  let thread: RawThread
  try {
    thread = await api.get<RawThread>(`${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}`, {
      format: 'full',
    })
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidThreadResponse('full')
    throw error
  }
  return threadMessages(thread, threadId, 'full')
}
