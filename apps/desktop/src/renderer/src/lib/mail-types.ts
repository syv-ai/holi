/**
 * The renderer's mail shapes, mirroring `main/google/gmail.ts`. One copy, in
 * `lib/` because `lib/` may not import from `features/`.
 */

/** `email` is `''` when the header held no address: no `mailto:`, and never a
 *  recipient chip. */
export interface MailAddress {
  name: string
  email: string
}

export interface MailAttachment {
  filename: string
  mimeType: string
  size: number
}

export interface ThreadMessage {
  id: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  /**
   * Almost always empty: delivered mail has it stripped, so it survives only
   * on the account's own sent copies. Displayed when present; never used to
   * address a reply.
   */
  bcc: MailAddress[]
  date: string
  /** Plain text: the fallback, and what a text-only message carries. */
  body: string
  /** Raw, unsanitized HTML, or null. Only a sanitizing path may touch this. */
  html: string | null
  attachments: MailAttachment[]
}
