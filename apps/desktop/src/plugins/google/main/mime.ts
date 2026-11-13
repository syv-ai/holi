/**
 * RFC-822 assembly: the pure half of sending mail.
 *
 * Gmail's `messages.send` and `drafts.create` do not take a structured message.
 * They take `{ raw }`: an entire RFC-822 document, base64url-encoded. So the
 * difference between a mail that threads correctly and one that does not is a
 * header written here, not a parameter passed there.
 *
 * No network, no `GoogleApi`, so it can be tested exhaustively without talking
 * to Google. Everything below is a failure that would otherwise be discovered
 * by a recipient.
 */

import { randomBytes } from 'node:crypto'

/** A file travelling with a message: a forwarded message's (the composer has
 *  no file picker) or a vault file the agent attached (`attachments.ts`). */
export interface MailPart {
  filename: string
  mimeType: string
  /**
   * **Standard base64**, not base64url. `attachments.get` returns base64url and
   * the two differ in three characters; converting is `fetchAttachment`'s job
   * because that is where the wire format is known. Forgetting it produces a
   * file that opens as garbage, visible only to the recipient.
   */
  data: string
  /** Preserve inline images when a foreign draft is reopened and saved. */
  disposition?: 'attachment' | 'inline'
  contentId?: string
}

/** A message to be sent or drafted. */
export interface OutgoingMail {
  to: string[]
  subject: string
  /**
   * The markdown source, which doubles as the `text/plain` part. UTF-8;
   * newlines are content and are left alone. Markdown is chosen as the plain
   * alternative deliberately: it is what the user wrote, and it reads as prose
   * to a client that will not show the HTML.
   */
  body: string
  cc?: string[]
  bcc?: string[]
  /** The RFC-822 `Message-ID` of the message being answered. */
  inReplyTo?: string
  /** The thread's `Message-ID` chain, oldest first, including `inReplyTo`. */
  references?: string[]
  /**
   * The rendered, sanitised HTML of `body`. Present promotes the message to
   * `multipart/alternative`; absent leaves the single-part shape.
   */
  html?: string
  /** Present and non-empty wraps everything in a `multipart/mixed`. */
  attachments?: MailPart[]
}

/**
 * The header that makes a draft Holi wrote reopen byte-exact.
 *
 * Written **unconditionally**: the agent composes markdown too, and this is what
 * lets the composer open a draft the agent wrote without guessing. Its absence
 * is not a gate. A draft that lacks it is converted with `turndown` and opens
 * anyway.
 */
const SOURCE_HEADER: [string, string] = ['X-Holi-Source', 'markdown']

const CRLF = '\r\n'

/**
 * A header value may not contain a line break.
 *
 * Rejected rather than stripped, deliberately. These strings are composed by an
 * LLM out of the user's prose, so a `\n` in a subject is either a mistake worth
 * surfacing or an injected `Bcc:` worth refusing, and quietly removing it would
 * send a *different* message than the one that was asked for.
 */
function assertNoNewline(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} contains a newline, which is not allowed in a mail header`)
  }
}

/** True when every character is plain ASCII, so a header can hold it verbatim. */
function isAscii(value: string): boolean {
  return !/[^\x00-\x7F]/.test(value)
}

/**
 * RFC 2047 encoded-word, for a header carrying non-ASCII.
 *
 * `Subject: Møde på tirsdag` is not legal and does not survive every hop. The
 * `B` (base64) form is used rather than `Q` because it needs no second escaping
 * scheme.
 */
function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * A body, and the headers that describe it.
 *
 * The same shape serves the whole message and any part nested inside it, so
 * `multipart/mixed` wrapping a `multipart/alternative` needs no second path.
 */
interface Body {
  headers: [string, string][]
  content: string
}

function render(body: Body): string {
  const head = body.headers.map(([name, value]) => foldHeader(name, value)).join(CRLF)
  return `${head}${CRLF}${CRLF}${body.content}`
}

/** Fold only between MIME parameters, where the inserted whitespace is legal. */
function foldHeader(name: string, value: string): string {
  const complete = `${name}: ${value}`
  if (Buffer.byteLength(complete, 'utf8') <= 78) return complete
  const segments: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (escaped) escaped = false
    else if (char === '\\' && quoted) escaped = true
    else if (char === '"') quoted = !quoted
    else if (!quoted && char === ';' && value[index + 1] === ' ') {
      segments.push(value.slice(start, index))
      start = index + 2
      index++
    }
  }
  segments.push(value.slice(start))
  const lines = [`${name}: ${segments.shift()}`]
  for (const segment of segments) {
    const line = lines.at(-1)!
    if (Buffer.byteLength(`${line}; ${segment}`, 'utf8') <= 78) {
      lines[lines.length - 1] = `${line}; ${segment}`
    } else {
      lines[lines.length - 1] = `${line};`
      lines.push(` ${segment}`)
    }
  }
  return lines.join(CRLF)
}

/**
 * A leaf carrying text, base64'd and wrapped.
 *
 * **Not `8bit`, and the reason is line length rather than the charset.** RFC
 * 5322 caps a line at 998 octets, and a long paragraph is one logical line
 * (`marked` renders it as a single `<p>…</p>`). Base64 makes the limit
 * structural, and reuses the wrapper already trusted for attachments rather
 * than a quoted-printable encoder with its own escaping rules.
 *
 * Nothing downstream sees the difference: Gmail's API returns a part's body
 * already decoded from its transfer encoding, so `readDraft` reads the same
 * bytes back either way, and Gmail re-encodes on delivery regardless.
 */
function textBody(mimeType: string, content: string): Body {
  return {
    headers: [
      // Declared explicitly: without a charset the body is read as US-ASCII,
      // and a Danish sentence arrives as mojibake having been sent perfectly.
      ['Content-Type', `${mimeType}; charset="UTF-8"`],
      ['Content-Transfer-Encoding', 'base64'],
    ],
    content: wrapBase64(Buffer.from(content, 'utf8').toString('base64')),
  }
}

/**
 * A filename as a header parameter.
 *
 * A quote inside a quoted string ends it early, which turns the rest of the
 * filename into header syntax: the same class of hole `assertNoNewline`
 * closes, reached through a forwarded message's headers.
 */
function quoteParameter(value: string): string {
  // The encoded word is quoted too: its `=` and `?` are not legal bare in a
  // parameter value, and a strict parser drops the whole parameter.
  return `"${(isAscii(value) ? value : encodeHeaderWord(value)).replace(/[\\"]/g, '\\$&')}"`
}

/**
 * A non-ASCII filename as RFC 2231 says it (`filename*=UTF-8''%C3%B8.pdf`),
 * beside the RFC 2047 word `quoteParameter` writes when the value is short.
 * Long values use indexed RFC 2231 continuation parameters instead.
 */
function extendedParameter(name: string, value: string): string {
  // Encode UTF-8 bytes as attr-chars or complete %HH triplets. A continuation
  // may end between characters, but never inside a triplet.
  const encoded = [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      return /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
  const chunks: string[] = []
  for (const token of encoded.match(/%[0-9A-F]{2}|./g) ?? []) {
    const current = chunks.at(-1)
    if (current && current.length + token.length <= 48) {
      chunks[chunks.length - 1] = current + token
    } else {
      chunks.push(token)
    }
  }
  return chunks
    .map((chunk, index) => `; ${name}*${index}*=${index === 0 ? "UTF-8''" : ''}${chunk}`)
    .join('')
}

function filenameParameters(name: string, value: string): string {
  const quoted = `${name}=${quoteParameter(value)}`
  const extended = !isAscii(value)
    ? `; ${name}*=UTF-8''${encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
    : ''
  // Keep the existing compact ASCII and dual-format Unicode form when it
  // fits comfortably. Long values use RFC 2231 continuations in place of one
  // unbroken quoted/extended parameter.
  if (Buffer.byteLength(quoted + extended, 'utf8') <= 60) return `; ${quoted}${extended}`
  return extendedParameter(name, value)
}

/** Base64 wrapped at 76 columns. A line over 998 octets is refused outright by
 *  some servers and silently truncated by others; both arrive as a broken file. */
function wrapBase64(data: string): string {
  return (data.replace(/\s+/g, '').match(/.{1,76}/g) ?? []).join(CRLF)
}

function attachmentBody(part: MailPart): Body {
  assertNoNewline(part.filename, 'attachment filename')
  assertNoNewline(part.mimeType, 'attachment mimeType')
  return {
    headers: [
      ['Content-Type', `${part.mimeType}${filenameParameters('name', part.filename)}`],
      [
        'Content-Disposition',
        `${part.disposition ?? 'attachment'}${filenameParameters('filename', part.filename)}`,
      ],
      ...(part.contentId === undefined ? [] : [['Content-ID', part.contentId] as [string, string]]),
      ['Content-Transfer-Encoding', 'base64'],
    ],
    content: wrapBase64(part.data),
  }
}

/**
 * A boundary that occurs in no part it is about to delimit.
 *
 * Asserted and regenerated rather than assumed absent. A collision truncates
 * the message at that point, visible only to the recipient, and forwarding a
 * forward is enough to produce one.
 */
function uniqueBoundary(parts: string[], make: () => string): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const boundary = make()
    if (!parts.some((part) => part.includes(boundary))) return boundary
  }
  throw new Error('could not generate a MIME boundary absent from the message')
}

function multipartBody(subtype: string, parts: Body[], boundary: string): Body {
  const rendered = parts.map(render).join(`${CRLF}--${boundary}${CRLF}`)
  return {
    headers: [
      ['Content-Type', `multipart/${subtype}; boundary="${boundary}"`],
      // A multipart is not itself encoded: the leaves carry their own.
      ['Content-Transfer-Encoding', '7bit'],
    ],
    content: `--${boundary}${CRLF}${rendered}${CRLF}--${boundary}--${CRLF}`,
  }
}

/** The default generator. Long and random enough that `uniqueBoundary` never
 *  loops in practice. */
function randomBoundary(): string {
  return `----=_Holi_${randomBytes(16).toString('hex')}`
}

/**
 * Build the message.
 *
 * **`References` is not optional on a reply.** Gmail threads on it; with
 * `In-Reply-To` alone the message sends, returns an id, and appears as a new
 * thread. Nothing about the response says so, which is why `replyToThread`
 * always passes both.
 *
 * One function, three shapes, chosen by what was supplied: text alone,
 * `multipart/alternative` when `html` is present, and that wrapped in a
 * `multipart/mixed` when there are attachments. The single-part path is pinned
 * byte for byte by a test.
 *
 * `makeBoundary` is injectable so tests can assert where each boundary landed;
 * production never passes it.
 */
export function buildRfc822(
  mail: OutgoingMail,
  makeBoundary: () => string = randomBoundary,
): string {
  for (const address of mail.to) assertNoNewline(address, 'to')
  for (const address of mail.cc ?? []) assertNoNewline(address, 'cc')
  for (const address of mail.bcc ?? []) assertNoNewline(address, 'bcc')
  assertNoNewline(mail.subject, 'subject')
  if (mail.inReplyTo !== undefined) assertNoNewline(mail.inReplyTo, 'inReplyTo')
  for (const reference of mail.references ?? []) assertNoNewline(reference, 'references')

  /**
   * An html part that rendered to nothing *from prose that exists* is a bug in
   * the renderer, and it reaches the recipient as a blank message. An empty
   * body rendering to nothing is not that bug (an empty message is allowed to
   * send), so the two cases are separated rather than both refused.
   *
   * Trimmed, because `marked` renders whitespace to nothing quite correctly.
   */
  if (mail.html === '' && mail.body.trim() !== '') {
    throw new Error('html is empty while the body is not — the render produced nothing')
  }

  const headers: [string, string][] = [['To', mail.to.join(', ')]]
  if (mail.cc !== undefined && mail.cc.length > 0) headers.push(['Cc', mail.cc.join(', ')])
  if (mail.bcc !== undefined && mail.bcc.length > 0) headers.push(['Bcc', mail.bcc.join(', ')])
  headers.push(['Subject', encodeHeaderWord(mail.subject)])
  if (mail.inReplyTo !== undefined) headers.push(['In-Reply-To', mail.inReplyTo])
  // Space-separated, per RFC 5322, not commas.
  if (mail.references !== undefined && mail.references.length > 0) {
    headers.push(['References', mail.references.join(' ')])
  }
  headers.push(['MIME-Version', '1.0'])
  headers.push(SOURCE_HEADER)

  const plain = textBody('text/plain', mail.body)
  // Least rich first. Reversed, every client that prefers the last acceptable
  // part shows the plain text.
  const content =
    mail.html === undefined || mail.html === ''
      ? plain
      : multipartBody(
          'alternative',
          [plain, textBody('text/html', mail.html)],
          uniqueBoundary([mail.body, mail.html], makeBoundary),
        )

  const attachments = mail.attachments ?? []
  // An empty `multipart/mixed` is legal and displays as a message with a
  // mysteriously missing attachment, so an empty list takes the path above.
  const root =
    attachments.length === 0
      ? content
      : (() => {
          const parts = [content, ...attachments.map(attachmentBody)]
          return multipartBody('mixed', parts, uniqueBoundary(parts.map(render), makeBoundary))
        })()

  // CRLF throughout, including between parts and around the closing delimiter.
  // A bare `\n` is out of spec; the servers that care reject the whole message
  // rather than the offending line.
  return render({ headers: [...headers, ...root.headers], content: root.content })
}

/**
 * base64**url**: `+`→`-`, `/`→`_`, no padding. Gmail rejects standard base64
 * here; the named function is the documentation.
 */
export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}
