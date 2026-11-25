import { GoogleApiError, type GoogleApi, type GoogleDispatchGate } from './api'
import { normalizeMessageIds, parseAddresses } from './gmail-headers'
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

const MAX_CALENDAR_PART_BYTES = 256 * 1024
const calendarUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export class CalendarTextEncodingError extends CalendarScanError {
  constructor() {
    super('Gmail calendar part is not valid UTF-8')
  }
}

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
      throw new CalendarScanError('Invalid Gmail calendar part size')
    check(value <= MAX_CALENDAR_PART_BYTES && value <= bytes)
    return value
  }
  async function readPart(api: GoogleApi, messageId: string, part: RawPart): Promise<string> {
    const declared = size(part.body?.size)
    let encoded: unknown = part.body?.data
    const attachment = part.body?.attachmentId
    if (attachment !== undefined) {
      if (typeof attachment !== 'string' || !attachment || encoded !== undefined)
        throw new CalendarScanError('Invalid Gmail calendar attachment')
      check(--attachments >= 0)
      const body = await api.get<{ size?: number; data?: string }>(
        `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment)}`,
      )
      if (size(body?.size) !== declared)
        throw new CalendarScanError('Gmail calendar attachment size changed')
      encoded = body?.data
    }
    if (encoded === undefined && declared === 0) return ''
    if (typeof encoded !== 'string') throw new CalendarScanError('Missing Gmail calendar part data')
    check(encoded.length <= Math.ceil(Math.min(bytes, MAX_CALENDAR_PART_BYTES, declared) / 3) * 4)
    if (!/^[a-z0-9_-]*={0,2}$/i.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1)
      throw new CalendarScanError('Invalid Gmail calendar part encoding')
    const decoded = Buffer.from(encoded, 'base64url')
    check(decoded.length <= MAX_CALENDAR_PART_BYTES && decoded.length <= bytes)
    if (decoded.length !== declared) throw new CalendarScanError('Invalid Gmail calendar part size')
    bytes -= decoded.length
    try {
      return calendarUtf8.decode(decoded)
    } catch {
      // Do not manufacture an identity by replacing malformed wire bytes.
      throw new CalendarTextEncodingError()
    }
  }
  return {
    partsOf(
      api: GoogleApi,
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
        if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0))
          throw new CalendarScanError('Invalid Gmail calendar part size')
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
  from: string
  sentAddresses: { from: string[]; to: string[] } | null
  replyHeaders: CalendarReplyHeaders | null
  parts: {
    method: string | undefined | null
    alternatives: MimeLocation['alternatives']
    read: () => Promise<string>
  }[]
}

type CalendarReplyReceipt = { id: string | null; threadId: string | null }

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

function uniqueAddressHeader(part: RawPart | undefined, name: string): string | null {
  const headers = (part?.headers ?? []).filter((header) => header.name?.toLowerCase() === name)
  const value = headers.length === 1 ? headers[0]?.value : null
  return typeof value === 'string' ? value : null
}

/** Unlike display parsing, Sent evidence must consume the whole unique header.
 * Require a dot-atom SMTP address (the form used by calendar addresses). */
function sentEvidenceAddresses(value: string | null, allowGroups: boolean): string[] {
  if (value === null) return []
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ')
  if (/\p{Cc}/u.test(unfolded.replaceAll('\t', ''))) return []
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
      if (!comments) return []
      comments--
    } else if (!comments) {
      if (char === '"') quoted = !quoted
      source += char
    }
  }
  if (comments || quoted || escaped) return []

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
  while (at < source.length) {
    if (allowGroups && take(group)) {
      take(space)
      if (source[at] !== ';') {
        if (!takeMailbox()) return []
        while (source[at] === ',') {
          at++
          take(space)
          if (!takeMailbox()) return []
        }
      }
      if (source[at++] !== ';') return []
      take(space)
    } else if (!takeMailbox()) return []
    if (at === source.length) return addresses
    if (source[at++] !== ',') return []
    take(space)
  }
  return []
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
  const fromHeader = uniqueAddressHeader(message.payload, 'from')
  const from = parseAddresses(fromHeader)
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
    from: from.length === 1 ? from[0]!.email : '',
    sentAddresses: sent
      ? {
          from: sentEvidenceAddresses(fromHeader, false),
          to: sentEvidenceAddresses(uniqueAddressHeader(message.payload, 'to'), true),
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
  api: GoogleApi,
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
  api: GoogleApi,
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
  api: GoogleApi,
  scan: CalendarScan,
  owners: MessageIdOwners,
) {
  type Snapshot = {
    message: ReturnType<typeof validateFullMessage>
    header: ReturnType<typeof messageIdClaims>
  }
  const reads = new Map<string, Promise<Snapshot | null>>()
  const search = new Map<string, Promise<Snapshot[] | null>>()
  const complete = new Set<string>()
  const hasVerifiedOwner = (reply: { rfcId: string; messageId: string }) =>
    complete.has(reply.rfcId) && owners.owns(reply)
  const read = async (id: string, threadId: string | null, fromIndex = false) => {
    // An individual GET can return 404 before the index makes the resource
    // readable. An index row still needs a successful full read.
    if (fromIndex && reads.has(id) && (await reads.get(id)) === null) reads.delete(id)
    let request = reads.get(id)
    if (!request) {
      scan.evidenceRead()
      request = api
        .get<RawMessage>(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}`, { format: 'full' })
        .then((raw) => {
          const message = validateFullMessage(raw, id, threadId)
          const header = messageIdClaims(message.payload)
          owners.index(message.id, header)
          return { message, header }
        })
        .catch((error) => {
          if (error instanceof GoogleApiError && error.code === 'not-found') return null
          if (error instanceof SyntaxError)
            throw new CalendarScanError('Gmail returned an invalid full message response')
          throw error
        })
      reads.set(id, request)
    }
    const result = await request
    if (result && threadId !== null && result.message.threadId !== threadId)
      throw new CalendarScanError('Gmail returned conflicting full message identities')
    return result
  }
  async function exact(rfcId: string): Promise<Snapshot[] | null> {
    scan.evidenceRead()
    const page = await api.get<{
      messages?: Pick<RawMessage, 'id' | 'threadId'>[]
      nextPageToken?: string
    }>(`${GMAIL_BASE}/messages`, {
      labelIds: 'SENT',
      q: `rfc822msgid:${rfcId.slice(1, -1)}`,
      maxResults: '10',
    })
    if (
      !page ||
      page.nextPageToken !== undefined ||
      (page.messages !== undefined && (!Array.isArray(page.messages) || page.messages.length > 10))
    )
      return null
    const found = []
    let missing = false
    for (const candidate of page.messages ?? []) {
      if (
        !isGmailMessageId(candidate?.id) ||
        (candidate.threadId !== undefined && !isGmailMessageId(candidate.threadId))
      )
        return null
      const snapshot = await read(candidate.id, candidate.threadId ?? null, true)
      if (snapshot) found.push(snapshot)
      else missing = true
    }
    if (missing) return null
    complete.add(rfcId)
    return found
  }
  async function gather(rfcId: string, receipt: CalendarReplyReceipt | null) {
    if (receipt?.id) await read(receipt.id, receipt.threadId)
    let request = search.get(rfcId)
    if (!request) {
      request = exact(rfcId)
      search.set(rfcId, request)
    }
    const indexed = await request
    if (indexed === null) return null
    const direct = receipt?.id ? await reads.get(receipt.id) : undefined
    // Even after a direct 404, the index cannot change the receipt's thread.
    if (direct && receipt?.threadId && direct.message.threadId !== receipt.threadId) return null
    return direct
      ? [direct, ...indexed.filter(({ message }) => message.id !== direct.message.id)]
      : indexed
  }
  return {
    hasVerifiedOwner,
    async checkAnchor({ rfcId, messageId }: { rfcId: string; messageId: string }) {
      await gather(rfcId, { id: messageId, threadId: null })
    },
    async findReply(
      rfcId: string,
      receipt: CalendarReplyReceipt | null,
      inThread: CalendarMail[],
      assess: (message: CalendarMail) => Promise<'match' | 'related' | 'unresolved' | null>,
    ): Promise<{
      mail: CalendarMail | null
      contestedTimestamp: number | null
      unresolvedReply: boolean
    }> {
      const sources = await gather(rfcId, receipt)
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
            header.claims.has(rfcId) ? calendarEnvelope(api, message, scan, header) : null,
          )
      }
      let contestedTimestamp = 0
      let unordered = false
      let unresolvedReply = false
      const sourceIds = new Set(sources.map(({ message }) => message.id))
      for (const mail of candidates.values()) {
        if (!mail) continue
        const evidence = await assess(mail)
        if (!evidence) continue
        if (evidence === 'unresolved') unresolvedReply = true
        if (owners.owns(mail)) {
          const matchesLocator =
            !receipt?.id ||
            (mail.messageId === receipt.id &&
              (!receipt.threadId || mail.threadId === receipt.threadId))
          if (evidence === 'match' && (matchesLocator || sourceIds.has(mail.messageId)))
            return { mail, contestedTimestamp: 0, unresolvedReply: false }
          if (evidence !== 'unresolved') continue
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
  const sent = await api.postJson<{ id?: string; threadId?: string }>(
    `${GMAIL_BASE}/messages/send`,
    {
      raw: toBase64Url(`From: ${from}\r\nMessage-ID: ${rfcId}\r\n${message}`),
      threadId,
    },
    gate,
  )
  const identifier = (value: unknown) => (isGmailMessageId(value) ? value : null)
  return { id: identifier(sent?.id), threadId: identifier(sent?.threadId) }
}
