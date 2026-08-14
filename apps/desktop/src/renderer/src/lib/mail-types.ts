/**
 * The renderer's mail shapes, mirroring `main/google/gmail.ts`.
 *
 * Lifted out of `MailView.tsx` when the composer landed (D71). They were
 * declared there when it was the only thing that read mail; `compose-intent`
 * needs the same shapes, and a second copy of a mail message is exactly how the
 * `to` and `cc` fields drift apart — one file gains a field, the other keeps
 * compiling, and a reply-all quietly stops copying somebody.
 *
 * These live in `lib/` rather than beside `MailView` because the dependency has
 * to run that way: `lib/` may not import from `features/`.
 */

/** `email` is `''` when the header carried nothing that looks like an address —
 *  the one case where no `mailto:` may be offered, and an address that must
 *  never become a recipient chip. */
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
  /** Who else saw this. A reply-all is a different act from a reply, and this
   *  header is the only thing that says which one is called for. */
  cc: MailAddress[]
  /**
   * Who saw it without the others knowing.
   *
   * **Almost always empty, and that is Gmail rather than a gap here.** The
   * header is stripped from delivered mail by design — it survives only on the
   * copy of a message the account itself sent, which is to say in the Sent
   * mailbox. Displayed when present; never used to address a reply, because
   * quietly copying somebody the sender chose to hide is not a thing a reply
   * should do on its own.
   */
  bcc: MailAddress[]
  date: string
  /** Plain text — the fallback, and what a text-only message carries. */
  body: string
  /** Raw, unsanitized HTML, or null. Only a sanitizing path may touch this. */
  html: string | null
  attachments: MailAttachment[]
}
