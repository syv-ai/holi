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
import { fetchLabelNames } from './labels'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Gmail's own inbox tabs. `primary` is what Gmail calls `CATEGORY_PERSONAL`
 *  internally — the two names are not interchangeable in the API. */
export type MailCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums'

/**
 * A person on a message, as the header spelled them.
 *
 * Both halves are kept: `name` is what a list shows, `email` is what identifies
 * them. See `parseAddress` for why keeping only the name was a mistake.
 */
export interface MailAddress {
  /** The display name, falling back to the address when the header had none. */
  name: string
  /** The bare address, lowercased, or `''` when the header carried nothing that
   *  looks like one. Empty means "do not offer a mailto:". */
  email: string
}

export interface MailThreadSummary {
  id: string
  subject: string
  /** The sender of the most recent message. */
  from: MailAddress
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
  starred: boolean
  important: boolean
  /**
   * An unsent draft sits in this thread — you started replying and stopped.
   *
   * A third state, distinct from both `answered` and untouched, and the one
   * most easily forgotten: nothing else in the list says it exists.
   */
  hasDraft: boolean
  category: MailCategory | null
  /**
   * The labels the user filed this under. Ids at this layer; `listThreads`
   * resolves them to names through `labels.ts` before the summary leaves main.
   * Gmail's own system labels are excluded — INBOX and UNREAD are not filing.
   */
  labels: string[]
  /** From the List-Unsubscribe header: a URL to **open**, never a request Holi
   *  sends. The `mailto:` form is ignored — acting on it would mean composing
   *  mail on the user's behalf, which the read-only scope forbids anyway. */
  unsubscribeUrl: string | null
}

export interface MailAttachment {
  filename: string
  mimeType: string
  /** Bytes, from the part's `body.size`. */
  size: number
}

export interface MailMessage {
  id: string
  from: MailAddress
  to: MailAddress[]
  /** Who else saw this. A reply-all is a different act from a reply, and this
   *  header is the only thing that says which one is called for. */
  cc: MailAddress[]
  date: string
  /** Every part with a filename, however deep. **No extra request** — the
   *  thread is already fetched at `format=full`, so the parts are in hand. */
  attachments: MailAttachment[]
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

/**
 * `"Nicolai Thomsen" <nicolai@syv.ai>` → `{ name, email }`.
 *
 * **Both halves travel**, where this used to keep only the name. The name is
 * still what a list shows — a column of addresses is far harder to scan than a
 * column of names — but the address is the only thing that identifies a person,
 * and dropping it in the parser meant nothing downstream could ever offer a
 * `mailto:`, group two spellings of the same colleague, or say who a sender
 * actually is. A renderer cannot recover what main threw away.
 *
 * `email` is lowercased because addresses are compared, not just shown, and the
 * local part's case is not significant in any mail system anyone uses. `name`
 * falls back to the address so a display always has something to print.
 */
function parseAddress(value: string | null): MailAddress {
  if (value === null) return { name: '', email: '' }
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value)
  if (match !== null) {
    const email = match[2]!.trim().toLowerCase()
    const name = match[1]!.trim()
    return { name: name === '' ? email : name, email }
  }
  // A bare address, or a header this pattern does not fit. Treated as an
  // address when it looks like one at all, so `mailto:` still works.
  const bare = value.trim()
  return { name: bare, email: bare.includes('@') ? bare.toLowerCase() : '' }
}

function parseAddresses(value: string | null): MailAddress[] {
  if (value === null) return []
  // Split on commas that are not inside quotes — a display name may contain one
  // ("Thomsen, Nicolai" <…>), and splitting naively mangles it into two people.
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((a) => parseAddress(a))
    .filter((a) => a.name !== '')
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

/**
 * Every attachment in a message, however deep in the MIME tree.
 *
 * **A filename is what makes a part a file.** That is the same rule `findPart`
 * uses in reverse to refuse an attachment as the body — one definition, read
 * from both ends, rather than two that can drift apart.
 */
export function attachmentsOf(part: RawPart | undefined): MailAttachment[] {
  if (part === undefined) return []
  const here: MailAttachment[] =
    part.filename !== undefined && part.filename !== ''
      ? [
          {
            filename: part.filename,
            mimeType: part.mimeType ?? 'application/octet-stream',
            size: part.body?.size ?? 0,
          },
        ]
      : []
  return [...here, ...(part.parts ?? []).flatMap((child) => attachmentsOf(child))]
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
  /** From a previous page's `nextPageToken`. */
  pageToken?: string
  /**
   * Composed into the Gmail query as `category:<name>`.
   *
   * A **query**, not a client-side filter: Gmail's grammar already has
   * `category:primary`, the search box passes that grammar through verbatim,
   * and composing the two keeps one way to narrow a list instead of two that
   * can disagree.
   */
  category?: MailCategory
  /**
   * Only threads with something unread in them, as `is:unread`.
   *
   * Composed the same way `category` is, and for the same reason — but note the
   * two behave differently at the UI, deliberately. A category is a *place*, so
   * a search leaves it; unread is a *state*, so a search keeps it. That choice
   * belongs to the caller; this just ANDs what it is given.
   */
  unread?: boolean
}

export interface MailPage {
  threads: MailThreadSummary[]
  /** `null` when there is nothing more to load. */
  nextPageToken: string | null
  /** When these threads were actually obtained from Google, ISO. The footer
   *  shows it, and a served-from-cache page carries the *cache's* time rather
   *  than now — the whole point is to say how old what you are reading is. */
  syncedAt: string
}

/**
 * How much mail there is, from Gmail's own bookkeeping.
 *
 * **Exact, not an estimate.** `labels.get` returns counts Gmail maintains for
 * the label; this is not `resultSizeEstimate`, which the category picker
 * deliberately refuses to show because it is approximate and a wrong number is
 * worse than no number. One request, and it answers for the whole mailbox
 * rather than the page in hand.
 */
export interface MailCounts {
  /** Threads in the inbox with something unread in them. */
  unread: number
  /** Threads in the inbox, read or not. */
  total: number
}

const INBOX_URL = `${BASE}/labels/INBOX`

/** A failure returns `null`, never throws: the count is a footer decoration,
 *  and losing it must cost the number rather than the mail it sits under. */
export async function fetchMailCounts(api: GoogleApi): Promise<MailCounts | null> {
  try {
    const label = await api.get<{ threadsTotal?: number; threadsUnread?: number }>(INBOX_URL)
    return { unread: label.threadsUnread ?? 0, total: label.threadsTotal ?? 0 }
  } catch {
    return null
  }
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
): Promise<MailPage> {
  const page = await api.get<{ threads?: { id?: string }[]; nextPageToken?: string }>(
    `${BASE}/threads`,
    {
      q: composeQuery(options),
      maxResults: String(options.limit ?? 25),
      pageToken: options.pageToken,
    },
  )

  const ids = (page.threads ?? []).map((t) => t.id).filter((id): id is string => id !== undefined)

  return {
    threads: await fetchThreadSummaries(api, ids),
    // `undefined` means "no further page" on the wire; `null` says it on the
    // type, so a caller cannot mistake "not asked" for "nothing left".
    nextPageToken: page.nextPageToken ?? null,
    syncedAt: new Date().toISOString(),
  }
}

/**
 * Summaries for a known set of thread ids, in the order given.
 *
 * The N+1 in one place: `listThreads` uses it for a whole page, and
 * `mail-sync` uses it for the two threads a delta says actually changed. The
 * label lookup is one request either way.
 */
export async function fetchThreadSummaries(
  api: GoogleApi,
  ids: string[],
): Promise<MailThreadSummary[]> {
  if (ids.length === 0) return []

  // ONCE per call, not once per thread — resolving a chip must not cost a
  // request. It runs concurrently with the threads for the same reason.
  const labelNames = fetchLabelNames(api)

  const threads = await mapPooled(ids, 5, (id) =>
    api.get<RawThread>(`${BASE}/threads/${id}`, {
      format: 'metadata',
      // An ARRAY, so `GoogleApi.get` emits one `metadataHeaders=` per name.
      // Comma-joining these is not a shorthand — Gmail reads the whole string
      // as one header name, matches nothing, and returns 200 with no headers,
      // which renders every thread as "(no subject)" from an empty sender.
      // The recipient and unsubscribe headers are free — same request, same
      // response size to any degree that matters.
      metadataHeaders: [
        'Subject',
        'From',
        'Date',
        'Message-ID',
        'To',
        'Cc',
        'Reply-To',
        'List-Unsubscribe',
      ],
    }),
  )

  const names = await labelNames
  return threads
    .map((thread) => summarize(thread, names))
    .filter((t): t is MailThreadSummary => t !== null)
}

/** The user's own query, the category tab and the unread filter, in Gmail's one
 *  grammar — so there is one way to narrow a list rather than several that can
 *  disagree with each other. */
function composeQuery(options: ListThreadsOptions): string {
  const parts = [options.query !== undefined && options.query !== '' ? options.query : 'in:inbox']
  if (options.category !== undefined) parts.push(categoryQuery(options.category))
  if (options.unread === true) parts.push('is:unread')
  return parts.join(' ')
}

/**
 * Gmail's own labels, which are not the user's.
 *
 * Everything else on a message is something the user filed it under, and only
 * those belong on a row as chips. `CATEGORY_*` is handled by prefix because the
 * set has grown before.
 */
const SYSTEM_LABELS = new Set([
  'INBOX',
  'SENT',
  'DRAFT',
  'DRAFTS',
  'SPAM',
  'TRASH',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'CHAT',
  'SCHEDULED',
])

/** Gmail's label name for each tab. `CATEGORY_PERSONAL` is the Primary tab —
 *  the one mapping that is silently wrong if it is guessed. */
const CATEGORY_BY_LABEL: Record<string, MailCategory> = {
  CATEGORY_PERSONAL: 'primary',
  CATEGORY_SOCIAL: 'social',
  CATEGORY_PROMOTIONS: 'promotions',
  CATEGORY_UPDATES: 'updates',
  CATEGORY_FORUMS: 'forums',
}

/** Gmail's query grammar uses the tab's short name, not its label id. */
export function categoryQuery(category: MailCategory): string {
  return `category:${category}`
}

function isSystemLabel(id: string): boolean {
  return SYSTEM_LABELS.has(id) || id.startsWith('CATEGORY_')
}

/**
 * The unsubscribe link a newsletter advertises, if it offers a web one.
 *
 * The header may hold both forms — `<mailto:…>, <https://…>` — and only the
 * https one is something to hand the browser. A `mailto:` would mean composing
 * mail on the user's behalf, which is not what the read-only scope granted and
 * not what a one-click affordance should ever do silently.
 */
export function unsubscribeUrlOf(header: string | null): string | null {
  if (header === null) return null
  for (const match of header.matchAll(/<([^>]+)>/g)) {
    const url = match[1]!.trim()
    if (/^https?:\/\//i.test(url)) return url
  }
  return null
}

function summarize(thread: RawThread, labelNames: Map<string, string>): MailThreadSummary | null {
  const messages = thread.messages ?? []
  const first = messages[0]
  const last = messages[messages.length - 1]
  if (thread.id === undefined || first === undefined || last === undefined) return null

  // A label anywhere in the thread applies to the thread — the same rule Gmail's
  // own list follows, and `unread` already followed.
  const allLabels = messages.flatMap((m) => m.labelIds ?? [])
  const category = last.labelIds?.map((id) => CATEGORY_BY_LABEL[id]).find((c) => c !== undefined)

  return {
    id: thread.id,
    // The subject comes from the FIRST message: replies carry "Re:" prefixes
    // and a thread renamed mid-conversation would otherwise change identity.
    subject: headerOf(first.payload, 'Subject')?.trim() || '(no subject)',
    // The sender comes from the LAST: "who wrote most recently" is what a list
    // is scanned for.
    from: parseAddress(headerOf(last.payload, 'From')),
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
    starred: allLabels.includes('STARRED'),
    important: allLabels.includes('IMPORTANT'),
    hasDraft: allLabels.includes('DRAFT'),
    // From the LAST message: Gmail re-categorises a thread as it grows, and the
    // tab it sits in now is the one the user would look in for it.
    category: category ?? null,
    // An id with no name is dropped, not shown: `Label_12` on a row is worse
    // than no chip at all, and it is what a failed lookup would render.
    labels: [...new Set(allLabels)]
      .filter((id) => !isSystemLabel(id))
      .map((id) => labelNames.get(id))
      .filter((name): name is string => name !== undefined),
    unsubscribeUrl: unsubscribeUrlOf(headerOf(last.payload, 'List-Unsubscribe')),
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
      from: parseAddress(headerOf(message.payload, 'From')),
      to: parseAddresses(headerOf(message.payload, 'To')),
      cc: parseAddresses(headerOf(message.payload, 'Cc')),
      date: isoDate(message),
      body: bodyTextOf(message.payload),
      html: bodyHtmlOf(message.payload),
      attachments: attachmentsOf(message.payload),
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
