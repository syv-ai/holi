import { parseMailInvitation } from './mail-invitation'

/** Publications and methodless exports can identify a meeting, never an RSVP target. */
export function parseCalendarMail(messageId: string, source: string, mimeMethod?: string) {
  const value = parseMailInvitation(messageId, source, mimeMethod)
  return value && { value, joinOnly: value.method === 'PUBLISH' || value.method === 'EXPORT' }
}
