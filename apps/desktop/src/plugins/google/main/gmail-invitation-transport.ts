import { GoogleApiError, type GoogleApi, type GoogleDispatchGate } from './api'
import { normalizeMessageIds } from './gmail-headers'
import {
  calendarMimeMethod,
  CalendarScanError,
  createMimeWalk,
  headerOf,
  isCalendarPart,
  type MimeLocation,
  type RawPart,
} from './gmail-mime'
import {
  fetchFullThread,
  GMAIL_BASE,
  isGmailMessageId,
  validateFullMessage,
  type RawMessage,
} from './gmail-thread'
import { buildRfc822, toBase64Url } from './mime'

type GmailReadApi = Pick<GoogleApi, 'get'>

const MAX_CALENDAR_PART_BYTES = 256 * 1024
const calendarUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function sentResourceUnavailable(error: unknown): boolean {
  return error instanceof GoogleApiError && error.code === 'unknown' && error.status === 503
}

/** An unreadable leaf is not a failed scan. Only ordered, related Sent
 * evidence may defer a leaf error; the shared resource limits still abort. */
export class CalendarLeafError extends CalendarScanError {}

/** Each public read or response owns one budget, including all evidence and
 * preflight reads. Revalidation still gets a fresh provider snapshot. */
export function createCalendarScan() {
  let bytes = 1024 * 1024
  let parts = 32
  const walk = createMimeWalk()
  const evidence = new Map<string, { data: string | undefined; read?: () => Promise<string> }>()
  let attachments = 8
  let evidenceReads = 32
  const check = (within: boolean) => {
    if (!within) throw new CalendarScanError('Gmail calendar data exceeds the scan limits')
  }
  const size = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new CalendarLeafError('Invalid Gmail calendar part size')
    check(value <= MAX_CALENDAR_PART_BYTES && value <= bytes)
    return value
  }
  async function readPart(api: GmailReadApi, messageId: string, part: RawPart): Promise<string> {
    let encoded: unknown = part.body?.data
    const attachment = part.body?.attachmentId
    const expectedSize = size(part.body?.size)
    let attachmentSize: unknown = expectedSize
    if (attachment !== undefined) {
      if (typeof attachment !== 'string' || !attachment || encoded !== undefined)
        throw new CalendarLeafError('Invalid Gmail calendar attachment')
      check(--attachments >= 0)
      const body = await api
        .get<{ size?: number; data?: string }>(
          `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment)}`,
        )
        .catch((error) => {
          if (error instanceof GoogleApiError) {
            if (error.code === 'not-found')
              throw new CalendarLeafError('Gmail could not find the calendar attachment')
            // A transient HTTP failure on this resource leaves its MIME leaf
            // unreadable. Auth, throttling and transport failures still abort.
            if ([500, 502, 503, 504].includes(error.status))
              throw new CalendarLeafError('Gmail could not read the calendar attachment', {
                cause: error,
              })
          }
          if (error instanceof SyntaxError)
            throw new CalendarLeafError('Gmail returned an invalid calendar attachment')
          throw error
        })
      encoded = body?.data
      attachmentSize = body?.size
    }
    if (typeof encoded === 'string')
      check(encoded.length <= Math.ceil(Math.min(bytes, MAX_CALENDAR_PART_BYTES) / 3) * 4)
    const actualSize = size(attachmentSize)
    if (encoded === undefined && actualSize === 0) encoded = ''
    if (typeof encoded !== 'string') throw new CalendarLeafError('Missing Gmail calendar part data')
    if (!/^[a-z0-9_-]*={0,2}$/i.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1)
      throw new CalendarLeafError('Invalid Gmail calendar part encoding')
    const decoded = Buffer.from(encoded, 'base64url')
    check(decoded.length <= MAX_CALENDAR_PART_BYTES && decoded.length <= bytes)
    bytes -= decoded.length
    if (actualSize !== expectedSize)
      throw new CalendarLeafError('Gmail calendar attachment size changed')
    if (decoded.length !== expectedSize)
      throw new CalendarLeafError('Invalid Gmail calendar part size')
    try {
      return calendarUtf8.decode(decoded)
    } catch {
      // Do not manufacture an identity by replacing malformed wire bytes.
      throw new CalendarLeafError('Gmail calendar part is not valid UTF-8')
    }
  }
  return {
    partsOf(
      api: GmailReadApi,
      messageId: string,
      payload: RawPart | undefined,
      draft: boolean,
    ): CalendarMail['parts'] {
      const found: CalendarMail['parts'] = []
      walk(payload, (part, location, forwarded) => {
        if (draft || forwarded || !isCalendarPart(part)) return
        const method = calendarMimeMethod(part)
        const data = part.body?.data
        const attachment = part.body?.attachmentId
        const declared = part.body?.size
        if (data !== undefined)
          check(
            typeof data === 'string' && data.length <= Math.ceil(MAX_CALENDAR_PART_BYTES / 3) * 4,
          )
        if (attachment !== undefined)
          check(typeof attachment === 'string' && attachment.length <= 4096)
        // Fresh routing headers and labels are projected below. Only the
        // identical part at the identical MIME location can share evidence.
        const key = JSON.stringify([
          messageId,
          location.path,
          location.alternatives,
          part.mimeType,
          part.filename,
          part.headers,
          declared,
          attachment,
        ])
        const prior = evidence.get(key)
        const identical = prior && prior.data === data
        if (!identical) check(--parts >= 0)
        let decoded: Promise<string> | undefined
        const read =
          (identical && prior.read) || (() => (decoded ??= readPart(api, messageId, part)))
        // Attachments must still be fetched under their own budget. Reusing
        // the descriptor is not proof that Gmail returned the same bytes.
        if (!identical) evidence.set(key, { data, ...(attachment === undefined ? { read } : {}) })
        found.push({ method, alternatives: location.alternatives, read })
      })
      return found
    },
    evidenceRead() {
      check(--evidenceReads >= 0)
    },
  }
}

type CalendarScan = ReturnType<typeof createCalendarScan>

type CalendarReplyHeaders = {
  subject: string
  inReplyTo: string
  references: string[]
}

type CalendarMail = {
  messageId: string
  rfcId: string | null
  claims: Set<string>
  threadId: string | null
  parent: string | null
  timestamp: number
  sent: boolean
  organizerSender: string | null
  sentAddresses: Record<'from' | 'to' | 'cc' | 'bcc', string[] | null> | null
  replyHeaders: CalendarReplyHeaders | null
  parts: {
    method: string | undefined | null
    alternatives: MimeLocation['alternatives']
    read: () => Promise<string>
  }[]
}

export type CalendarReplyReceipt = {
  id: string | null
  threadId: string | null
  invalidLocator?: true
}

/** Do not accept a good-looking substring of an invalid header, or choose
 * between duplicate headers. Missing is distinct from invalid. */
function calendarHeaderIds(part: RawPart | undefined, name: string): string[] | null {
  const values = (part?.headers ?? []).filter((header) => header.name?.toLowerCase() === name)
  if (values.length === 0) return []
  const value = values[0]?.value
  if (values.length !== 1 || typeof value !== 'string') return null
  const ids = normalizeMessageIds(value, true)
  return ids?.length ? ids : null
}

function messageIdClaims(part: RawPart | undefined) {
  const values = (part?.headers ?? [])
    .filter(({ name }) => name?.toLowerCase() === 'message-id')
    .map(({ value }) => (typeof value === 'string' ? normalizeMessageIds(value, true) : null))
  const only = values.length === 1 ? values[0] : null
  return {
    rfcId: only?.length === 1 ? only[0]! : null,
    claims: new Set(values.flatMap((ids) => ids ?? [])),
  }
}

export function createMessageIdOwnership() {
  const owners = new Map<string, string | null>()
  const seen = new Map<string, ReturnType<typeof messageIdClaims>>()
  const owns = ({ rfcId, messageId }: Pick<CalendarMail, 'rfcId' | 'messageId'>) =>
    rfcId !== null && owners.get(rfcId) === messageId
  return {
    index(messageId: string, header: ReturnType<typeof messageIdClaims>) {
      const previous = seen.get(messageId)
      // A malformed or duplicate declaration can never own an ID, but every
      // whole-header claim still contests it. A second read of the same Gmail
      // message is not a second owner, unless the two snapshots disagree.
      const claims = new Set([...(previous?.claims ?? []), ...header.claims])
      const rfcId = !previous || header.rfcId === previous.rfcId ? header.rfcId : null
      seen.set(messageId, { rfcId, claims })
      for (const id of claims) {
        const owner = owners.get(id)
        owners.set(
          id,
          id === rfcId && (owner === undefined || owner === messageId) ? messageId : null,
        )
      }
    },
    get: (id: string) => owners.get(id),
    has: (id: string) => owners.has(id),
    owns,
    contradicts(reply: { rfcId: string; messageId: string }) {
      return (owners.has(reply.rfcId) || seen.has(reply.messageId)) && !owns(reply)
    },
  }
}

type MessageIdOwners = ReturnType<typeof createMessageIdOwnership>

function addressHeader(part: RawPart | undefined, name: 'from' | 'sender' | 'to' | 'cc' | 'bcc') {
  const headers = (part?.headers ?? []).filter((header) => header.name?.toLowerCase() === name)
  if (!headers.length) return []
  const value = headers[0]?.value
  return headers.length === 1 && typeof value === 'string'
    ? parseEvidenceAddresses(
        value,
        name === 'to' || name === 'cc' || name === 'bcc',
        name === 'bcc',
      )
    : null
}

/** Unlike display parsing, address evidence must consume the whole unique header
 * within the MIME scan's header limits. Null is unknown, not an empty list. */
function parseEvidenceAddresses(
  value: string,
  allowGroups: boolean,
  allowEmpty: boolean,
): string[] | null {
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ')
  if (/\p{Cc}/u.test(unfolded.replaceAll('\t', ''))) return null
  let source = ''
  let comments = 0
  let quoted = false
  let escaped = false
  for (const char of unfolded) {
    if (escaped) {
      if (!comments) source += char
      escaped = false
    } else if (char === '\\' && (quoted || comments)) {
      if (!comments) source += char
      escaped = true
    } else if (!quoted && char === '(') {
      if (comments++ === 0) source += ' '
    } else if (!quoted && char === ')') {
      if (!comments) return null
      comments--
    } else if (!comments) {
      if (char === '"') quoted = !quoted
      source += char
    }
  }
  if (comments || quoted || escaped) return null

  const atom = String.raw`[\w!#$%&'*+\-/=?^\x60{|}~]`
  const word = String.raw`(?:"(?:[^"\\]|\\.)*"|(?:${atom}|\.|[^\x00-\x7f\s])+)`
  const phrase = String.raw`${word}(?:[ \t]+${word})*`
  const addr = String.raw`(${atom}+(?:\.${atom}+)*)[ \t]*@[ \t]*([a-z\d-]+(?:\.[a-z\d-]+)*)`
  const mailbox = new RegExp(String.raw`(?:${phrase}[ \t]*)?<[ \t]*${addr}[ \t]*>|${addr}`, 'iy')
  const group = new RegExp(`${phrase}[ \\t]*:`, 'y')
  const space = /[ \t]*/y
  let at = 0
  const take = (pattern: RegExp) => {
    pattern.lastIndex = at
    const match = pattern.exec(source)
    if (match) at = pattern.lastIndex
    return match
  }
  const addresses: string[] = []
  const takeMailbox = () => {
    const match = take(mailbox)
    if (!match) return false
    addresses.push(`${match[1] ?? match[3]}@${match[2] ?? match[4]}`.toLowerCase())
    take(space)
    return true
  }
  take(space)
  // Bcc alone can legally contain only folding whitespace and comments.
  if (at === source.length) return allowEmpty ? [] : null
  while (at < source.length) {
    if (allowGroups && take(group)) {
      take(space)
      if (source[at] !== ';') {
        if (!takeMailbox()) return null
        while (source[at] === ',') {
          at++
          take(space)
          if (!takeMailbox()) return null
        }
      }
      if (source[at++] !== ';') return null
      take(space)
    } else if (!takeMailbox()) return null
    if (at === source.length) return addresses
    if (source[at++] !== ',') return null
    take(space)
  }
  return null
}

function calendarMail(
  message: RawMessage & { id: string },
  header: ReturnType<typeof messageIdClaims>,
  parts: CalendarMail['parts'],
): CalendarMail {
  const { rfcId } = header
  const references = calendarHeaderIds(message.payload, 'references')
  const parent = calendarHeaderIds(message.payload, 'in-reply-to')
  const validThreading =
    references !== null &&
    parent !== null &&
    parent.length <= 1 &&
    (!parent.length || !references.length || references.at(-1) === parent[0])
  const parentId = validThreading ? (parent[0] ?? references.at(-1) ?? null) : null
  const subject = (headerOf(message.payload, 'Subject') ?? '').replace(/[\r\n]+/g, ' ').trim()
  const from = addressHeader(message.payload, 'from')
  const sender = addressHeader(message.payload, 'sender')
  // There is no verified delegate or provider relay contract here. Reply-To
  // and iTIP SENT-BY are sender-controlled, not evidence of delegation.
  const organizerSender =
    from?.length === 1 && (sender?.length === 0 || (sender?.length === 1 && sender[0] === from[0]))
      ? from[0]!
      : null
  const sent = message.labelIds?.includes('SENT') ?? false
  // The full-response validator has checked the wire int64. Only positive,
  // exactly representable values can currently order durable Sent evidence.
  const internalDate = Number(message.internalDate)
  return {
    messageId: message.id,
    ...header,
    threadId: isGmailMessageId(message.threadId) ? message.threadId : null,
    parent: parentId,
    timestamp: Number.isSafeInteger(internalDate) && internalDate >= 0 ? internalDate : 0,
    sent,
    organizerSender,
    sentAddresses: sent
      ? {
          from,
          to: addressHeader(message.payload, 'to'),
          cc: addressHeader(message.payload, 'cc'),
          bcc: addressHeader(message.payload, 'bcc'),
        }
      : null,
    replyHeaders:
      rfcId && validThreading
        ? {
            subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
            inReplyTo: rfcId,
            references: [
              ...new Set([...references, ...parent].filter((id) => id !== rfcId)),
              rfcId,
            ],
          }
        : null,
    parts,
  }
}

/** Read calendar MIME for revision selection and Sent evidence, including
 * attachments fetched only when the caller consumes their parts. */
export async function fetchThreadCalendarPayloads(
  api: GmailReadApi,
  threadId: string,
  scan: CalendarScan,
) {
  const thread = await fetchFullThread(api, threadId)
  const owners = createMessageIdOwnership()
  const headers = thread.map((message) => {
    const header = messageIdClaims(message.payload)
    owners.index(message.id, header)
    return header
  })
  const messages = thread.flatMap((message, index) => {
    const mail = calendarEnvelope(api, message, scan, headers[index]!)
    return mail ? [mail] : []
  })
  return { messages, owners }
}

function calendarEnvelope(
  api: GmailReadApi,
  message: RawMessage & { id: string },
  scan: CalendarScan,
  header: ReturnType<typeof messageIdClaims>,
) {
  const parts = scan.partsOf(
    api,
    message.id,
    message.payload,
    message.labelIds?.includes('DRAFT') ?? false,
  )
  return parts.length ? calendarMail(message, header, parts) : null
}

/** A receipt can point to any thread. Gather all exact-ID claimants even
 * when threads.get already returned an apparently matching reply. The lookup
 * owns only this provider snapshot; preflight and readback start a fresh one. */
export function createSentCalendarLookup(
  api: GmailReadApi,
  scan: CalendarScan,
  owners: MessageIdOwners,
  inThread: CalendarMail[],
  isKnownDispatch: (mail: CalendarMail) => boolean,
) {
  type Snapshot = {
    message: ReturnType<typeof validateFullMessage>
    header: ReturnType<typeof messageIdClaims>
  }
  const reads = new Map<string, Promise<Snapshot | 'unavailable' | null>>()
  const search = new Map<string, Promise<Snapshot[] | null>>()
  const verifiedReplies = new Map<string, CalendarMail>()
  const hasVerifiedFullReply = (mail: CalendarMail) =>
    verifiedReplies.get(mail.messageId) === mail && owners.owns(mail)
  // Holi's dispatches (and any attempted exact read) require the assessed
  // full envelope. Thread projections still contribute claims and can contest,
  // but cannot fall back to the policy for independent manual responses.
  const ownsSent = (mail: CalendarMail) =>
    mail.sent &&
    (reads.has(mail.messageId) || isKnownDispatch(mail)
      ? hasVerifiedFullReply(mail)
      : owners.owns(mail))
  const read = async (id: string, fromIndex = false) => {
    let request = reads.get(id)
    // An individual GET can return 404 before the index makes the resource
    // readable. An index row still needs a successful full read.
    if (fromIndex && request && (await request) === null && reads.get(id) === request)
      request = undefined
    if (!request) {
      scan.evidenceRead()
      request = api
        .get<RawMessage>(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}`, { format: 'full' })
        .then((raw) => {
          const message = validateFullMessage(raw, id)
          const header = messageIdClaims(message.payload)
          owners.index(message.id, header)
          return { message, header }
        })
        .catch((error) => {
          if (error instanceof GoogleApiError && error.code === 'not-found') return null
          // Unlike a 404, an unreadable receipt cannot be retried as an index
          // hit or replaced by the thread projection in this snapshot.
          if (sentResourceUnavailable(error)) return 'unavailable' as const
          if (error instanceof SyntaxError)
            throw new CalendarScanError('Gmail returned an invalid full message response')
          throw error
        })
      reads.set(id, request)
    }
    return request
  }
  async function exact(rfcId: string): Promise<Snapshot[] | null> {
    scan.evidenceRead()
    const page = await api
      .get<unknown>(`${GMAIL_BASE}/messages`, {
        // Ownership is account-wide; neither folder nor label limits it.
        includeSpamTrash: 'true',
        q: `rfc822msgid:${rfcId.slice(1, -1)}`,
        maxResults: '10',
      })
      .catch((error) => {
        if (error instanceof SyntaxError || sentResourceUnavailable(error)) return null
        throw error
      })
    if (!page || typeof page !== 'object' || Array.isArray(page)) return null
    const { messages, nextPageToken, resultSizeEstimate } = page as Record<string, unknown>
    // A search with another page is incomplete within the evidence budget.
    // An actual empty Gmail object is valid; arbitrary JSON is not an empty result.
    if (
      nextPageToken !== undefined ||
      Object.keys(page).some(
        (key) => !['messages', 'nextPageToken', 'resultSizeEstimate'].includes(key),
      ) ||
      (resultSizeEstimate !== undefined &&
        (typeof resultSizeEstimate !== 'number' ||
          !Number.isInteger(resultSizeEstimate) ||
          resultSizeEstimate < 0 ||
          resultSizeEstimate > 0xffffffff)) ||
      (messages !== undefined && (!Array.isArray(messages) || messages.length > 10))
    )
      return null
    const candidates = new Map<string, string | null>()
    for (const candidate of messages ?? []) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        !isGmailMessageId(candidate.id) ||
        candidates.has(candidate.id) ||
        (candidate.threadId !== undefined && !isGmailMessageId(candidate.threadId))
      )
        return null
      candidates.set(candidate.id, candidate.threadId ?? null)
    }
    const found = []
    let incomplete = false
    for (const [id, threadId] of candidates) {
      const snapshot = await read(id, true)
      // Index every full resource's claims, even plain mail or a duplicate
      // declaration. A contradictory hit cannot certify the search as complete.
      if (
        !snapshot ||
        snapshot === 'unavailable' ||
        (threadId !== null && snapshot.message.threadId !== threadId) ||
        !snapshot.header.claims.has(rfcId)
      )
        incomplete = true
      else found.push(snapshot)
    }
    if (incomplete) return null
    return found
  }
  async function gather(rfcId: string, receipt: CalendarReplyReceipt) {
    if (receipt.id) await read(receipt.id)
    let request = search.get(rfcId)
    if (!request) {
      request = exact(rfcId)
      search.set(rfcId, request)
    }
    const indexed = await request
    if (indexed === null) return null
    const direct = receipt.id ? await reads.get(receipt.id) : undefined
    if (direct === 'unavailable') return null
    // Even after a direct 404, the index cannot change the receipt's thread.
    if (direct && receipt.threadId && direct.message.threadId !== receipt.threadId) return null
    return direct
      ? [direct, ...indexed.filter(({ message }) => message.id !== direct.message.id)]
      : indexed
  }
  return {
    ownsSent,
    hasVerifiedFullReply,
    wasRead: (messageId: string) => reads.has(messageId),
    threadEvidence: () => inThread.map((mail) => verifiedReplies.get(mail.messageId) ?? mail),
    async findReply(
      rfcId: string,
      receipt: CalendarReplyReceipt,
      assess: (message: CalendarMail) => Promise<'match' | 'related' | 'unresolved' | null>,
    ): Promise<{
      mail: CalendarMail | null
      contestedTimestamp: number | null
      unresolvedReply: boolean
    }> {
      // A thread hit can locate the full resource when send returned no ID
      // and the account-wide index has not caught up. It cannot prove it.
      const visible =
        !receipt.id &&
        inThread.find((mail) => mail.sent && mail.rfcId === rfcId && owners.owns(mail))
      const locator = visible
        ? { id: visible.messageId, threadId: receipt.threadId ?? visible.threadId }
        : receipt
      const sources = await gather(rfcId, locator)
      if (sources === null) return { mail: null, contestedTimestamp: null, unresolvedReply: true }
      const candidates = new Map<string, CalendarMail | null>()
      for (const mail of inThread) {
        if (mail.claims.has(rfcId)) candidates.set(mail.messageId, mail)
      }
      // A full resource is stronger than the thread's MIME projection of the
      // same ID. A plain message still claims ownership but cannot be a reply.
      for (const { message, header } of sources) {
        if (candidates.has(message.id) || header.claims.has(rfcId))
          candidates.set(
            message.id,
            header.claims.has(rfcId)
              ? (verifiedReplies.get(message.id) ?? calendarEnvelope(api, message, scan, header))
              : null,
          )
      }
      let contestedTimestamp = 0
      let unordered = false
      let unresolvedReply = Boolean(locator.id || receipt.threadId || receipt.invalidLocator)
      const sourceIds = new Set(sources.map(({ message }) => message.id))
      for (const mail of candidates.values()) {
        if (!mail) continue
        const evidence = await assess(mail)
        if (!evidence) continue
        if (evidence === 'unresolved') unresolvedReply = true
        const full = sourceIds.has(mail.messageId)
        if (mail.sent && owners.owns(mail) && (full || !reads.has(mail.messageId))) {
          // The index corroborates the receipt; it cannot substitute another
          // Gmail message for an acknowledged ID, even with the same RFC ID.
          const matchesReceipt =
            !receipt.invalidLocator &&
            mail.rfcId === rfcId &&
            (!receipt.id || mail.messageId === receipt.id) &&
            (!receipt.threadId || mail.threadId === receipt.threadId)
          if (evidence === 'match' && full && matchesReceipt) {
            verifiedReplies.set(mail.messageId, mail)
            return { mail, contestedTimestamp: 0, unresolvedReply: false }
          }
          if (evidence !== 'unresolved' && !(evidence === 'match' && !full)) continue
        }
        // Ordered but contested or unreadable evidence may set a floor for an
        // independent newer answer. It neither confirms the write nor proves its parent.
        if (!mail.timestamp) unordered = true
        contestedTimestamp = Math.max(contestedTimestamp, mail.timestamp)
      }
      return {
        mail: null,
        contestedTimestamp: unordered ? null : contestedTimestamp,
        unresolvedReply,
      }
    },
  }
}

/** Send a calendar reply to only the organizer, in the thread being answered. */
export async function sendCalendarReply(
  api: GoogleApi,
  threadId: string,
  headers: CalendarReplyHeaders,
  rfcId: string,
  from: string,
  organizer: string,
  calendarText: string,
  gate: GoogleDispatchGate,
): Promise<CalendarReplyReceipt> {
  // The caller supplies the verified mailbox, not a From header from the invitation.
  if (/[\r\n]/.test(from)) throw new Error('Invalid calendar reply sender')
  const message = buildRfc822({
    ...headers,
    to: [organizer],
    body: 'This message contains a calendar response.',
    attachments: [
      {
        filename: 'invite.ics',
        mimeType: 'text/calendar; method=REPLY; charset=UTF-8',
        disposition: 'inline',
        data: Buffer.from(calendarText, 'utf8').toString('base64'),
      },
    ],
  })
  const sent = await api.postJson<{ id?: unknown; threadId?: unknown }>(
    `${GMAIL_BASE}/messages/send`,
    {
      raw: toBase64Url(`From: ${from}\r\nMessage-ID: ${rfcId}\r\n${message}`),
      threadId,
    },
    gate,
  )
  const id = isGmailMessageId(sent?.id) ? sent.id : null
  const actualThreadId = isGmailMessageId(sent?.threadId) ? sent.threadId : null
  // A supplied but unusable ID isn't permission for RFC-only recovery.
  const invalidLocator =
    (sent?.id !== undefined && id === null) ||
    (sent?.threadId !== undefined && actualThreadId === null)
  return { id, threadId: actualThreadId, ...(invalidLocator ? { invalidLocator: true } : {}) }
}
