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
    return decoded.toString('utf8')
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

/** A receipt can point to a different thread. Combine it with the bounded,
 * account-wide exact-ID Sent lookup before filtering for a positive reply. */
export async function findSentCalendarReply(
  api: GoogleApi,
  rfcId: string,
  receipt: CalendarReplyReceipt | null,
  scan: CalendarScan,
  owners: MessageIdOwners,
  assess: (message: CalendarMail) => Promise<'match' | 'related' | null>,
): Promise<{ mail: CalendarMail | null; contestedTimestamp: number | null }> {
  const unresolved = { mail: null, contestedTimestamp: null }
  const messages = new Map<
    string,
    {
      message: ReturnType<typeof validateFullMessage>
      header: ReturnType<typeof messageIdClaims>
    } | null
  >()
  const read = async (id: string, threadId: string | null) => {
    if (!messages.has(id)) {
      scan.evidenceRead()
      const raw = await api
        .get<RawMessage>(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}`, { format: 'full' })
        .catch((error) => {
          // Only an individual missing message permits recovery through the exact-ID index.
          if (error instanceof GoogleApiError && error.code === 'not-found') return undefined
          if (error instanceof SyntaxError)
            throw new CalendarScanError('Gmail returned an invalid full message response')
          throw error
        })
      if (raw === undefined) messages.set(id, null)
      else {
        const message = validateFullMessage(raw, id, threadId)
        const header = messageIdClaims(message.payload)
        owners.index(message.id, header)
        messages.set(id, { message, header })
      }
    }
    const result = messages.get(id)
    if (result && threadId !== null && result.message.threadId !== threadId)
      throw new CalendarScanError('Gmail returned conflicting full message identities')
    return result
  }
  if (receipt?.id && !(await read(receipt.id, receipt.threadId))) {
    // The send acknowledgement can precede the resource. The index may
    // now make that same ID readable; a cached 404 is not a claimant.
    messages.delete(receipt.id)
  }
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
    return unresolved
  let missing = false
  for (const candidate of page.messages ?? []) {
    if (
      !isGmailMessageId(candidate?.id) ||
      (candidate.threadId !== undefined && !isGmailMessageId(candidate.threadId))
    )
      return unresolved
    // An index row for the receipt's provider ID must not change the
    // thread identity named by that receipt, even after a transient 404.
    const expectedThread = candidate.id === receipt?.id ? receipt.threadId : null
    if (expectedThread && candidate.threadId && candidate.threadId !== expectedThread)
      return unresolved
    if (!(await read(candidate.id, expectedThread ?? candidate.threadId ?? null))) missing = true
  }
  if (missing) return unresolved
  let contestedTimestamp = 0
  for (const claimed of messages.values()) {
    if (!claimed?.header.claims.has(rfcId)) continue
    const { message, header } = claimed
    const mail = calendarEnvelope(api, message, scan, header)
    if (!mail) continue
    const evidence = await assess(mail)
    if (!evidence) continue
    if (owners.owns(mail)) {
      if (evidence === 'match') return { mail, contestedTimestamp: 0 }
      continue
    }
    // Ordered but contested evidence may set a floor for an independent newer
    // answer. It can neither confirm the dispatch nor establish its parent.
    if (!mail.timestamp) return unresolved
    contestedTimestamp = Math.max(contestedTimestamp, mail.timestamp)
  }
  return { mail: null, contestedTimestamp }
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
