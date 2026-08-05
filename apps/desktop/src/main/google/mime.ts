/**
 * RFC-822 assembly — the pure half of sending mail (D70).
 *
 * Gmail's `messages.send` and `drafts.create` do not take a structured message.
 * They take `{ raw }`: an entire RFC-822 document, base64url-encoded. So the
 * difference between a mail that threads correctly and one that does not is a
 * header written here, not a parameter passed there.
 *
 * No network, no `GoogleApi` — this is the piece that can be tested exhaustively
 * without talking to Google, which matters in a pillar where nothing else can be
 * (D69). Everything below is a failure that would otherwise be discovered by a
 * recipient.
 */

/** A message to be sent or drafted. Plain text only — see `htmlToText` in
 *  `gmail.ts` for why the agent's half of this connector has no markup. */
export interface OutgoingMail {
  to: string[]
  subject: string
  /** Plain text, UTF-8. Newlines are content and are left alone. */
  body: string
  cc?: string[]
  /** The RFC-822 `Message-ID` of the message being answered. */
  inReplyTo?: string
  /** The thread's `Message-ID` chain, oldest first, including `inReplyTo`. */
  references?: string[]
}

/**
 * A header value may not contain a line break.
 *
 * Rejected rather than stripped, and that is deliberate. These strings are
 * composed by an LLM out of the user's prose, so a `\n` in a subject is either
 * a mistake worth surfacing or an injected `Bcc:` worth refusing — and quietly
 * removing it would send a *different* message than the one that was asked for,
 * which is the worse outcome of the two.
 */
function assertNoNewline(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} contains a newline, which is not allowed in a mail header`)
  }
}

/** True when every character is plain ASCII, so a header can hold it verbatim. */
function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x00-\x7F]/.test(value)
}

/**
 * RFC 2047 encoded-word, for a header carrying non-ASCII.
 *
 * `Subject: Møde på tirsdag` is not legal and does not survive every hop — it
 * arrives as mojibake or not at all. The `B` (base64) form is used rather than
 * `Q` because it is one line of code instead of a second escaping scheme, and
 * no subject written here is long enough for the size difference to matter.
 */
function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * Build the message.
 *
 * **`References` is not optional on a reply.** Gmail threads on it; with
 * `In-Reply-To` alone the message sends, returns an id, and appears as a new
 * thread. Nothing about the response says so, which is why `replyToThread`
 * always passes both and the test asserts both.
 */
export function buildRfc822(mail: OutgoingMail): string {
  for (const address of mail.to) assertNoNewline(address, 'to')
  for (const address of mail.cc ?? []) assertNoNewline(address, 'cc')
  assertNoNewline(mail.subject, 'subject')
  if (mail.inReplyTo !== undefined) assertNoNewline(mail.inReplyTo, 'inReplyTo')
  for (const reference of mail.references ?? []) assertNoNewline(reference, 'references')

  const headers: [string, string][] = [['To', mail.to.join(', ')]]
  if (mail.cc !== undefined && mail.cc.length > 0) headers.push(['Cc', mail.cc.join(', ')])
  headers.push(['Subject', encodeHeaderWord(mail.subject)])
  if (mail.inReplyTo !== undefined) headers.push(['In-Reply-To', mail.inReplyTo])
  // Space-separated, per RFC 5322 — not commas, which is the intuitive guess.
  if (mail.references !== undefined && mail.references.length > 0) {
    headers.push(['References', mail.references.join(' ')])
  }
  headers.push(['MIME-Version', '1.0'])
  // Declared explicitly: without a charset the body is read as US-ASCII, and a
  // Danish sentence arrives as mojibake having been sent perfectly.
  headers.push(['Content-Type', 'text/plain; charset="UTF-8"'])
  headers.push(['Content-Transfer-Encoding', '8bit'])

  // CRLF throughout. A bare `\n` is out of spec; the servers that care reject
  // the whole message rather than the offending line.
  return `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${mail.body}`
}

/**
 * base64**url** — `+`→`-`, `/`→`_`, no padding.
 *
 * Gmail rejects standard base64 here. Node's `'base64url'` encoding does all
 * three, so this is a named function rather than an inline call only because
 * the name is the documentation: the next person reaching for `.toString(
 * 'base64')` has something to collide with.
 */
export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}
