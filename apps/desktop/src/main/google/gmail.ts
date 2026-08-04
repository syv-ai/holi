/**
 * Gmail — search, read, and the stable link that goes into a note.
 *
 * **Read-only** (D67): the granted scope is `gmail.readonly`, so nothing here
 * can send, archive, or label. Composing is a `mailto:` handoff in the UI.
 *
 * **A message carries both representations, and each consumer gets the one it
 * wants.** `body` is plain text — the sender's own `text/plain` part when there
 * is one, converted from HTML when there is not. `html` is the raw HTML part,
 * untouched, or `null`.
 *
 * - The **UI** reads `html`, and sanitizes it in the renderer
 *   (`renderer/src/lib/mail-html.ts`, which also blocks remote content by
 *   default). Mail is designed, and a reader that flattens every newsletter to
 *   text is not a mail reader.
 * - The **agent** reads `body`, via `textOnly()` below. An LLM wants prose, not
 *   a table layout, and markup would be tokens spent on nothing.
 *
 * Nothing here sanitizes, and that is deliberate: main hands over exactly what
 * Google returned, so there is one sanitizer, in the one process with a DOM,
 * rather than two half-measures that each assume the other did the work.
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
  /**
   * The last message in the thread is one the user sent — so they have replied
   * and are waiting on the other side.
   *
   * Deliberately not "a sent message exists somewhere in this thread": in a long
   * back-and-forth that is true forever, which makes it useless for the question
   * a mail list is actually scanned for ("what still needs me?").
   */
  answered: boolean
  messageCount: number
  /** The link written into a task or note (D67). */
  webUrl: string
}

export interface MailMessage {
  id: string
  from: string
  to: string[]
  date: string
  /** Plain text, for the agent and as the UI's fallback. See the module note. */
  body: string
  /** The raw HTML part, or `null`. **Unsanitized** — the renderer sanitizes it
   *  before it becomes markup, and nothing else may render it. */
  html: string | null
}

/** What the agent sees: the same thread with the markup removed. */
export type AgentMailMessage = Omit<MailMessage, 'html'>

export interface AgentMailThread {
  id: string
  subject: string
  webUrl: string
  messages: AgentMailMessage[]
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

/**
 * The message's HTML, exactly as Google returned it, or `null`.
 *
 * Verbatim on purpose. Trimming or pre-stripping here would give the renderer's
 * sanitizer a subtly different input from the one it is tested against, and
 * would invite the belief that main already made this safe. It did not.
 */
export function bodyHtmlOf(payload: RawPart | undefined): string | null {
  // `findPart` matches the payload itself, so a single-part HTML message needs
  // no separate branch here.
  const html = findPart(payload, 'text/html')
  if (html === null) return null
  const raw = decodeBody(html.body?.data)
  // An empty part is "no HTML", not "empty HTML" — the UI branches on null, and
  // a blank string would render a blank message instead of the text body.
  return raw === '' ? null : raw
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
      // An ARRAY, so `GoogleApi.get` emits one `metadataHeaders=` per name.
      // Comma-joining these is not a shorthand — Gmail reads the whole string
      // as one header name, matches nothing, and returns 200 with no headers,
      // which renders every thread as "(no subject)" from an empty sender.
      metadataHeaders: ['Subject', 'From', 'Date', 'Message-ID'],
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
    // `SENT` is Gmail's own label for "this account sent this", so it needs no
    // comparison against the connected address — which would be wrong anyway
    // for aliases and send-as addresses.
    answered: last.labelIds?.includes('SENT') === true,
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

/** One thread, with every message in both representations (see the module note). */
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
      html: bodyHtmlOf(message.payload),
    })),
  }
}

/**
 * The thread as the agent should see it: text bodies, no markup.
 *
 * Applied at the ops server (`main/index.ts`) rather than left to the agent to
 * ignore. Two reasons, and the second is the one that matters: an HTML body is
 * many times the size of its text twin, so shipping it would spend the agent's
 * context on table layout; and unsanitized markup should exist in exactly one
 * place, which is the renderer that sanitizes it. Sending it down a second path
 * means a second consumer that might one day render it.
 */
export function textOnly(thread: MailThread): AgentMailThread {
  return {
    id: thread.id,
    subject: thread.subject,
    webUrl: thread.webUrl,
    messages: thread.messages.map(({ html: _html, ...message }) => message),
  }
}
