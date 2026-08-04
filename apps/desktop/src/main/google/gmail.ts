/**
 * Gmail — search, read, and the stable link that goes into a note.
 *
 * **Read-only** (D67): the granted scope is `gmail.readonly`, so nothing here
 * can send, archive, or label. Composing is a `mailto:` handoff in the UI.
 *
 * **Mail is rendered as plain text, never as HTML — and that is a security
 * decision, not a styling one.** A message body is the most hostile input the
 * app handles: it is attacker-controlled by definition. Rendering it as HTML
 * would mean shipping a sanitizer and trusting it forever, and would silently
 * re-enable remote-content tracking pixels the moment anything loaded an image.
 * Extracting text instead removes the entire class by construction — the body
 * reaches the renderer as a string that is only ever placed in a text node.
 * The cost is honest: a heavily-designed newsletter reads plainly. Holi is not
 * an email client (PRD non-goal), and "open in Gmail" is one click away.
 */
import type { GoogleApi } from './api'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface MailThreadSummary {
  id: string
  subject: string
  /** The sender, preferring the display name over the raw address. */
  from: string
  /** ISO, from the message's `Date` header. */
  date: string
  snippet: string
  unread: boolean
  messageCount: number
  /** The link written into a task or note (D67). */
  webUrl: string
}

export interface MailMessage {
  id: string
  from: string
  to: string[]
  date: string
  /** Plain text. See the module note: never HTML. */
  body: string
}

export interface MailThread {
  id: string
  subject: string
  webUrl: string
  messages: MailMessage[]
}

interface RawHeader {
  name?: string
  value?: string
}

interface RawPart {
  mimeType?: string
  filename?: string
  headers?: RawHeader[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: RawPart[]
}

interface RawMessage {
  id?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: RawPart
}

interface RawThread {
  id?: string
  messages?: RawMessage[]
}

/**
 * The account-portable permalink for a message.
 *
 * **Not `/mail/u/0/#inbox/<id>`.** The `u/N` segment is a *login slot*, not an
 * account: with two Google accounts signed in, `u/0` is whoever logged in
 * first, so a saved link opens the wrong mailbox — or nothing. Searching by
 * RFC-822 message id resolves against whichever account actually holds the
 * message, which is what makes the link survive in a file that outlives the
 * session that wrote it.
 */
export function messageUrl(rfc822MessageId: string | null, threadId: string): string {
  if (rfc822MessageId === null || rfc822MessageId === '') {
    // No Message-ID header (rare, but legal). The thread id still opens, in
    // whatever account is slot 0 — worse, and only used when there is no better.
    return `https://mail.google.com/mail/u/0/#all/${threadId}`
  }
  const bare = rfc822MessageId.replace(/^</, '').replace(/>$/, '')
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`rfc822msgid:${bare}`)}`
}

function headerOf(part: RawPart | undefined, name: string): string | null {
  const found = part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
  return found?.value ?? null
}

/** `"Nicolai Thomsen" <nicolai@syv.ai>` → `Nicolai Thomsen`; a bare address is
 *  returned as-is. Display beats precision here — a list of addresses is much
 *  harder to scan than a list of names. */
function displayName(address: string | null): string {
  if (address === null) return ''
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(address)
  const name = match?.[1]?.trim()
  return name !== undefined && name !== '' ? name : address.trim()
}

function addresses(value: string | null): string[] {
  if (value === null) return []
  // Split on commas that are not inside quotes — a display name may contain one
  // ("Thomsen, Nicolai" <…>), and splitting naively mangles it into two people.
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((a) => displayName(a))
    .filter((a) => a !== '')
}

/** Gmail encodes body data as base64**url**; plain base64 decoding corrupts any
 *  message containing a `-` or `_` in its payload. */
function decodeBody(data: string | undefined): string {
  if (data === undefined || data === '') return ''
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Find the best text for a message, walking the MIME tree.
 *
 * Prefers `text/plain`; falls back to converting `text/html`. Attachments are
 * skipped — a part with a filename is a file, not the message.
 */
export function bodyTextOf(payload: RawPart | undefined): string {
  const plain = findPart(payload, 'text/plain')
  if (plain !== null) return decodeBody(plain.body?.data).trim()

  const html = findPart(payload, 'text/html')
  if (html !== null) return htmlToText(decodeBody(html.body?.data))

  // A single-part message carries its body on the payload itself.
  return decodeBody(payload?.body?.data).trim()
}

function findPart(part: RawPart | undefined, mimeType: string): RawPart | null {
  if (part === undefined) return null
  // An attachment is never the message body, even when its type matches.
  const isAttachment = part.filename !== undefined && part.filename !== ''
  if (part.mimeType === mimeType && !isAttachment && part.body?.data !== undefined) return part
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType)
    if (found !== null) return found
  }
  return null
}

/**
 * HTML → readable text.
 *
 * **This is a formatter, not a sanitizer**, and the distinction matters: safety
 * comes from the result being rendered into a text node, never as markup. If
 * this function let something through, nothing would execute it.
 */
export function htmlToText(html: string): string {
  return html
    // Content that is not prose at all, dropped whole rather than flattened.
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // A paragraph-level close is a blank line; a row or list item is a single
    // break. Treating them alike runs prose together into one wall.
    .replace(/<\/(p|div|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<\/(tr|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Collapse the runs of blank lines HTML mail is made of.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Bounded concurrency: Gmail's list gives ids only, so a list view is N+1
 *  requests. Firing 25 at once invites a rate-limit; a small pool does not. */
async function mapPooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

export interface ListThreadsOptions {
  /** Gmail's own search grammar, passed through verbatim (`from:x is:unread`).
   *  Empty means the inbox. */
  query?: string
  limit?: number
}

/**
 * Threads matching a query, newest first.
 *
 * Gmail's list endpoint returns **ids and a snippet, nothing else** — no
 * subject, no sender — so each thread is fetched at `metadata` detail to fill
 * the row. That is the N+1 this pools; asking for `full` here would download
 * every body to render a list.
 */
export async function listThreads(
  api: GoogleApi,
  options: ListThreadsOptions = {},
): Promise<MailThreadSummary[]> {
  const page = await api.get<{ threads?: { id?: string }[] }>(`${BASE}/threads`, {
    q: options.query !== undefined && options.query !== '' ? options.query : 'in:inbox',
    maxResults: String(options.limit ?? 25),
  })

  const ids = (page.threads ?? []).map((t) => t.id).filter((id): id is string => id !== undefined)

  const threads = await mapPooled(ids, 5, (id) =>
    api.get<RawThread>(`${BASE}/threads/${id}`, {
      format: 'metadata',
      // Repeated query keys are how Gmail takes a list; `GoogleApi.get` builds
      // one param per key, so the headers are requested as a single joined
      // value — Gmail accepts the comma form.
      metadataHeaders: 'Subject,From,Date,Message-ID',
    }),
  )

  return threads.map(summarize).filter((t): t is MailThreadSummary => t !== null)
}

function summarize(thread: RawThread): MailThreadSummary | null {
  const messages = thread.messages ?? []
  const first = messages[0]
  const last = messages[messages.length - 1]
  if (thread.id === undefined || first === undefined || last === undefined) return null

  return {
    id: thread.id,
    // The subject comes from the FIRST message: replies carry "Re:" prefixes
    // and a thread renamed mid-conversation would otherwise change identity.
    subject: headerOf(first.payload, 'Subject')?.trim() || '(no subject)',
    // The sender comes from the LAST: "who wrote most recently" is what a list
    // is scanned for.
    from: displayName(headerOf(last.payload, 'From')),
    date: isoDate(last),
    snippet: last.snippet ?? '',
    // Unread if ANY message in the thread is — that is what Gmail's own bolding
    // means, and the thread is the unit the user acts on.
    unread: messages.some((m) => m.labelIds?.includes('UNREAD') === true),
    messageCount: messages.length,
    webUrl: messageUrl(headerOf(first.payload, 'Message-ID'), thread.id),
  }
}

/** `internalDate` is epoch ms as a string, and is the reliable one — the `Date`
 *  header is written by the sender and is routinely wrong or absent. */
function isoDate(message: RawMessage): string {
  const internal = Number(message.internalDate)
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString()
  const header = headerOf(message.payload, 'Date')
  const parsed = header === null ? NaN : Date.parse(header)
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString()
}

/** One thread, with every message's text. */
export async function readThread(api: GoogleApi, threadId: string): Promise<MailThread> {
  const thread = await api.get<RawThread>(`${BASE}/threads/${threadId}`, { format: 'full' })
  const messages = thread.messages ?? []
  const first = messages[0]

  return {
    id: threadId,
    subject: headerOf(first?.payload, 'Subject')?.trim() || '(no subject)',
    webUrl: messageUrl(headerOf(first?.payload, 'Message-ID'), threadId),
    messages: messages.map((message) => ({
      id: message.id ?? '',
      from: displayName(headerOf(message.payload, 'From')),
      to: addresses(headerOf(message.payload, 'To')),
      date: isoDate(message),
      body: bodyTextOf(message.payload),
    })),
  }
}
