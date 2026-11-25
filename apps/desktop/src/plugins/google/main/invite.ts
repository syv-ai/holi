import { parseMailInvitation } from './mail-invitation'

/** PUBLISH may identify a meeting, but is not an invitation to answer. Use
 * the same bounded VEVENT parser for matching its material. Only adapt the
 * envelope method; mark the result join-only before it can enter selection. */
export function parseCalendarMail(messageId: string, source: string, mimeMethod?: string) {
  const invitation = parseMailInvitation(messageId, source, mimeMethod)
  if (invitation) return { value: invitation, published: false }
  if (mimeMethod && mimeMethod.toUpperCase() !== 'PUBLISH') return null

  let depth = 0
  let calendar = false
  let publication = false
  // Inspect logical lines but leave the original folding alone except for
  // the top-level METHOD. The parser has already accepted the MIME framing.
  const adapted = source.replace(/^[^\r\n]+(?:\r?\n[ \t][^\r\n]*)*/gm, (raw) => {
    const line = raw.replace(/^\uFEFF/, '').replace(/\r?\n[ \t]/g, '')
    if (/^BEGIN:/i.test(line)) {
      if (depth === 0) calendar = /^BEGIN:VCALENDAR$/i.test(line)
      depth++
    } else if (/^END:/i.test(line)) depth--
    else if (calendar && depth === 1 && /^METHOD(?:;VALUE=TEXT)?:PUBLISH$/i.test(line)) {
      publication = true
      return line.replace(/PUBLISH$/i, 'REQUEST')
    }
    return raw
  })
  if (!publication) return null
  const value = parseMailInvitation(messageId, adapted, 'REQUEST')
  return value ? { value, published: true } : null
}
