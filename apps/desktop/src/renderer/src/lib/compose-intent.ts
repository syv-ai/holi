/**
 * What the composer is being opened *for* (D71).
 *
 * A discriminated union, so a typo in the kind is a compile error rather than
 * a silently empty composer. Everything here is a rule about who receives a
 * message: bugs the sender never sees.
 *
 * `In-Reply-To` and `References` are not here: main resolves them per send
 * and per save from a fresh thread read, since a saved draft may be sent from
 * a phone.
 */
import { mailHtmlToMarkdown, quoteAsMarkdown } from './mail-unmarkdown'
import type { MailAddress, ThreadMessage } from './mail-types'

export type ComposeIntent =
  | { kind: 'new' }
  | {
      kind: 'reply'
      threadId: string
      /** The thread's subject: `ThreadMessage` carries none. */
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
 * Idempotent, not normalising: `Re: Re: x` is left alone, since tidying would
 * rename the thread for every participant.
 */
function prefixed(subject: string, prefix: string): string {
  const trimmed = subject.trim()
  if (new RegExp(`^${prefix}:`, 'i').test(trimmed)) return trimmed
  return trimmed === '' ? `${prefix}:` : `${prefix}: ${trimmed}`
}

/** Mailable addresses, deduped case-insensitively against `taken`. */
function pickAddresses(candidates: MailAddress[], taken: Set<string>): MailAddress[] {
  const out: MailAddress[] = []
  for (const address of candidates) {
    // Nothing mailable in the header: no chip.
    if (address.email === '') continue
    const key = address.email.toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    out.push(address)
  }
  return out
}

/** Readable, and never `Invalid Date`: a foreign header can hold anything. */
function attributionDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
}

/** The parent as markdown: its HTML converted when it has any, else the plain
 *  part. */
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
 * Two leading newlines so the cursor sits on line 1: the reply goes above the
 * quote.
 */
function replyBody(parent: ThreadMessage): string {
  const quoted = quoteAsMarkdown(parentAsMarkdown(parent))
  const attribution = `On ${attributionDate(parent.date)}, ${displayName(parent.from)} wrote:`
  return `\n\n---\n${attribution}\n\n${quoted}`
}

/**
 * A forward gets the conventional header block, not "On … wrote:".
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
 * `self` is the connected address plus every send-as alias, or replying to a
 * message sent to an alias would copy the user on their own reply.
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
   * `to` is the parent's sender, not filtered against `self`: replying to your
   * own message would otherwise leave no recipient and an unexplained disabled
   * Send. A visible address is editable; an empty field is a mystery.
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
