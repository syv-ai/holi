/**
 * What the composer is being opened *for* (D71).
 *
 * A discriminated union rather than a query string or a bag of optional
 * fields. ultramail's finding was that a typo in the kind silently produced an
 * empty composer — no error, no clue, just a blank message where a reply should
 * have been. A union makes that a compile error instead.
 *
 * Everything in this file is a rule about who receives a message. That is the
 * class of bug the sender never sees and everybody else on the thread does.
 *
 * **Where the threading headers are not.** `In-Reply-To` and `References` are
 * resolved in main, per send *and* per save, from a fresh thread read — never
 * held here and never baked at mount. A draft saved from Holi can be sent from
 * a phone, so the headers have to be in the draft's raw at save time too.
 */
import { mailHtmlToMarkdown, quoteAsMarkdown } from './mail-unmarkdown'
import type { MailAddress, ThreadMessage } from './mail-types'

export type ComposeIntent =
  | { kind: 'new' }
  | {
      kind: 'reply'
      threadId: string
      /**
       * The *thread's* subject, not the parent message's — `ThreadMessage`
       * carries no subject, and a reply is named after the conversation.
       */
      subject: string
      parent: ThreadMessage
      all: boolean
    }
  | { kind: 'forward'; threadId: string; subject: string; parent: ThreadMessage }

export interface ComposeDraft {
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  body: string
}

/**
 * Add a prefix unless it is already there.
 *
 * Idempotent, not normalising: `Re: Re: x` is left exactly as it is. Tidying it
 * would rewrite what the thread is called for every participant, on the
 * strength of a guess about which of them was wrong.
 */
function prefixed(subject: string, prefix: string): string {
  const trimmed = subject.trim()
  if (new RegExp(`^${prefix}:`, 'i').test(trimmed)) return trimmed
  return trimmed === '' ? `${prefix}:` : `${prefix}: ${trimmed}`
}

/** Addresses that can actually be mailed, deduped case-insensitively against
 *  everything already chosen. `Ada@syv.ai` and `ada@syv.ai` are one person. */
function pickAddresses(candidates: MailAddress[], taken: Set<string>): MailAddress[] {
  const out: MailAddress[] = []
  for (const address of candidates) {
    // An empty email means the header carried nothing mailable. Rendering it as
    // a chip would offer the user something that cannot be sent to.
    if (address.email === '') continue
    const key = address.email.toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    out.push(address)
  }
  return out
}

/** Readable, and never `Invalid Date` — a header this app did not write can
 *  hold anything, and the fallback belongs in the mail, not a crash. */
function attributionDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
}

/** The parent as markdown: its HTML converted when it has any, else the plain
 *  part. This is what makes a quoted table stay a table. */
function parentAsMarkdown(parent: ThreadMessage): string {
  if (parent.html !== null && parent.html !== '') return mailHtmlToMarkdown(parent.html)
  return parent.body
}

/** A name to attribute a quote to, falling back to the address. */
function displayName(address: MailAddress): string {
  return address.name !== '' ? address.name : address.email
}

/**
 * The quote block.
 *
 * Two leading newlines so the cursor sits on line 1, above everything — the
 * reply is written before the thing being replied to, which is the order people
 * read in even when mail clients store it the other way round.
 */
function replyBody(parent: ThreadMessage): string {
  const quoted = quoteAsMarkdown(parentAsMarkdown(parent))
  const attribution = `On ${attributionDate(parent.date)}, ${displayName(parent.from)} wrote:`
  return `\n\n---\n${attribution}\n\n${quoted}`
}

/**
 * A forward is not a reply, and saying "On … wrote:" over one misdescribes it
 * to the person receiving it. The header block below is the convention every
 * mail client uses, and it carries the fields a forward is usually sent *for*.
 */
function forwardBody(parent: ThreadMessage, subject: string): string {
  const lines = [
    '---------- Forwarded message ----------',
    `From: ${displayName(parent.from)} <${parent.from.email}>`,
    `Date: ${attributionDate(parent.date)}`,
    `Subject: ${subject}`,
    `To: ${parent.to.map((a) => a.email).filter((email) => email !== '').join(', ')}`,
  ]
  return `\n\n${lines.join('\n')}\n\n${quoteAsMarkdown(parentAsMarkdown(parent))}`
}

/**
 * Turn an intent into the composer's opening state.
 *
 * `self` is the connected address **plus every send-as alias** — both halves
 * matter. Replying to a message addressed to an alias would otherwise copy the
 * user on their own reply, which reads as a bug in the recipient's client
 * rather than in this one.
 */
export function composeFrom(intent: ComposeIntent, self: string[]): ComposeDraft {
  if (intent.kind === 'new') return { to: [], cc: [], subject: '', body: '' }

  if (intent.kind === 'forward') {
    return {
      to: [],
      cc: [],
      subject: prefixed(intent.subject, 'Fwd'),
      body: forwardBody(intent.parent, intent.subject),
    }
  }

  const { parent } = intent
  /**
   * `to` is the parent's sender, and is **not** filtered against `self`.
   *
   * It is tempting to subtract the user's own addresses here too, but the case
   * that produces is replying to your own message in a thread — which yields no
   * recipient at all, a disabled Send button, and nothing on screen explaining
   * why. An address the user can see and edit is recoverable; an empty field
   * they did not ask for is not.
   */
  const to = pickAddresses([parent.from], new Set())
  // `self` so the user is never copied on their own reply, and `to` so nobody
  // is mailed twice.
  const taken = new Set([
    ...self.map((address) => address.toLowerCase()),
    ...to.map((address) => address.email.toLowerCase()),
  ])
  const cc = intent.all ? pickAddresses([...parent.to, ...parent.cc], taken) : []

  return { to, cc, subject: prefixed(intent.subject, 'Re'), body: replyBody(parent) }
}
