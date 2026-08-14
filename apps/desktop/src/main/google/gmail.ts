/**
 * Gmail — search, read, triage, and the stable link that goes into a note.
 *
 * **Read plus four writes** (D68, amending D67 §4): the granted scope is
 * `gmail.modify`, and the writes live at the foot of this file — mark read,
 * star, archive, trash. Composing is still a `mailto:` handoff, because no
 * compose surface is built; the scope would allow one. Read the note above
 * those functions before adding a fifth.
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
import { buildRfc822, toBase64Url, type MailPart, type OutgoingMail } from './mime'

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
  /** Absent on a loose draft that belongs to no conversation (D71). */
  threadId?: string
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
 * `"Ada Holm" <ada@syv.ai>` → `{ name, email }`.
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
  // ("Holm, Ada" <…>), and splitting naively mangles it into two people.
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
 * How many unread threads sit in one tab.
 *
 * **Counted, not estimated, and not read off the label.** Three ways to get
 * this number and only one of them is right:
 *
 * - `resultSizeEstimate` is an estimate, and the category picker has always
 *   refused to show one — a number people trust and that is wrong is worse
 *   than no number.
 * - `labels.get` on `CATEGORY_PROMOTIONS` is exact but counts the **whole
 *   mailbox**, archived mail included. It would answer a question nobody asked,
 *   and Holi can now archive without reading, so the gap is one this app makes.
 * - `threads.list` scoped to the inbox returns the actual ids. Counting them is
 *   exact and scoped to what the tab holds. Ids only, so a page of 500 is a
 *   small response and never the N+1 a list view pays.
 *
 * `more` is what honesty costs past the page: at 500 the answer becomes "500+"
 * rather than a number that quietly means "at least".
 */
export interface CategoryCount {
  count: number
  /** There is at least one more page — render `500+`, not `500`. */
  more: boolean
}

/** Gmail's maximum for `threads.list`. */
const COUNT_PAGE_SIZE = '500'

export async function fetchCategoryUnread(
  api: GoogleApi,
  category: MailCategory,
): Promise<CategoryCount | null> {
  try {
    const page = await api.get<{ threads?: unknown[]; nextPageToken?: string }>(`${BASE}/threads`, {
      q: `in:inbox ${categoryQuery(category)} is:unread`,
      maxResults: COUNT_PAGE_SIZE,
    })
    return { count: (page.threads ?? []).length, more: page.nextPageToken !== undefined }
  } catch {
    // One tab's number, not the picker. A failure here must leave the other
    // four counts and the tabs themselves working.
    return null
  }
}

export type CategoryCounts = Partial<Record<MailCategory, CategoryCount | null>>

/** Every tab's unread count, concurrently — five requests, and only when the
 *  picker is actually opened. See `MailView`. */
export async function fetchCategoryCounts(api: GoogleApi): Promise<CategoryCounts> {
  const categories: MailCategory[] = ['primary', 'social', 'promotions', 'updates', 'forums']
  const counts = await Promise.all(categories.map((c) => fetchCategoryUnread(api, c)))
  return Object.fromEntries(categories.map((c, index) => [c, counts[index]!]))
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

/** The boolean columns of a summary, named by the type rather than by hand — so
 *  a flag that is renamed or stops being a boolean fails to compile here. */
type MailFlag = {
  [K in keyof MailThreadSummary]: MailThreadSummary[K] extends boolean ? K : never
}[keyof MailThreadSummary]

/**
 * Which system label sets which flag — **one table, read from both ends.**
 *
 * The set of patchable labels and the mapping that applies them used to be two
 * declarations that had to agree: a label in the set with no entry in the
 * mapping is silently ignored, and the reverse makes a delta refetch when it
 * did not need to. Deriving `PATCHABLE_LABELS` from the table's own keys makes
 * that drift inexpressible rather than merely warned against.
 *
 * A *user* label is deliberately absent: the cache holds label NAMES, and
 * `Label_12` cannot become one without a lookup — so that case refetches, which
 * is both correct and rare. `INBOX`, `TRASH` and `SPAM` are absent for a
 * different reason: they are not flags on a row, they decide whether the row is
 * in the list at all, and `mail-sync` handles them as departures.
 *
 * Two callers, and they arrive from opposite directions: `mail-sync` applying
 * what `history.list` reports, and `cache` applying a write this app just made.
 * Both are "a label moved; update the flags", and neither should own its own
 * copy of the answer.
 */
const LABEL_FLAGS = {
  UNREAD: 'unread',
  STARRED: 'starred',
  IMPORTANT: 'important',
  DRAFT: 'hasDraft',
} as const satisfies Record<string, MailFlag>

export const PATCHABLE_LABELS: ReadonlySet<string> = new Set(Object.keys(LABEL_FLAGS))

export function applyLabelDelta(
  thread: MailThreadSummary,
  change: { added: ReadonlySet<string>; removed: ReadonlySet<string> },
): MailThreadSummary {
  const patched = { ...thread }
  for (const [label, flag] of Object.entries(LABEL_FLAGS) as [string, MailFlag][]) {
    if (change.added.has(label)) patched[flag] = true
    else if (change.removed.has(label)) patched[flag] = false
  }
  return patched
}

/**
 * The four writes (D68) — everything Holi can change about a thread.
 *
 * **This is the whole write surface, and it is meant to stay that way.** The
 * scope behind it (`gmail.modify`) permits more than these: it also permits
 * `messages.send`, because no lesser scope grants `threads.modify` and archive
 * cannot be bought without it. So "Holi cannot send" is true only for as long
 * as this file has no function that sends — a code boundary, not a granted one.
 * Adding one is a decision, not a refactor.
 *
 * None of these touch the cache. A function that both calls Google and mutates
 * local state cannot be tested as either, and the ordering that keeps the two
 * honest — Google first, cache only on success — belongs to `data.ts`, which
 * owns the cache.
 */

/**
 * Read is a **two-way** label, exactly like starred (D70).
 *
 * Removing `UNREAD` clears it from every message, which is what Gmail itself
 * does when a thread is opened. `unread` is derived from any message carrying
 * the label (see `summarize`), so a partial removal would leave it set.
 *
 * The other direction exists for the agent: "leave this one for me" is a real
 * triage move, and having only one direction here would have made the ops
 * server carry a special case that no other label needs.
 */
export async function setThreadRead(api: GoogleApi, id: string, read: boolean): Promise<void> {
  await modifyThread(api, id, read ? { remove: ['UNREAD'] } : { add: ['UNREAD'] })
}

export async function setThreadStarred(api: GoogleApi, id: string, starred: boolean): Promise<void> {
  await modifyThread(api, id, starred ? { add: ['STARRED'] } : { remove: ['STARRED'] })
}

/** Archive is the *absence* of `INBOX`, not the presence of anything. The
 *  thread is untouched otherwise — still searchable, still in All Mail. */
export async function archiveThread(api: GoogleApi, id: string): Promise<void> {
  await modifyThread(api, id, { remove: ['INBOX'] })
}

/**
 * Trash — **its own endpoint, not a label change.**
 *
 * `modify` with `addLabelIds: ['TRASH']` is the intuitive version and it does
 * not work: Gmail answers 200 and leaves the thread where it was. There is no
 * error to notice, only mail that reappears on the next refresh.
 *
 * Recoverable by design. Permanent deletion needs `https://mail.google.com/`,
 * which Holi does not request and will not.
 */
export async function trashThread(api: GoogleApi, id: string): Promise<void> {
  await api.post(`${BASE}/threads/${encodeURIComponent(id)}/trash`, {})
}

/** The one shape every label write shares, so the URL and the body exist once.
 *  Empty arrays are omitted rather than sent: Gmail accepts them, but a request
 *  that says `removeLabelIds: []` reads like a bug in the log it appears in. */
async function modifyThread(
  api: GoogleApi,
  id: string,
  labels: { add?: string[]; remove?: string[] },
): Promise<void> {
  await api.post(`${BASE}/threads/${encodeURIComponent(id)}/modify`, {
    ...(labels.add === undefined ? {} : { addLabelIds: labels.add }),
    ...(labels.remove === undefined ? {} : { removeLabelIds: labels.remove }),
  })
}

/**
 * Send a message (D70).
 *
 * `id: null` is a **success** — `postJson` returns `null` when Google accepted
 * the request and the response body could not be read. The field is named `id`
 * rather than the result being `string | null` so that no caller can mistake
 * the absence of an id for the absence of a sent mail.
 */
export async function sendMessage(
  api: GoogleApi,
  mail: OutgoingMail,
): Promise<{ id: string | null }> {
  const sent = await api.postJson<{ id?: string }>(`${BASE}/messages/send`, {
    raw: toBase64Url(buildRfc822(mail)),
  })
  return { id: sent?.id ?? null }
}

/**
 * Create a draft — the outbound operation that reaches nobody, and the one the
 * skill teaches as the default.
 *
 * `threadId` is what files it in the conversation. Without it Gmail creates a
 * loose draft that looks correct in the drafts list and is not attached to
 * anything.
 */
export async function createDraft(
  api: GoogleApi,
  mail: OutgoingMail,
  threadId?: string,
): Promise<{ id: string | null }> {
  const draft = await api.postJson<{ id?: string }>(`${BASE}/drafts`, {
    message: {
      raw: toBase64Url(buildRfc822(mail)),
      ...(threadId === undefined ? {} : { threadId }),
    },
  })
  return { id: draft?.id ?? null }
}

/**
 * Reply to a thread, threaded correctly and addressed correctly.
 *
 * Both of those are derived here rather than asked of the caller, because both
 * are things an LLM would get plausibly wrong: replying to the thread's *first*
 * sender rather than its last, or to the user's own last message; and building
 * `References` from the message being answered instead of the whole chain.
 *
 * Reads the raw thread rather than going through `readThread`, which drops the
 * two things this needs — the RFC-822 `Message-ID` of each message, and the
 * `SENT` label that says which ones are the user's own.
 */
export async function replyToThread(
  api: GoogleApi,
  threadId: string,
  body: string,
  options: { all?: boolean } = {},
): Promise<{ id: string | null }> {
  const thread = await api.get<RawThread>(`${BASE}/threads/${encodeURIComponent(threadId)}`, {
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'Subject', 'From', 'To', 'Cc'],
  })
  const messages = thread.messages ?? []
  if (messages.length === 0) {
    throw new Error(`thread ${threadId} has no message to reply to`)
  }

  // The last message the user did NOT send. `SENT` is Gmail's own label, so it
  // needs no comparison against the connected address — which would be wrong
  // for aliases and send-as addresses anyway (see `summarize`). Falling back to
  // the last message covers a thread the user started and nobody answered.
  const inbound = [...messages].reverse().find((m) => m.labelIds?.includes('SENT') !== true)
  const target = inbound ?? messages[messages.length - 1]!

  const to = parseAddresses(headerOf(target.payload, 'From'))
    .map((address) => address.email)
    .filter((email) => email !== '')
  /**
   * **Reply, not reply-all — and the default matters more here than usual.**
   *
   * Copying the thread's `Cc` turns one instruction into a message to six
   * people, on the single operation that reaches people at all. And the user
   * approving the confirmation cannot check it: a reply's recipients are
   * *derived from the thread*, so they never appear in the command being
   * approved. A default that silently widens an audience nobody can see is the
   * wrong default; reply-all stays available, but has to be asked for.
   */
  const cc =
    options.all === true
      ? parseAddresses(headerOf(target.payload, 'Cc'))
          .map((address) => address.email)
          .filter((email) => email !== '')
      : []

  const subject = headerOf(target.payload, 'Subject')?.trim() ?? ''
  // `Re: Re: Re:` is what a naive prefix produces on a long thread.
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`

  // The WHOLE chain, in order, not just the message being answered. Gmail
  // threads on References; In-Reply-To alone sends fine and starts a new thread.
  const references = messages
    .map((message) => headerOf(message.payload, 'Message-ID'))
    .filter((id): id is string => id !== null && id !== '')
  const inReplyTo = headerOf(target.payload, 'Message-ID') ?? undefined

  const sent = await api.postJson<{ id?: string }>(`${BASE}/messages/send`, {
    raw: toBase64Url(
      buildRfc822({
        to,
        cc,
        subject: replySubject,
        body,
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
        references,
      }),
    ),
    // Belt and braces with the headers: the id files it in the thread even if a
    // Message-ID was missing, which is rare but legal.
    threadId,
  })
  return { id: sent?.id ?? null }
}

/**
 * The composer's Gmail surface (D71).
 *
 * Everything below either reaches another human or edits something that will,
 * and none of it existed while replying meant opening a browser. The agent's
 * functions above are deliberately left alone: `createDraft` and
 * `replyToThread` derive their own recipients, which is right for an LLM
 * working from an instruction and wrong for a UI where the user has already
 * been shown chips they may have edited.
 */

export interface DraftSummary {
  draftId: string
  threadId: string | null
  to: MailAddress[]
  subject: string
  snippet: string
  date: string
}

export interface DraftBody {
  draftId: string
  threadId: string | null
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  /**
   * The markdown source, byte-exact, when `X-Holi-Source` says this draft came
   * from Holi. `null` means the renderer must convert `html` itself — main
   * cannot, because `turndown` needs a DOM and main has none.
   */
  markdown: string | null
  html: string | null
  /** No `X-Holi-Source`. Not a gate: a foreign draft opens for editing after a
   *  conversion, and there is no read-only state anywhere in this feature. */
  foreign: boolean
}

/** The header `buildRfc822` writes on everything it builds. */
const SOURCE_HEADER_NAME = 'X-Holi-Source'

/**
 * The `In-Reply-To` and `References` for a reply into `threadId`.
 *
 * Resolved from a fresh `format=metadata` read every time, per send *and* per
 * save. Never held in the renderer and never baked at mount: `drafts.update`
 * replaces the whole draft, so a save that omits these strips them, and a draft
 * later sent from a phone starts a new conversation.
 *
 * The cost is one cheap metadata read per autosave. If that ever shows up as
 * slow the tunable is to resolve on create and send only — and the price of
 * that is exactly the phone case above.
 */
async function threadingHeaders(
  api: GoogleApi,
  threadId: string,
): Promise<{ inReplyTo?: string; references: string[] }> {
  const thread = await api.get<RawThread>(`${BASE}/threads/${encodeURIComponent(threadId)}`, {
    format: 'metadata',
    metadataHeaders: ['Message-ID'],
  })
  const messages = thread.messages ?? []
  // The WHOLE chain, oldest first. Gmail threads on References; In-Reply-To
  // alone sends fine and lands as a brand new thread.
  const references = messages
    .map((message) => headerOf(message.payload, 'Message-ID'))
    .filter((id): id is string => id !== null && id !== '')
  const last = references[references.length - 1]
  return { references, ...(last === undefined ? {} : { inReplyTo: last }) }
}

/**
 * Send into an existing thread, with the recipients the caller supplies.
 *
 * **Not `replyToThread`.** That one derives its own `to` and `cc` from the
 * thread, which is the right default for the agent and the wrong one here: the
 * composer has already shown the user chips they may have edited, and deriving
 * would silently discard the edit. This derives *only* the threading headers.
 */
export async function sendInThread(
  api: GoogleApi,
  threadId: string,
  mail: OutgoingMail,
): Promise<{ id: string | null }> {
  const threading = await threadingHeaders(api, threadId)
  const sent = await api.postJson<{ id?: string }>(`${BASE}/messages/send`, {
    raw: toBase64Url(buildRfc822({ ...mail, ...threading })),
    // Belt and braces with the headers: the id files it in the thread even if a
    // Message-ID was missing, which is rare but legal.
    threadId,
  })
  return { id: sent?.id ?? null }
}

/**
 * Create or replace the composer's draft — the one call the autosave loop wants.
 *
 * `createDraft` above is the agent's and stays as it is; this one exists
 * because an autosave has to be able to *update*. A create on every save makes
 * a second draft, and the user watches their message fork.
 */
export async function saveDraft(
  api: GoogleApi,
  mail: OutgoingMail,
  opts: { draftId?: string; threadId?: string } = {},
): Promise<{ id: string | null }> {
  const threading =
    opts.threadId === undefined ? {} : await threadingHeaders(api, opts.threadId)
  const message = {
    raw: toBase64Url(buildRfc822({ ...mail, ...threading })),
    ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
  }

  if (opts.draftId === undefined) {
    const draft = await api.postJson<{ id?: string }>(`${BASE}/drafts`, { message })
    return { id: draft?.id ?? null }
  }

  // PUT, not PATCH: Gmail replaces the whole draft, which is why the threading
  // headers above are rebuilt on every save rather than assumed to survive.
  const draft = await api.putJson<{ id?: string }>(
    `${BASE}/drafts/${encodeURIComponent(opts.draftId)}`,
    { id: opts.draftId, message },
  )
  return { id: draft?.id ?? opts.draftId }
}

/**
 * Send a draft.
 *
 * `drafts.send`, **not** `messages.send` followed by `drafts.delete`. Gmail
 * removes the draft atomically; the two-call version leaves an orphan draft
 * whenever the second call fails — a message the user already sent, still
 * sitting in Drafts looking unsent.
 */
export async function sendDraft(api: GoogleApi, draftId: string): Promise<{ id: string | null }> {
  const sent = await api.postJson<{ id?: string }>(`${BASE}/drafts/send`, { id: draftId })
  return { id: sent?.id ?? null }
}

export async function deleteDraft(api: GoogleApi, draftId: string): Promise<void> {
  await api.del(`${BASE}/drafts/${encodeURIComponent(draftId)}`)
}

/** `drafts.list` carries no headers at all, so each draft costs a metadata
 *  read. Capped rather than unbounded — a Drafts view is a list a human reads. */
const DRAFT_LIST_CAP = 50

export async function listDrafts(api: GoogleApi): Promise<DraftSummary[]> {
  const page = await api.get<{ drafts?: { id?: string }[] }>(`${BASE}/drafts`, {
    maxResults: String(DRAFT_LIST_CAP),
  })
  const ids = (page.drafts ?? [])
    .map((draft) => draft.id)
    .filter((id): id is string => id !== undefined)

  const summaries = await Promise.all(
    ids.map(async (id) => {
      const draft = await api.get<{ id?: string; message?: RawMessage }>(
        `${BASE}/drafts/${encodeURIComponent(id)}`,
        { format: 'metadata', metadataHeaders: ['To', 'Subject'] },
      )
      const message = draft.message
      return {
        draftId: id,
        threadId: threadIdOf(message),
        to: parseAddresses(headerOf(message?.payload, 'To')),
        subject: headerOf(message?.payload, 'Subject') ?? '',
        snippet: message?.snippet ?? '',
        date: message === undefined ? '' : isoDate(message),
      }
    }),
  )
  return summaries
}

export async function readDraft(api: GoogleApi, draftId: string): Promise<DraftBody> {
  const draft = await api.get<{ id?: string; message?: RawMessage }>(
    `${BASE}/drafts/${encodeURIComponent(draftId)}`,
    { format: 'full' },
  )
  const message = draft.message
  const payload = message?.payload
  const foreign = headerOf(payload, SOURCE_HEADER_NAME) === null

  return {
    draftId,
    threadId: threadIdOf(message),
    to: parseAddresses(headerOf(payload, 'To')),
    cc: parseAddresses(headerOf(payload, 'Cc')),
    subject: headerOf(payload, 'Subject') ?? '',
    // The marker means the text/plain part IS the markdown that produced this
    // draft, so it round-trips byte-exact. Without it there is nothing here to
    // trust, and the renderer converts the html instead.
    markdown: foreign ? null : bodyTextOf(payload),
    html: bodyHtmlOf(payload),
    foreign,
  }
}

/**
 * Every address this account may send from — the connected one plus its aliases.
 *
 * Needed so reply-all can exclude *all* of them. Missing an alias copies the
 * user on their own reply, which reads as a bug in the recipient's client
 * rather than in this one. No new OAuth scope: `gmail.modify` already permits
 * `settings.sendAs.list`.
 */
export async function listSendAs(api: GoogleApi): Promise<string[]> {
  const settings = await api.get<{ sendAs?: { sendAsEmail?: string }[] }>(`${BASE}/settings/sendAs`)
  return (settings.sendAs ?? [])
    .map((entry) => entry.sendAsEmail)
    .filter((email): email is string => email !== undefined && email !== '')
    // Lowercased because these are compared against header addresses.
    .map((email) => email.toLowerCase())
}

/**
 * Fetch one attachment's bytes, ready for `buildRfc822`.
 *
 * **The conversion is the point.** `attachments.get` answers base64**url**;
 * MIME needs standard base64. The alphabets differ in three characters, so the
 * mistake produces a file that opens as garbage — and only the recipient ever
 * sees it. The filename and type come from the caller because the wire answer
 * carries neither.
 */
export async function fetchAttachment(
  api: GoogleApi,
  messageId: string,
  attachmentId: string,
  part: { filename: string; mimeType: string },
): Promise<MailPart> {
  const message = encodeURIComponent(messageId)
  const attachment = encodeURIComponent(attachmentId)
  const body = await api.get<{ data?: string }>(
    `${BASE}/messages/${message}/attachments/${attachment}`,
  )
  return {
    filename: part.filename,
    mimeType: part.mimeType,
    data: Buffer.from(body.data ?? '', 'base64url').toString('base64'),
  }
}

/** Gmail omits `threadId` on a loose draft; `null` is "belongs to no thread". */
function threadIdOf(message: RawMessage | undefined): string | null {
  const threadId = message?.threadId
  return threadId === undefined || threadId === '' ? null : threadId
}

/**
 * An attachment as it appears in a message payload, with the id needed to
 * fetch it. `attachmentsOf` deliberately drops that id — it feeds the reader,
 * which shows names and sizes and never downloads anything.
 */
interface AttachmentRef {
  filename: string
  mimeType: string
  attachmentId: string
}

function attachmentRefsOf(part: RawPart | undefined): AttachmentRef[] {
  if (part === undefined) return []
  const id = part.body?.attachmentId
  const here: AttachmentRef[] =
    part.filename !== undefined && part.filename !== '' && id !== undefined
      ? [
          {
            filename: part.filename,
            mimeType: part.mimeType ?? 'application/octet-stream',
            attachmentId: id,
          },
        ]
      : []
  return [...here, ...(part.parts ?? []).flatMap((child) => attachmentRefsOf(child))]
}

/**
 * Every attachment on a message, as MIME parts ready for `buildRfc822` (D71).
 *
 * **This is why a forward carries its files without a file picker.** The
 * renderer names a message; main fetches the bytes and hands them straight to
 * the assembler. Nothing base64 ever crosses the IPC seam, so there is no
 * attachment blob in renderer state and no size cap to design.
 */
export async function fetchMessageAttachments(
  api: GoogleApi,
  messageId: string,
): Promise<MailPart[]> {
  const message = await api.get<RawMessage>(`${BASE}/messages/${encodeURIComponent(messageId)}`, {
    format: 'full',
  })
  const refs = attachmentRefsOf(message.payload)
  return await Promise.all(refs.map((ref) => fetchAttachment(api, messageId, ref.attachmentId, ref)))
}
