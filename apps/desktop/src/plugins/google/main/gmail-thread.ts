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
      (message.threadId !== id && (format === 'full' || message.threadId !== undefined)) ||
      (format === 'full' &&
        (!message.payload ||
          typeof message.payload !== 'object' ||
          Array.isArray(message.payload))) ||
      (message.labelIds !== undefined &&
        (!Array.isArray(message.labelIds) ||
          message.labelIds.some((label) => typeof label !== 'string'))) ||
      (message.internalDate !== undefined &&
        (typeof message.internalDate !== 'string' ||
          (format === 'metadata' &&
            (!/^\d+$/.test(message.internalDate) ||
              Number(message.internalDate) > 8_640_000_000_000_000)))) ||
      (message.snippet !== undefined && typeof message.snippet !== 'string')
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
