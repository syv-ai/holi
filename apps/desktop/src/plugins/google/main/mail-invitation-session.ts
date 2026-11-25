import { randomUUID } from 'node:crypto'
import { CapabilityError } from '../../../main/plugin-api'
import {
  GoogleApiError,
  GoogleWriteUncertainError,
  type GoogleApi,
  type GoogleDispatchGate,
} from './api'
import type { InviteAnswer } from './calendar'
import {
  calendarTargetIsMailbox,
  findInvitationCalendarCopy,
  verifyInvitationCalendarResponse,
} from './mail-invitation-calendar'
import { CalendarScanError } from './gmail-mime'
import {
  CalendarTextEncodingError,
  createCalendarScan,
  createMessageIdOwnership,
  fetchThreadCalendarPayloads,
  findSentCalendarReply,
  sendCalendarReply,
} from './gmail-invitation-transport'
import { parseCalendarMail } from './invite'
import {
  assertEquivalentAlternatives,
  identityOf,
  representationOf,
  onLineage,
  sameGroup,
  sameInvitation,
  sameRevision,
  scopeKey,
  selectInvitationRevisions,
  supersedes,
  type Candidate,
} from './mail-invitation-revisions'
import type {
  createMailInvitationStore,
  InvitationAttempt,
  ParentAnchor,
  SentEvidence,
} from './mail-invitation-store'
import {
  invitationReplyStatus,
  parseMailInvitation,
  type MailInvitationIdentity,
} from './mail-invitation'

type Invitation = NonNullable<ReturnType<typeof parseMailInvitation>>
type Thread = Awaited<ReturnType<typeof fetchThreadCalendarPayloads>>
type Mail = Thread['messages'][number]
type Revision = InvitationAttempt['revision']
type MailInvitation = Invitation['details'] & {
  bindingRevision: string
  kind: 'invitation' | 'meeting'
  scope: 'single' | 'series' | 'occurrence'
  responseStatus: NonNullable<Revision['mailboxResponse']>['responseStatus'] | null
  /** The verified Calendar copy's current self response, not a mail or journal fallback. */
  recordedResponseStatus: MailInvitation['responseStatus']
  /** The latest corroborated Gmail reply, unless superseded by a Calendar response. */
  sentResponseStatus: InviteAnswer | null
  canRespond: boolean
  /** A write has not yet been corroborated by Calendar or a sent REPLY. */
  responsePending: boolean
}
type Channel = InvitationAttempt['delivery']['channel']
type RespondResult = {
  /** Sent means Google accepted it, not that the organizer received it. */
  outcome: 'sent' | 'unchanged' | 'uncertain'
  channel: Channel
  answer: InviteAnswer
  invitation: MailInvitation | null
  /** Read with mailInvitation to reconcile; never repeat the write on Retry. */
  refreshPending: boolean
}
type Target = {
  api: GoogleApi
  threadId: string
  accountSub: string
  bindingRevision: string
  email: string
  assertBinding: () => void
}
type Scan = ReturnType<typeof createCalendarScan>
type Reply = { key: string } & (
  | {
      channel: 'calendar'
      target: string
      proof: string
      send: (answer: InviteAnswer, gate: GoogleDispatchGate) => Promise<void>
    }
  | {
      channel: 'gmail'
      target: string
      headers: NonNullable<Mail['replyHeaders']>
      organizer: string
      body: (email: string, answer: InviteAnswer) => string
    }
)
type Resolved = {
  invitation: MailInvitation
  reply: Reply | null
  response: Revision['mailboxResponse']
  recorded: InviteAnswer | null
  priorSent: SentEvidence | null
}
type ReadResult = { cards: Resolved[]; recoveryReason: string | null }
type CalendarCopy = Awaited<ReturnType<typeof findInvitationCalendarCopy>>

type Confirmation = { attempt: InvitationAttempt; mail: Mail | null; disputedParent: boolean }
type LineageMatch = (attempt: InvitationAttempt) => 'linked' | 'disputed' | null

type SentAddress = { organizer: string; mailbox: string }
const sentVerificationReason = 'Gmail could not verify the latest sent response'

function readPossibleReply(part: Mail['parts'][number]): Promise<string | null> {
  return part.read().catch((error) => {
    if (error instanceof CalendarTextEncodingError) return null
    throw error
  })
}

async function latestByScope({ messages, owners }: Thread, mailbox: string) {
  const candidates: Candidate[] = []
  for (const mail of messages) {
    if (mail.sent && mail.from !== mailbox) continue
    const representations = []
    let hasCandidate = false
    for (const part of mail.parts) {
      if (part.method === null)
        throw new CalendarScanError('Gmail could not verify the calendar MIME declaration')
      if (mail.sent && part.method === 'REPLY' && !part.alternatives.length) continue
      // A Sent part without a revision declaration may be a reply even
      // when its bytes cannot be read. Assess it against known parents below.
      const possibleReply =
        mail.sent && mail.parent && (part.method === undefined || part.method === 'REPLY')
      const source = await (possibleReply ? readPossibleReply(part) : part.read())
      const parsed = source === null ? null : parseCalendarMail(mail.messageId, source, part.method)
      const candidate = parsed && (!mail.sent || parsed.value.method) ? { ...parsed, mail } : null
      if (candidate) {
        hasCandidate = true
        candidates.push(candidate)
      }
      if (part.alternatives.length) {
        representations.push({
          alternatives: part.alternatives,
          signature: candidate ? representationOf(candidate, mailbox) : `unrecognized:${source}`,
        })
      }
    }
    if (hasCandidate || !mail.sent) assertEquivalentAlternatives(representations)
  }
  return selectInvitationRevisions(candidates, mailbox, owners)
}

async function sentAnswer(mail: Mail, revision: Revision, { mailbox, organizer }: SentAddress) {
  const addresses = mail.sentAddresses
  if (
    !mail.sent ||
    !addresses ||
    addresses.from.length !== 1 ||
    addresses.from[0] !== mailbox ||
    addresses.to.length !== 1 ||
    addresses.to[0] !== organizer
  )
    return { answers: [], unresolved: false }
  const answers = new Set<InviteAnswer>()
  const representations = []
  let unrelated = false
  let unresolved = false
  for (const part of mail.parts) {
    // The caller established a known parent separately. A malformed calendar
    // body cannot corroborate that relation, but cannot disprove it either.
    const method = part.method
    const source = method === null ? null : await readPossibleReply(part)
    const answer =
      method === null || source === null
        ? 'unresolved'
        : invitationReplyStatus(source, revision, organizer, mailbox, method)
    if (answer === 'unresolved') unresolved = true
    else if (answer) answers.add(answer)
    else unrelated = true
    if (part.alternatives.length)
      representations.push({
        alternatives: part.alternatives,
        signature: answer && answer !== 'unresolved' ? answer : `unrecognized:${source}`,
      })
  }
  if (!unresolved && answers.size) assertEquivalentAlternatives(representations)
  // One matching part cannot authorize readback for a mixed or malformed reply.
  unresolved ||= unrelated && answers.size > 0
  return { answers: unresolved ? [] : [...answers], unresolved }
}

async function sentResponse(
  messages: Mail[],
  owners: Thread['owners'],
  parents: Set<string>,
  relatedParents: Set<string>,
  revision: Revision,
  address: SentAddress,
  protectReceiptSince?: number,
) {
  let newest = -Infinity
  const answers = new Set<InviteAnswer>()
  const unordered = new Set<InviteAnswer>()
  let contested = false
  let unorderedContest = false
  let unresolved = false
  const messageIds = new Set<string>()
  for (const message of [...messages].sort((a, b) => b.timestamp - a.timestamp)) {
    const parent = message.parent
    if (!message.sent || !parent || !relatedParents.has(parent)) continue
    const { timestamp } = message
    const older = timestamp !== 0 && timestamp < newest
    const couldObscureReceipt =
      protectReceiptSince !== undefined && (timestamp === 0 || timestamp >= protectReceiptSince)
    // A newer disputed answer is not independent proof that an older
    // unreadable reply may be ignored when settling a dispatch reservation.
    if (older && (!couldObscureReceipt || (!contested && answers.size === 1))) continue
    const matched = await sentAnswer(message, revision, address)
    if (matched.unresolved && (protectReceiptSince === undefined || couldObscureReceipt))
      unresolved = true
    if (older || (!matched.unresolved && (!parents.has(parent) || !matched.answers.length)))
      continue
    const disputed = matched.unresolved || !owners.owns(message)
    if (message.timestamp === 0) {
      if (disputed) unorderedContest = true
      else for (const answer of matched.answers) unordered.add(answer)
      continue
    }
    newest = message.timestamp
    if (disputed) contested = true
    else {
      for (const answer of matched.answers) answers.add(answer)
      messageIds.add(message.messageId)
    }
  }
  const evidence: SentEvidence | null = messageIds.size
    ? {
        timestamp: newest,
        messageIds: [...messageIds].sort(),
        answer: answers.size === 1 ? answers.values().next().value! : null,
      }
    : null
  return {
    answers,
    evidence,
    unresolved,
    orderUnverified:
      contested || unorderedContest || [...unordered].some((answer) => answer !== evidence?.answer),
  }
}

function isAnswer(status: MailInvitation['responseStatus']): status is InviteAnswer {
  return status === 'accepted' || status === 'tentative' || status === 'declined'
}

function sameWriteTarget(a: Reply, b: Reply): boolean {
  if (a.channel === 'calendar' && b.channel === 'calendar')
    return a.target === b.target && a.proof === b.proof
  return a.channel === 'gmail' && b.channel === 'gmail' && a.target === b.target
}

// A no-op found by final preflight must leave the gate before reservation.
// It is not a provider refusal or an uncertain dispatch.
class AlreadyRecorded extends Error {
  constructor(readonly result: RespondResult) {
    super()
  }
}

function conflict(): CapabilityError {
  return new CapabilityError('CONFLICT', 'This invitation changed; reload it before responding')
}

// A reconstructed owner must not reclaim a prepared reservation still in use
// by another caller in this process. A restart has no live dispatches.
const dispatching = new Set<string>()

/** One Electron-process owner, used by every vault. A durable reservation
 * precedes dispatch; Retry reads Google and never replays a write. */
export function createMailInvitationSession(store: ReturnType<typeof createMailInvitationStore>) {
  const busy = new Set<string>()
  const changeAttempt = (
    id: string,
    change: (attempt: InvitationAttempt) => InvitationAttempt | null,
  ) =>
    store.update((journal) => ({
      ...journal,
      attempts: journal.attempts.flatMap(
        (attempt) => (attempt.id === id ? change(attempt) : attempt) ?? [],
      ),
    }))

  async function reconcile(
    target: Target,
    attempts: InvitationAttempt[],
    { messages, owners }: Thread,
    scan: Scan,
    copies: Map<string, CalendarCopy>,
    lineages: Map<string, LineageMatch>,
    parentAnchors: ParentAnchor[],
    receiptObscured: (attempt: InvitationAttempt, mail: Mail) => Promise<boolean>,
  ) {
    const pending: InvitationAttempt[] = []
    const contested = new Map<string, number>()
    const unverifiedReceipts = new Set<string>()
    const corroborated: {
      attempt: InvitationAttempt
      prior: InvitationAttempt
      mail: Mail | null
    }[] = []
    const confirmations = new Map<string, Confirmation>()
    // Journal order is dispatch order for a scope. Verify unresolved writes,
    // but do not read old confirmations once a newer one owns the lineage.
    for (const attempt of [...attempts].reverse()) {
      const { id, delivery, revision, answer } = attempt
      const key = scopeKey(revision)
      const matchLineage = lineages.get(key)
      const match = matchLineage?.(attempt) ?? null
      if (dispatching.has(id)) {
        pending.push(attempt)
        continue
      }
      if (attempt.state === 'prepared') {
        target.assertBinding()
        await changeAttempt(id, (entry) => (entry.state === 'prepared' ? null : entry))
        continue
      }
      if (attempt.state === 'confirmed' && (match === null || confirmations.has(key))) continue

      let mail: Mail | null = null
      let confirmed = attempt
      if (delivery.channel === 'calendar') {
        if (attempt.state !== 'confirmed') {
          const copy = copies.get(key)
          const matching =
            copy?.kind === 'verified' &&
            copy.target === delivery.target &&
            (delivery.proof
              ? copy.matchesProof(delivery.proof)
              : sameRevision(copy.revision, revision))
          const observed = matching
            ? copy.responseStatus === answer
            : delivery.proof &&
              (await verifyInvitationCalendarResponse(
                target.api,
                delivery.target,
                delivery.proof,
                answer,
                target.email,
              ))
          if (!observed) {
            pending.push(attempt)
            continue
          }
          confirmed = {
            ...attempt,
            state: 'confirmed',
            delivery: matching ? { ...delivery, proof: copy.proof } : delivery,
          }
        }
      } else if (
        attempt.state !== 'confirmed' ||
        match !== 'disputed' ||
        delivery.confirmedSentTimestamp === undefined
      ) {
        const assess = async (mail: Mail) => {
          if (mail.parent !== delivery.parent) return null
          const { answers, unresolved } = await sentAnswer(mail, revision, delivery)
          if (unresolved) return 'unresolved'
          if (answers.length === 1 && answers[0] === answer) return 'match'
          return answers.length ? 'related' : null
        }
        const inThread = messages.filter((message) => message.claims.has(delivery.rfcId))
        const owned = inThread.find((message) => owners.owns(message))
        const receipt = delivery.receipt
        const liveReceipt =
          owned &&
          (!receipt?.id ||
            (receipt.id === owned.messageId &&
              (!receipt.threadId || receipt.threadId === owned.threadId)))
            ? owned
            : null
        if (liveReceipt && (await assess(liveReceipt)) === 'match') mail = liveReceipt
        if (!mail) {
          const found = await findSentCalendarReply(
            target.api,
            delivery.rfcId,
            delivery.receipt,
            scan,
            owners,
            assess,
          )
          mail = found.mail
          if (found.unresolvedReply) unverifiedReceipts.add(id)
          const timestamps = found.contestedTimestamp ? [found.contestedTimestamp] : []
          if (!mail) {
            for (const message of inThread) {
              const evidence = await assess(message)
              if (evidence === 'unresolved') unverifiedReceipts.add(id)
              if (evidence && (evidence === 'unresolved' || !owners.owns(message)))
                timestamps.push(message.timestamp)
            }
          }
          if (
            found.contestedTimestamp !== null &&
            timestamps.length &&
            timestamps.every((stamp) => stamp > 0)
          )
            contested.set(id, Math.max(...timestamps))
        }
        if (attempt.state !== 'confirmed') {
          if (!mail) {
            pending.push(attempt)
            continue
          }
          confirmed = {
            ...attempt,
            state: 'confirmed',
            delivery: {
              ...delivery,
              receipt: { id: mail.messageId, threadId: mail.threadId },
              confirmedSentTimestamp: mail.timestamp || undefined,
            },
          }
        }
      }
      if (confirmed !== attempt) corroborated.push({ attempt: confirmed, prior: attempt, mail })
      if (match !== null && !confirmations.has(key))
        confirmations.set(key, { attempt: confirmed, mail, disputedParent: match === 'disputed' })
    }
    // Every exact lookup contributes claims before any new receipt can become
    // durable. A later lookup in this read can contradict an earlier receipt.
    for (const { attempt, prior, mail } of corroborated) {
      const key = scopeKey(attempt.revision)
      if (mail && (!owners.owns(mail) || (await receiptObscured(attempt, mail)))) {
        if (confirmations.get(key)?.attempt === attempt) confirmations.delete(key)
        pending.push(prior)
        unverifiedReceipts.add(prior.id)
        if (mail.timestamp && !owners.owns(mail)) contested.set(prior.id, mail.timestamp)
        continue
      }
      target.assertBinding()
      const matchLineage = lineages.get(key)
      const provesAnchor = (entry: InvitationAttempt) =>
        entry.delivery.channel === 'gmail' &&
        entry.delivery.receipt?.id != null &&
        matchLineage?.(entry) === 'linked' &&
        !owners.contradicts({
          rfcId: entry.delivery.rfcId,
          messageId: entry.delivery.receipt.id,
        })
      const journal = await store.confirmAttempt(
        attempt,
        (entry) =>
          matchLineage?.(attempt) === 'linked' &&
          entry.accountSub === target.accountSub &&
          matchLineage(entry) === 'linked' &&
          (entry.delivery.channel !== 'gmail' || provesAnchor(entry)),
        provesAnchor,
      )
      parentAnchors = journal.parentAnchors
    }
    return { pending, confirmations, parentAnchors, contested, unverifiedReceipts }
  }

  const read = async (
    target: Target,
    scan: Scan,
    selection?: Revision,
    excludeAttempt?: string,
  ): Promise<ReadResult> => {
    const { api, threadId, accountSub, email } = target
    target.assertBinding()
    const journal = await store.read()
    let missingThread = false
    const thread = await fetchThreadCalendarPayloads(api, threadId, scan).catch((error): Thread => {
      if (!(error instanceof GoogleApiError) || error.status !== 404) throw error
      missingThread = true
      return { messages: [], owners: createMessageIdOwnership() }
    })
    const { messages, owners } = thread
    const incoming = await latestByScope(thread, email)
    const scopes = selection
      ? incoming.filter((entry) => sameGroup(identityOf(entry.selected), selection))
      : incoming
    target.assertBinding()
    const relevant = journal.attempts.filter(
      (attempt) =>
        attempt.accountSub === accountSub &&
        attempt.id !== excludeAttempt &&
        (selection
          ? sameGroup(attempt.revision, selection)
          : attempt.threadId === threadId ||
            scopes.some((entry) => sameGroup(identityOf(entry.selected), attempt.revision))),
    )
    const copies = new Map<string, CalendarCopy>()
    for (const entry of scopes) {
      const { details, request, revisionMaterial } = entry.selected.value
      const joinOnly =
        entry.selected.joinOnly || entry.selected.mail.sent || details.organizer?.email === email
      if (!entry.reason && request && revisionMaterial && details.organizer) {
        // Revision selection has already limited history to this scope and
        // sequence. Calendar must distinguish the selected REQUEST from each
        // strictly earlier REQUEST it might still be showing.
        const predecessors = entry.history.flatMap(({ value }) =>
          value.method === 'REQUEST' &&
          value.revisionMaterial &&
          value.details.identity.dtstamp !== null &&
          details.identity.dtstamp !== null &&
          value.details.identity.dtstamp < details.identity.dtstamp
            ? [{ details: value.details, material: value.revisionMaterial }]
            : [],
        )
        const copy = await findInvitationCalendarCopy(
          api,
          { details, request, material: revisionMaterial, joinOnly, predecessors },
          email,
        )
        copies.set(scopeKey(details.identity), copy)
      }
    }
    const lineages = new Map<string, LineageMatch>()
    for (const entry of scopes) {
      const { organizer, identity } = entry.selected.value.details
      lineages.set(scopeKey(identity), ({ revision, delivery }) => {
        if (!onLineage(entry, revision, email)) return null
        if (delivery.channel === 'calendar')
          return calendarTargetIsMailbox(delivery.target, email) ? 'linked' : null
        if (delivery.organizer !== organizer?.email || delivery.mailbox !== email) return null
        // A contradictory visible owner invalidates parent proof, not the
        // fact that we already dispatched a response on this lineage.
        const parentOwner = owners.get(delivery.parent)
        return (entry.provenParents.has(delivery.parent) && parentOwner !== null) ||
          parentOwner === undefined
          ? 'linked'
          : 'disputed'
      })
    }
    const entries = new Map(scopes.map((entry) => [scopeKey(identityOf(entry.selected)), entry]))
    type Scope = (typeof scopes)[number]
    function evidenceParents(entry: Scope, organizer: string, anchors: ParentAnchor[]) {
      const key = scopeKey(identityOf(entry.selected))
      const verified = new Set(
        [...entry.provenParents].filter((parent) => owners.get(parent) !== null),
      )
      const related = new Set(entry.possibleParents)
      for (const anchor of anchors) {
        if (
          anchor.accountSub === accountSub &&
          anchor.mailbox === email &&
          anchor.organizer === organizer &&
          onLineage(entry, anchor.revision, email)
        ) {
          related.add(anchor.parent)
          if (!owners.has(anchor.parent) && anchor.reply && !owners.contradicts(anchor.reply))
            verified.add(anchor.parent)
        }
      }
      // A write's known scope and envelope can relate an unreadable REPLY
      // even when its parent cannot authorize positive Sent evidence.
      for (const attempt of relevant) {
        if (attempt.state === 'prepared' || scopeKey(attempt.revision) !== key) continue
        if (attempt.delivery.channel === 'gmail' && lineages.get(key)?.(attempt))
          related.add(attempt.delivery.parent)
      }
      return { verified, related }
    }
    const { pending, confirmations, parentAnchors, contested, unverifiedReceipts } =
      await reconcile(
        target,
        relevant,
        thread,
        scan,
        copies,
        lineages,
        journal.parentAnchors,
        async (attempt, mail) => {
          const key = scopeKey(attempt.revision)
          const entry = entries.get(key)
          const lineage = lineages.get(key)?.(attempt)
          if (!entry || !lineage || attempt.delivery.channel !== 'gmail') return false
          const { organizer, parent } = attempt.delivery
          const { verified, related } = evidenceParents(entry, organizer, journal.parentAnchors)
          if (lineage === 'linked') verified.add(parent)
          related.add(parent)
          const sent = await sentResponse(
            [...messages.filter(({ messageId }) => messageId !== mail.messageId), mail],
            owners,
            verified,
            related,
            identityOf(entry.selected),
            { organizer, mailbox: email },
            mail.timestamp,
          )
          return sent.unresolved
        },
      )
    const cards: Resolved[] = []
    const displayedPending = new Set<string>()
    for (const entry of scopes) {
      const { selected } = entry
      const { details, request } = selected.value
      const identity = details.identity
      const organizer = details.organizer?.email
      const joinOnly = selected.joinOnly || selected.mail.sent || organizer === email
      const calendar = copies.get(scopeKey(identity))
      // Join-only mail does not get any link without a verified
      // owned/self Calendar copy. An incoming REQUEST never falls into this path.
      if (joinOnly && calendar?.kind !== 'verified') continue
      const invitation: MailInvitation = {
        ...details,
        cancelled: details.cancelled || entry.cancelled === true,
        bindingRevision: target.bindingRevision,
        kind: joinOnly ? 'meeting' : 'invitation',
        scope:
          identity.recurrenceId !== null ? 'occurrence' : details.recurring ? 'series' : 'single',
        responseStatus: null,
        recordedResponseStatus: calendar?.kind === 'verified' ? calendar.responseStatus : null,
        sentResponseStatus: null,
        canRespond: false,
        responsePending: false,
      }
      let reply: Reply | null = null
      let recorded: InviteAnswer | null = null
      let priorSent: SentEvidence | null = null
      let responseUnverified = false
      let gmailUnverified = false
      let currentSent: SentEvidence | null = null
      if (entry.reason) invitation.unavailableReason = entry.reason
      if (calendar?.kind === 'blocked') {
        invitation.unavailableReason = calendar.reason
        if (calendar.cancelled) invitation.cancelled = true
      }
      if (calendar?.kind === 'verified') {
        invitation.title = calendar.title?.trim() || invitation.title
        invitation.start = calendar.start ?? invitation.start
        invitation.end = calendar.end ?? invitation.end
        if (calendar.start) invitation.allDay = calendar.allDay
        invitation.location = calendar.location ?? invitation.location
        if (calendar.conferenceUrl) {
          invitation.conferenceUrl = calendar.conferenceUrl
          invitation.conferenceLinkSource = calendar.conferenceLinkSource
        }
        if (calendar.htmlLink) {
          invitation.htmlLink = calendar.htmlLink
          invitation.htmlLinkSource = 'calendar'
        }
        invitation.responseStatus = calendar.responseStatus
        invitation.cancelled = calendar.cancelled
        invitation.unavailableReason = calendar.unavailableReason
        if (calendar.reply)
          reply = {
            channel: 'calendar',
            target: calendar.target,
            proof: calendar.proof,
            key: JSON.stringify([calendar.target, calendar.etag, calendar.proof]),
            send: calendar.reply,
          }
      }
      if (
        !joinOnly &&
        !invitation.cancelled &&
        request &&
        organizer &&
        (calendar?.kind === 'absent' || calendar?.kind === 'verified')
      ) {
        const attendee = Object.hasOwn(request.attendeeStates, email)
          ? request.attendeeStates[email]
          : undefined
        const confirmation = confirmations.get(scopeKey(identity))
        const delivery = confirmation?.attempt.delivery
        const calendarObserved = invitation.recordedResponseStatus
        const sameTarget =
          calendar.kind === 'verified' &&
          delivery?.channel === 'calendar' &&
          delivery.target === calendar.target &&
          delivery.proof !== undefined &&
          calendar.matchesProof(delivery.proof)
        const { verified: responseParents, related: relatedParents } = evidenceParents(
          entry,
          organizer,
          parentAnchors,
        )
        const disputedParent =
          confirmation?.disputedParent === true ||
          (delivery?.channel === 'gmail' &&
            owners.has(delivery.parent) &&
            !responseParents.has(delivery.parent))
        const observedReceipt = confirmation?.mail
        const receipt =
          !disputedParent && observedReceipt && owners.owns(observedReceipt)
            ? observedReceipt
            : null
        // A verified latest receipt from an older journal can also prove its parent.
        if (delivery?.channel === 'gmail' && receipt) {
          responseParents.add(delivery.parent)
          relatedParents.add(delivery.parent)
        }
        const sentMail = receipt
          ? [...messages.filter(({ messageId }) => messageId !== receipt.messageId), receipt]
          : disputedParent && delivery?.channel === 'gmail'
            ? messages.filter(
                (mail) => mail.rfcId !== delivery.rfcId && mail.messageId !== delivery.receipt?.id,
              )
            : messages
        const sent = await sentResponse(
          sentMail,
          owners,
          responseParents,
          relatedParents,
          identity,
          {
            organizer,
            mailbox: email,
          },
        )
        priorSent = sent.evidence
        // Only evidence that preceded this verified Calendar dispatch can be
        // superseded by it. Fresh Sent evidence is never hidden by the journal.
        const earlier = delivery?.channel === 'calendar' ? delivery.priorSent : null
        const superseded =
          earlier &&
          sent.evidence &&
          (sent.evidence.timestamp < earlier.timestamp ||
            (sent.evidence.timestamp === earlier.timestamp &&
              sent.evidence.answer === earlier.answer &&
              sent.evidence.messageIds.every((id) => earlier.messageIds.includes(id))))
        const sentStatus =
          superseded || sent.orderUnverified ? null : (sent.evidence?.answer ?? null)
        const calendarStatus = isAnswer(calendarObserved) ? calendarObserved : null
        const historical = confirmation?.attempt.answer ?? null
        const historicalCalendar =
          delivery?.channel === 'calendar' && !sameTarget ? historical : null
        if (calendar.kind === 'absent') {
          const headers = selected.mail.replyHeaders
          if (!attendee) {
            invitation.unavailableReason =
              'This invitation does not list the connected mailbox as an attendee'
          } else if (request.replyUnavailableReason) {
            invitation.unavailableReason = request.replyUnavailableReason
          } else if (!headers || !responseParents.has(headers.inReplyTo)) {
            invitation.unavailableReason = 'This invitation has no valid Gmail reply headers'
          } else {
            const target = JSON.stringify([organizer, email, headers])
            reply = {
              channel: 'gmail',
              organizer,
              headers,
              body: request.reply,
              key: target,
              target,
            }
          }
        }
        // A receipt that lost ownership still records a dispatch and may
        // establish its order. It cannot supply the current answer or a parent.
        const receiptTimestamp =
          delivery?.channel === 'gmail'
            ? receipt?.timestamp ||
              delivery.confirmedSentTimestamp ||
              observedReceipt?.timestamp ||
              contested.get(confirmation!.attempt.id) ||
              0
            : 0
        const newerSent =
          sent.evidence &&
          receiptTimestamp > 0 &&
          sent.evidence.timestamp > receiptTimestamp &&
          sent.evidence.timestamp >
            (delivery?.channel === 'gmail' ? (delivery.priorSentTimestamp ?? 0) : 0)
        const receiptUnsettled =
          delivery?.channel === 'gmail' &&
          (!receipt || (sentStatus !== null && sentStatus !== historical)) &&
          !(newerSent && sentStatus !== null)
        invitation.sentResponseStatus = receiptUnsettled ? null : sentStatus
        recorded = calendar.kind === 'verified' ? calendarStatus : invitation.sentResponseStatus
        gmailUnverified =
          sent.orderUnverified || (!superseded && sent.answers.size > 1) || receiptUnsettled
        if (!gmailUnverified && sentStatus !== null) currentSent = sent.evidence
        const otherAnswer = sentStatus ?? historicalCalendar
        const answersDiffer =
          calendarStatus !== null && otherAnswer !== null && calendarStatus !== otherAnswer
        // Two verified answers can differ without making the current write target ambiguous.
        // Only a writable Calendar copy and actual Sent evidence allow resolving that difference.
        const canResolveDifference = reply?.channel === 'calendar' && sentStatus !== null
        responseUnverified = gmailUnverified || (answersDiffer && !canResolveDifference)
        if (responseUnverified) {
          if (gmailUnverified) invitation.unavailableReason = sentVerificationReason
          else
            invitation.unavailableReason ??= `Calendar records ${calendarStatus}, but the other confirmed response is ${otherAnswer}.`
          invitation.responseStatus = null
        } else {
          invitation.responseStatus =
            calendarStatus ??
            sentStatus ??
            // A confirmed Calendar write is history, not a substitute for
            // the current state of that same verified copy (including a reset).
            (sameTarget
              ? calendarObserved
              : (historical ??
                (attendee?.responseStatus === 'delegated' && calendarObserved === 'needsAction'
                  ? attendee.responseStatus
                  : calendarObserved) ??
                attendee?.responseStatus ??
                null))
        }
        if (reply)
          reply.key = JSON.stringify([
            reply.key,
            confirmation?.attempt.id,
            sent.evidence,
            calendarObserved,
          ])
      }
      const scopePending = pending.filter((attempt) => {
        if (!sameGroup(attempt.revision, identity) || supersedes(entry, attempt.revision, email))
          return false
        const floor = contested.get(attempt.id)
        // Keep the reservation durable. Only an independently proven answer
        // after the contested dispatch can settle the current read.
        const settled =
          currentSent &&
          attempt.delivery.channel === 'gmail' &&
          lineages.get(scopeKey(identity))?.(attempt) &&
          floor !== undefined &&
          currentSent.timestamp > Math.max(floor, attempt.delivery.priorSentTimestamp ?? 0)
        if (settled) displayedPending.add(attempt.id)
        return !settled
      })
      if (scopePending.length) {
        for (const attempt of scopePending) displayedPending.add(attempt.id)
        invitation.responsePending = true
        invitation.responseStatus = null
        const sentReceiptUnverified = scopePending.some(
          ({ id, delivery }) =>
            delivery.channel === 'gmail' &&
            (unverifiedReceipts.has(id) || owners.get(delivery.rfcId) === null),
        )
        if (sentReceiptUnverified) invitation.sentResponseStatus = null
        if (!invitation.cancelled) {
          invitation.unavailableReason =
            gmailUnverified || sentReceiptUnverified
              ? sentVerificationReason
              : scopePending.some((attempt) => attempt.state === 'accepted')
                ? 'Google accepted your response; waiting for it to appear'
                : 'The response could not be confirmed. Check its status before sending again.'
        }
      }
      invitation.canRespond = reply !== null && !responseUnverified && !invitation.responsePending
      cards.push({ invitation, reply, response: entry.response, recorded, priorSent })
    }
    target.assertBinding()
    return {
      cards,
      recoveryReason: pending.some(({ id }) => !displayedPending.has(id))
        ? 'An earlier response could not be confirmed. Checking its status will not send another response.'
        : missingThread
          ? 'Gmail could not find this invitation thread'
          : null,
    }
  }

  return {
    async read(target: Target) {
      try {
        const result = await read(target, createCalendarScan())
        return {
          invitations: result.cards.map(({ invitation }) => invitation),
          recoveryReason: result.recoveryReason,
        }
      } catch (error) {
        target.assertBinding()
        if (error instanceof CalendarScanError)
          return { invitations: [], recoveryReason: error.message }
        throw error
      }
    },
    async respond(
      target: Target,
      identity: MailInvitationIdentity,
      answer: InviteAnswer,
    ): Promise<RespondResult> {
      const { accountSub, threadId, email } = target
      const key = JSON.stringify([accountSub, scopeKey(identity)])
      const scan = createCalendarScan()
      const selected = async (excludeAttempt?: string) =>
        (await read(target, scan, identity, excludeAttempt)).cards[0]
      if (busy.has(key))
        throw new CapabilityError('CONFLICT', 'An invitation response is already in progress')
      busy.add(key)
      try {
        const current = await selected()
        target.assertBinding()
        if (!current || !sameInvitation(current.invitation.identity, identity)) throw conflict()
        const { invitation, reply } = current
        const unchanged = (card: Resolved): RespondResult | null => {
          if (
            !card.reply ||
            (card.recorded !== answer &&
              !(
                card.invitation.canRespond &&
                card.recorded === null &&
                card.invitation.responseStatus === answer
              ))
          )
            return null
          return {
            outcome: 'unchanged',
            channel: card.reply.channel,
            answer,
            invitation: card.invitation,
            refreshPending:
              card.invitation.responsePending || card.invitation.responseStatus !== answer,
          }
        }
        const recorded = unchanged(current)
        if (recorded) return recorded
        if (!reply || !invitation.canRespond)
          throw new CapabilityError(
            'FORBIDDEN',
            invitation.unavailableReason ?? 'This invitation cannot be answered',
          )
        const { channel } = reply

        if (!invitation.identity.materialKey) throw conflict()
        const id = randomUUID()
        const { uid, recurrenceId, sequence, dtstamp, materialKey } = invitation.identity
        const rfcId = `<${id}@holi.invalid>`
        const attempt: InvitationAttempt = {
          id,
          accountSub,
          threadId,
          revision: {
            uid,
            recurrenceId,
            sequence,
            dtstamp,
            materialKey,
            mailboxResponse: current.response,
          },
          answer,
          state: 'prepared',
          delivery:
            channel === 'calendar'
              ? { channel, target: reply.target, proof: reply.proof, priorSent: current.priorSent }
              : {
                  channel,
                  rfcId,
                  parent: reply.headers.inReplyTo,
                  organizer: reply.organizer,
                  mailbox: email,
                  priorSentTimestamp: current.priorSent?.timestamp,
                  receipt: null,
                },
        }
        dispatching.add(id)
        try {
          await store.addAttempt(attempt)
          const validate = async () => {
            // Runs after the write token has been obtained. Recheck the channel,
            // exact Calendar target/ETag or proven absence, and the prior answer.
            const newest = await selected(id)
            if (
              !newest?.reply ||
              !sameInvitation(newest.invitation.identity, identity) ||
              newest.response?.responseStatus !== current.response?.responseStatus ||
              newest.response?.rsvp !== current.response?.rsvp
            )
              throw conflict()
            const recorded = unchanged(newest)
            if (recorded && (newest.recorded === answer || sameWriteTarget(newest.reply, reply)))
              throw new AlreadyRecorded(recorded)
            if (
              !newest.invitation.canRespond ||
              !sameWriteTarget(newest.reply, reply) ||
              newest.reply.key !== reply.key ||
              newest.invitation.responseStatus !== invitation.responseStatus
            )
              throw conflict()
          }
          const reserveDispatch = async () => {
            await store.update((journal) => {
              if (!journal.attempts.some((entry) => entry.id === id && entry.state === 'prepared'))
                throw conflict()
              return {
                ...journal,
                attempts: journal.attempts.map((entry) =>
                  entry.id === id ? { ...entry, state: 'unresolved' } : entry,
                ),
              }
            })
          }
          const gate: GoogleDispatchGate = { validate, reserveDispatch }
          try {
            let receipt = null
            if (channel === 'calendar') await reply.send(answer, gate)
            else
              receipt = await sendCalendarReply(
                target.api,
                threadId,
                reply.headers,
                rfcId,
                email,
                reply.organizer,
                reply.body(email, answer),
                gate,
              )
            // A journal/readback failure after acceptance is never a failed send.
            await changeAttempt(id, (entry) => ({
              ...entry,
              state: 'accepted',
              delivery:
                entry.delivery.channel === 'gmail'
                  ? { ...entry.delivery, receipt }
                  : entry.delivery,
            })).catch(() => null)
          } catch (error) {
            if (error instanceof GoogleWriteUncertainError) {
              return {
                outcome: 'uncertain',
                channel,
                answer,
                invitation: null,
                refreshPending: true,
              }
            }
            // Preflight refused before dispatch, or Google definitively refused.
            await changeAttempt(id, () => null)
            if (error instanceof AlreadyRecorded) return error.result
            if (
              error instanceof GoogleApiError &&
              (error.status === 412 || (channel === 'calendar' && error.status === 404))
            )
              throw conflict()
            throw error
          }
        } finally {
          dispatching.delete(id)
        }
        const refreshed = await selected().catch(() => null)
        const confirmed =
          refreshed && sameInvitation(refreshed.invitation.identity, identity)
            ? refreshed.invitation
            : null
        return {
          outcome: 'sent',
          channel,
          answer,
          invitation: confirmed,
          refreshPending:
            confirmed === null ||
            confirmed.responsePending ||
            confirmed.responseStatus !== answer ||
            // A new conflicting Sent answer can surface during Calendar readback.
            // Re-read before offering another response; never replay this one.
            (channel === 'calendar' &&
              confirmed.sentResponseStatus !== null &&
              confirmed.sentResponseStatus !== answer),
        }
      } catch (error) {
        if (error instanceof CalendarScanError)
          throw new CapabilityError('FORBIDDEN', error.message)
        throw error
      } finally {
        busy.delete(key)
      }
    },
  }
}
