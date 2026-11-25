import { createHash, randomUUID } from 'node:crypto'
import { CapabilityError } from '../../../main/plugin-api'
import {
  GoogleApiError,
  GoogleWriteUncertainError,
  type GoogleApi,
  type GoogleDispatchGate,
} from './api'
import type { InviteAnswer } from './calendar'
import {
  calendarLocatorMayMatchScope,
  calendarTargetIsMailbox,
  calendarTargetMailbox,
  findInvitationCalendarCopy,
  createInvitationCalendarResourceLookup,
  type InvitationLinks,
} from './mail-invitation-calendar'
import { CalendarScanError } from './gmail-mime'
import {
  CalendarLeafError,
  createCalendarScan,
  createMessageIdOwnership,
  fetchThreadCalendarPayloads,
  createSentCalendarLookup,
  sendCalendarReply,
  type CalendarReplyReceipt,
} from './gmail-invitation-transport'
import { parseCalendarMail } from './invite'
import { projectMailInvitation, type InvitationCardSource } from './mail-invitation-projection'
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
import {
  knownCalendarLocators,
  type CalendarLocator,
  type createMailInvitationStore,
  type InvitationAttempt,
  type ParentAnchor,
  type SentEvidence,
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
type MailInvitation = ReturnType<typeof projectMailInvitation>
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
type CalendarResources = ReturnType<typeof createInvitationCalendarResourceLookup>
type ResponseDecision = {
  cancelled: boolean
  unavailableReason: string | null
  status: NonNullable<Revision['mailboxResponse']>['responseStatus'] | null
  sentStatus: InviteAnswer | null
  targetKey: string | null
  mayRespond: boolean
  pending: boolean
}
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
  source: InvitationCardSource
  decision: ResponseDecision
  reply: Reply | null
  noopChannel: Channel | null
  response: Revision['mailboxResponse']
  recorded: InviteAnswer | null
  priorSent: SentEvidence | null
  absentTargets: Set<string>
  upcomingLinks: (() => Promise<InvitationLinks | null>) | null
}
type ReadResult = { cards: Resolved[]; recoveryReason: string | null }
type CalendarCopy = Awaited<ReturnType<typeof findInvitationCalendarCopy>>

type Confirmation = { attempt: InvitationAttempt; mail: Mail | null; disputedParent: boolean }
type LineageMatch = (attempt: InvitationAttempt) => 'linked' | 'disputed' | null

type SentAddress = { organizer: string; mailbox: string }
// Journal updates deserialize anchors again. Bind proof to the recorded
// context, not to the object instance or to the RFC ID alone.
const anchorProofKey = ({
  accountSub,
  revision,
  parent,
  organizer,
  mailbox,
  reply,
}: ParentAnchor) => JSON.stringify([accountSub, revision, parent, organizer, mailbox, reply])
const sentVerificationReason = 'Gmail could not verify the latest sent response'

function readPossibleReply(part: Mail['parts'][number]): Promise<string | null> {
  return part.read().catch((error) => {
    if (error instanceof CalendarLeafError) return null
    throw error
  })
}

type Alternative = {
  alternatives: Mail['parts'][number]['alternatives']
  signature: string | null
}

function knownAlternativeGroups(parts: Alternative[]) {
  const unknownGroups = new Set(
    parts.flatMap(({ alternatives, signature }) =>
      signature === null ? alternatives.map(({ group }) => group) : [],
    ),
  )
  return ({ alternatives }: Alternative) =>
    !alternatives.some(({ group }) => unknownGroups.has(group))
}

function assertKnownAlternatives(parts: Alternative[]): void {
  assertEquivalentAlternatives(
    parts.flatMap(({ alternatives, signature }) =>
      signature === null ? [] : [{ alternatives, signature }],
    ),
  )
}

async function latestByScope({ messages, owners }: Thread, mailbox: string) {
  const candidates: Candidate[] = []
  const disputedSent = new Set<Mail>()
  for (const mail of messages) {
    if (mail.sent && mail.from !== mailbox) continue
    const renditions: (Alternative & { candidate: Candidate | null })[] = []
    for (const part of mail.parts) {
      if (part.method === null && !mail.sent)
        throw new CalendarScanError('Gmail could not verify the calendar MIME declaration')
      if (mail.sent && part.method === 'REPLY' && !part.alternatives.length) continue
      // Only possible replies may defer a leaf-local failure. Concrete
      // revision declarations and shared scan limits still fail closed.
      const possibleReply = mail.sent && (part.method === undefined || part.method === 'REPLY')
      const source =
        part.method === null ? null : await (possibleReply ? readPossibleReply(part) : part.read())
      const parsed =
        source === null ? null : parseCalendarMail(mail.messageId, source, part.method ?? undefined)
      const candidate = parsed && (!mail.sent || parsed.value.method) ? { ...parsed, mail } : null
      const unknown =
        mail.sent &&
        (part.method === null || possibleReply) &&
        !candidate?.value.details.identity.materialKey
      renditions.push({
        alternatives: part.alternatives,
        candidate,
        signature: unknown
          ? null
          : candidate
            ? representationOf(candidate, mailbox)
            : `unrecognized:${source}`,
      })
    }
    const verified = knownAlternativeGroups(renditions)
    for (const rendition of renditions) {
      if (!rendition.candidate) continue
      if (verified(rendition)) candidates.push(rendition.candidate)
      // A recognizable sibling cannot authenticate a disputed alternative.
      // Keep the envelope for parent- and date-scoped Sent reconciliation.
      else disputedSent.add(mail)
    }
    if (!mail.sent || renditions.some(({ candidate }) => candidate))
      assertKnownAlternatives(renditions.filter(verified))
  }
  return { ...selectInvitationRevisions(candidates, mailbox, owners), disputedSent }
}

async function sentAnswer(
  mail: Mail,
  revision: Revision,
  { mailbox, organizer }: SentAddress,
  disputedSent: Set<Mail>,
  requireOrganizerOnly = false,
) {
  const addresses = mail.sentAddresses
  if (
    !mail.sent ||
    !addresses ||
    addresses.from?.length !== 1 ||
    addresses.from[0] !== mailbox ||
    addresses.to?.length !== 1 ||
    addresses.to[0] !== organizer
  )
    return { answers: [], unresolved: false }
  // Holi sends only to the organizer. Extra or unknown recipients in the
  // full snapshot cannot corroborate Holi's exact dispatch.
  if (requireOrganizerOnly && (addresses.cc?.length !== 0 || addresses.bcc?.length !== 0))
    return { answers: [], unresolved: true }
  const answers = new Set<InviteAnswer>()
  const representations = []
  let unrelated = false
  let unresolved = disputedSent.has(mail)
  for (const part of mail.parts) {
    // The caller established a known parent separately. A malformed calendar
    // body cannot corroborate that relation, but cannot disprove it either.
    const method = part.method
    const source =
      method === null
        ? null
        : await (method === undefined || method === 'REPLY' ? readPossibleReply(part) : part.read())
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

/** Receipts and compacted anchors must prove the same envelope and iTIP scope. */
async function assessReply(
  mail: Mail,
  revision: Revision,
  context: SentAddress & { parent: string },
  disputedSent: Set<Mail>,
  answer?: InviteAnswer,
): Promise<'match' | 'related' | 'unresolved' | null> {
  if (mail.parent !== context.parent) return null
  const { answers, unresolved } = await sentAnswer(mail, revision, context, disputedSent, true)
  if (unresolved) return 'unresolved'
  if (answers.length === 1 && (answer === undefined || answers[0] === answer)) return 'match'
  return answers.length ? 'related' : null
}

async function sentResponse(
  messages: Mail[],
  ownsSent: ReturnType<typeof createSentCalendarLookup>['ownsSent'],
  parents: Set<string>,
  relatedParents: Set<string>,
  revision: Revision,
  address: SentAddress,
  disputedSent: Set<Mail>,
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
    const matched = await sentAnswer(message, revision, address, disputedSent)
    // A matching REPLY to a possible-only parent can contest the current
    // answer, but neither its contents nor its envelope prove that parent.
    const unverified = matched.unresolved || (matched.answers.length > 0 && !parents.has(parent))
    if (unverified && (protectReceiptSince === undefined || couldObscureReceipt)) unresolved = true
    if (older || (!unverified && !matched.answers.length)) continue
    const disputed = unverified || !ownsSent(message)
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

async function exactCalendarAnswer(
  resources: CalendarResources,
  { target, proof }: Extract<InvitationAttempt['delivery'], { channel: 'calendar' }>,
  answer: InviteAnswer,
): Promise<boolean> {
  if (!proof) return false
  const resource = await resources(target)
  return resource.kind === 'present' && resource.confirms(proof, answer)
}

function isAnswer(status: MailInvitation['responseStatus']): status is InviteAnswer {
  return status === 'accepted' || status === 'tentative' || status === 'declined'
}

function sameWriteTarget(a: Reply, b: Reply): boolean {
  if (a.channel === 'calendar' && b.channel === 'calendar')
    return a.target === b.target && a.proof === b.proof
  return a.channel === 'gmail' && b.channel === 'gmail' && a.target === b.target
}

function responseTargetKey(channel: Channel, target: string): string {
  return createHash('sha256')
    .update(JSON.stringify([channel, target]))
    .digest('hex')
}

function relevantCalendarTargets(
  locators: CalendarLocator[],
  target: Target,
  details: Invitation['details'],
): Set<string> {
  const { uid } = details.identity
  return new Set(
    locators.flatMap((copy) =>
      copy.accountSub === target.accountSub &&
      copy.uid === uid &&
      (copy.organizer === undefined || copy.organizer === details.organizer?.email) &&
      calendarLocatorMayMatchScope(copy, details.identity) &&
      (calendarTargetMailbox(copy.target) ?? target.email) === target.email
        ? [copy.target]
        : [],
    ),
  )
}

/** Resolve navigation only on the way out, never during write preflight. */
async function displayCard({ source, decision, upcomingLinks }: Resolved): Promise<MailInvitation> {
  return projectMailInvitation(
    { ...source, response: { ...decision, canRespond: decision.mayRespond } },
    await upcomingLinks?.(),
  )
}

// A no-op found by final preflight must leave the gate before reservation.
// It is not a provider refusal or an uncertain dispatch.
class AlreadyRecorded extends Error {
  constructor(
    readonly result: Omit<RespondResult, 'invitation'>,
    readonly card: Resolved,
  ) {
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

  // Only failed journal writes survive here. The journal reserves space for
  // every such dispatch, and a dispatch without a durable outcome cannot be compacted.
  const gmailOutcomes = new Map<
    string,
    { state: 'unresolved' | 'accepted'; receipt: CalendarReplyReceipt }
  >()
  const withGmailOutcome = (attempt: InvitationAttempt): InvitationAttempt => {
    const outcome = gmailOutcomes.get(attempt.id)
    const { delivery } = attempt
    return outcome &&
      attempt.state === 'unresolved' &&
      delivery.channel === 'gmail' &&
      delivery.receipt === null
      ? { ...attempt, state: outcome.state, delivery: { ...delivery, receipt: outcome.receipt } }
      : attempt
  }
  const flushGmailOutcome = async (id: string) => {
    await changeAttempt(id, withGmailOutcome).then(
      () => gmailOutcomes.delete(id),
      () => undefined,
    )
  }

  async function reconcile(
    target: Target,
    attempts: InvitationAttempt[],
    owners: Thread['owners'],
    receipts: ReturnType<typeof createSentCalendarLookup>,
    copies: Map<string, CalendarCopy>,
    resources: CalendarResources,
    lineages: Map<string, LineageMatch>,
    parentAnchors: ParentAnchor[],
    verifiedAnchors: Map<string, Mail>,
    disputedSent: Set<Mail>,
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
            : await exactCalendarAnswer(resources, delivery, answer)
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
        // A bare reservation (including legacy null receipts) cannot say
        // whether no ID was received or a known ID was lost before persistence.
        if (delivery.receipt === null) {
          unverifiedReceipts.add(id)
          pending.push(attempt)
          continue
        }
        if (gmailOutcomes.has(id)) {
          target.assertBinding()
          await flushGmailOutcome(id)
        }
        const found = await receipts.findReply(delivery.rfcId, delivery.receipt, (candidate) =>
          assessReply(candidate, revision, delivery, disputedSent, answer),
        )
        mail = found.mail
        if (found.unresolvedReply) unverifiedReceipts.add(id)
        if (found.contestedTimestamp) contested.set(id, found.contestedTimestamp)
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
      if (mail && (!receipts.ownsSent(mail) || (await receiptObscured(attempt, mail)))) {
        if (confirmations.get(key)?.attempt === attempt) confirmations.delete(key)
        pending.push(prior)
        unverifiedReceipts.add(prior.id)
        if (mail.timestamp && !receipts.ownsSent(mail)) contested.set(prior.id, mail.timestamp)
        continue
      }
      target.assertBinding()
      const matchLineage = lineages.get(key)
      const provesAnchor = (entry: InvitationAttempt) =>
        entry.id === attempt.id &&
        matchLineage?.(entry) === 'linked' &&
        mail !== null &&
        receipts.hasVerifiedFullReply(mail)
      // Compaction may retain an existing anchor without proving it again.
      // This does not grant parent evidence; a known contradiction keeps the dispatch.
      const hasStoredAnchor = (entry: InvitationAttempt) => {
        const { delivery } = entry
        return (
          delivery.channel === 'gmail' &&
          delivery.receipt?.id != null &&
          !owners.contradicts({ rfcId: delivery.rfcId, messageId: delivery.receipt.id }) &&
          parentAnchors.some(
            (anchor) =>
              anchor.accountSub === entry.accountSub &&
              anchor.mailbox === delivery.mailbox &&
              anchor.organizer === delivery.organizer &&
              anchor.parent === delivery.parent &&
              sameRevision(anchor.revision, entry.revision) &&
              anchor.reply?.rfcId === delivery.rfcId &&
              anchor.reply.messageId === delivery.receipt?.id &&
              (!receipts.wasRead(anchor.reply.messageId) ||
                verifiedAnchors.has(anchorProofKey(anchor))),
          )
        )
      }
      const journal = await store.confirmAttempt(
        attempt,
        (entry) =>
          matchLineage?.(attempt) === 'linked' &&
          entry.accountSub === target.accountSub &&
          matchLineage(entry) === 'linked' &&
          (entry.delivery.channel !== 'gmail' || hasStoredAnchor(entry) || provesAnchor(entry)),
        provesAnchor,
      )
      gmailOutcomes.delete(attempt.id)
      parentAnchors = journal.parentAnchors
    }
    return { pending, confirmations, parentAnchors, contested, unverifiedReceipts }
  }

  async function collectCalendarCopies(
    target: Target,
    scopes: Awaited<ReturnType<typeof latestByScope>>['scopes'],
  ) {
    const { api, accountSub, email } = target
    const copies = new Map<string, CalendarCopy>()
    target.assertBinding()
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
          (locator) =>
            store.rememberCalendarLocator({ accountSub, ...locator }, target.assertBinding),
        )
        copies.set(scopeKey(details.identity), copy)
      }
    }
    const journal = await store.read()
    target.assertBinding()
    return { copies, journal }
  }

  const read = async (
    target: Target,
    scan: Scan,
    selection?: Revision,
    excludeAttempt?: string,
  ): Promise<ReadResult> => {
    const { api, threadId, accountSub, email } = target
    target.assertBinding()
    let missingThread = false
    const thread = await fetchThreadCalendarPayloads(api, threadId, scan).catch((error): Thread => {
      if (!(error instanceof GoogleApiError) || error.status !== 404) throw error
      missingThread = true
      return { messages: [], owners: createMessageIdOwnership() }
    })
    const { messages, owners } = thread
    const {
      scopes: incoming,
      suppressesSeriesSlot,
      disputedSent,
    } = await latestByScope(thread, email)
    const scopes = selection
      ? incoming.filter((entry) => sameGroup(identityOf(entry.selected), selection))
      : incoming
    const { copies, journal: durable } = await collectCalendarCopies(target, scopes)
    // Use the same locator for dispatch exclusion, Sent evidence, and readback,
    // even when a known outcome could not be written to the journal.
    const journal = { ...durable, attempts: durable.attempts.map(withGmailOutcome) }
    const resources = createInvitationCalendarResourceLookup(api, email)
    const known = knownCalendarLocators(journal)
    const relevant = journal.attempts.filter(
      (attempt) =>
        attempt.accountSub === accountSub &&
        attempt.id !== excludeAttempt &&
        (selection
          ? sameGroup(attempt.revision, selection)
          : attempt.threadId === threadId ||
            scopes.some((entry) => sameGroup(identityOf(entry.selected), attempt.revision))),
    )
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
    const dispatchIds = new Set<string>()
    const dispatchRfcIds = new Set<string>()
    const reserveReply = (rfcId: string, messageId: string | null | undefined) => {
      dispatchRfcIds.add(rfcId)
      if (messageId) dispatchIds.add(messageId)
    }
    for (const { accountSub: account, delivery } of journal.attempts) {
      if (account === accountSub && delivery.channel === 'gmail' && delivery.mailbox === email)
        reserveReply(delivery.rfcId, delivery.receipt?.id)
    }
    for (const { accountSub: account, mailbox, reply } of journal.parentAnchors) {
      if (account === accountSub && mailbox === email && reply)
        reserveReply(reply.rfcId, reply.messageId)
    }
    const receipts = createSentCalendarLookup(
      api,
      scan,
      owners,
      messages,
      (mail) =>
        dispatchIds.has(mail.messageId) || [...mail.claims].some((id) => dispatchRfcIds.has(id)),
    )
    const verifiedAnchors = new Map<string, Mail>()
    const verifiedParentContexts = new Set<string>()
    const sentInThread = messages.filter((mail) => mail.sent)
    const sentParents = new Set(sentInThread.flatMap(({ parent }) => (parent ? [parent] : [])))
    const sentIds = new Set(sentInThread.map(({ messageId }) => messageId))
    const latestDeliveries = new Map<string, InvitationAttempt['delivery']>()
    for (const attempt of relevant) {
      const { delivery, revision, state } = attempt
      const scope = scopeKey(revision)
      if (state !== 'prepared' && lineages.get(scope)?.(attempt))
        latestDeliveries.set(scope, delivery)
    }
    // A visible REQUEST can prove its own parent ID, not the full envelope of
    // a historical Holi reply. When the latest dispatch is through Calendar,
    // reverify the in-thread replies it recorded as predecessors before hiding
    // them as superseded. Do not re-read every compacted reply.
    for (const anchor of [...journal.parentAnchors].reverse()) {
      if (!anchor.reply) continue
      const scope = scopeKey(anchor.revision)
      const parentContext = JSON.stringify([scope, anchor.parent])
      const needsParentProof =
        sentParents.has(anchor.parent) &&
        !owners.has(anchor.parent) &&
        !verifiedParentContexts.has(parentContext)
      const latest = latestDeliveries.get(scope)
      const needsPredecessorProof =
        latest?.channel === 'calendar' &&
        sentIds.has(anchor.reply.messageId) &&
        latest.priorSent?.messageIds.includes(anchor.reply.messageId)
      if (!needsParentProof && !needsPredecessorProof) continue
      const entry = entries.get(scope)
      if (
        entry &&
        anchor.accountSub === accountSub &&
        anchor.mailbox === email &&
        anchor.organizer === entry.selected.value.details.organizer?.email &&
        onLineage(entry, anchor.revision, email)
      ) {
        const { rfcId, messageId, threadId, answer } = anchor.reply
        const { mail } = await receipts.findReply(
          rfcId,
          { id: messageId, threadId: threadId ?? null },
          (candidate) => assessReply(candidate, anchor.revision, anchor, disputedSent, answer),
        )
        if (mail) {
          verifiedAnchors.set(anchorProofKey(anchor), mail)
          if (needsParentProof) verifiedParentContexts.add(parentContext)
        }
      }
    }
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
          const observed = verifiedAnchors.get(anchorProofKey(anchor))
          if (!owners.has(anchor.parent) && observed && receipts.hasVerifiedFullReply(observed))
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
        owners,
        receipts,
        copies,
        resources,
        lineages,
        journal.parentAnchors,
        verifiedAnchors,
        disputedSent,
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
            [
              ...receipts.threadEvidence().filter(({ messageId }) => messageId !== mail.messageId),
              mail,
            ],
            receipts.ownsSent,
            verified,
            related,
            identityOf(entry.selected),
            { organizer, mailbox: email },
            disputedSent,
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
      const verifiedCopy = calendar?.kind === 'verified' ? calendar : null
      const decision: Resolved['decision'] = {
        cancelled:
          verifiedCopy?.cancelled ??
          (details.cancelled ||
            entry.cancelledBy !== undefined ||
            (calendar?.kind === 'blocked' && calendar.cancelled === true)),
        unavailableReason: verifiedCopy
          ? verifiedCopy.unavailableReason
          : calendar?.kind === 'blocked'
            ? calendar.reason
            : (entry.reason ?? details.unavailableReason),
        status: verifiedCopy?.responseStatus ?? null,
        sentStatus: null,
        targetKey:
          verifiedCopy && !joinOnly ? responseTargetKey('calendar', verifiedCopy.target) : null,
        mayRespond: false,
        pending: false,
      }
      let reply: Reply | null = verifiedCopy?.reply
        ? {
            channel: 'calendar',
            target: verifiedCopy.target,
            proof: verifiedCopy.proof,
            key: JSON.stringify([verifiedCopy.target, verifiedCopy.etag, verifiedCopy.proof]),
            send: verifiedCopy.reply,
          }
        : null
      const absentTargets = new Set<string>()
      let noopChannel: Channel | null = null
      let recorded: InviteAnswer | null = null
      let priorSent: SentEvidence | null = null
      let responseUnverified = false
      let gmailUnverified = false
      let currentSent: SentEvidence | null = null
      if (
        !joinOnly &&
        !decision.cancelled &&
        request &&
        organizer &&
        (calendar?.kind === 'absent' || calendar?.kind === 'verified')
      ) {
        const attendee = Object.hasOwn(request.attendeeStates, email)
          ? request.attendeeStates[email]
          : undefined
        const confirmation = confirmations.get(scopeKey(identity))
        const delivery = confirmation?.attempt.delivery
        const calendarObserved = verifiedCopy?.responseStatus ?? null
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
          !disputedParent && observedReceipt && receipts.ownsSent(observedReceipt)
            ? observedReceipt
            : null
        // A verified latest receipt from an older journal can also prove its parent.
        if (delivery?.channel === 'gmail' && receipt) {
          responseParents.add(delivery.parent)
          relatedParents.add(delivery.parent)
        }
        const threadEvidence = receipts.threadEvidence()
        const sentMail = receipt
          ? [...threadEvidence.filter(({ messageId }) => messageId !== receipt.messageId), receipt]
          : disputedParent && delivery?.channel === 'gmail'
            ? threadEvidence.filter(
                (mail) => mail.rfcId !== delivery.rfcId && mail.messageId !== delivery.receipt?.id,
              )
            : threadEvidence
        const sent = await sentResponse(
          sentMail,
          receipts.ownsSent,
          responseParents,
          relatedParents,
          identity,
          { organizer, mailbox: email },
          disputedSent,
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
        let absenceContradicted = journal.calendarLocatorOverflow
        let exactConfirmed = false
        if (calendar.kind === 'absent') {
          // A complete list can still disagree with an exact resource read.
          // Any known target for this scope must be gone before Gmail can write.
          for (const locator of relevantCalendarTargets(known, target, details)) {
            if ((await resources(locator)).kind !== 'gone') {
              absenceContradicted = true
              break
            }
            absentTargets.add(locator)
          }
          if (absenceContradicted && delivery?.channel === 'calendar' && historical)
            exactConfirmed = await exactCalendarAnswer(resources, delivery, historical)
          const headers = selected.mail.replyHeaders
          if (absenceContradicted) {
            decision.unavailableReason =
              'Calendar could not verify whether it has a copy of this invitation'
          } else if (!attendee) {
            decision.unavailableReason =
              'This invitation does not list the connected mailbox as an attendee'
          } else if (request.replyUnavailableReason) {
            decision.unavailableReason = request.replyUnavailableReason
          } else if (!headers || !responseParents.has(headers.inReplyTo)) {
            decision.unavailableReason = 'This invitation has no valid Gmail reply headers'
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
        decision.sentStatus = receiptUnsettled ? null : sentStatus
        recorded = calendar.kind === 'verified' ? calendarStatus : decision.sentStatus
        gmailUnverified =
          sent.orderUnverified || (!superseded && sent.answers.size > 1) || receiptUnsettled
        if (!gmailUnverified && sentStatus !== null) currentSent = sent.evidence
        const otherAnswer = sentStatus ?? historicalCalendar
        const answersDiffer =
          calendarStatus !== null && otherAnswer !== null && calendarStatus !== otherAnswer
        // Two verified answers can differ without making the current write target ambiguous.
        // Only a writable Calendar copy and actual Sent evidence allow resolving that difference.
        const canResolveDifference = reply?.channel === 'calendar' && sentStatus !== null
        const calendarUnverified = calendar.kind === 'verified' && calendarObserved === null
        responseUnverified =
          gmailUnverified ||
          calendarUnverified ||
          (answersDiffer && !canResolveDifference) ||
          (absenceContradicted && !exactConfirmed && sentStatus === null)
        if (responseUnverified) {
          if (gmailUnverified) decision.unavailableReason = sentVerificationReason
          else if (answersDiffer)
            decision.unavailableReason ??= `Calendar records ${calendarStatus}, but the other confirmed response is ${otherAnswer}.`
          decision.status = null
        } else {
          decision.status =
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
        // This exact read can establish a read-only no-op for the confirmed
        // answer; it is not the selected collection copy or a writable target.
        if (
          exactConfirmed &&
          delivery?.channel === 'calendar' &&
          !responseUnverified &&
          decision.status === historical
        ) {
          noopChannel = 'calendar'
          decision.targetKey = responseTargetKey('calendar', delivery.target)
        }
        if (reply?.channel === 'gmail')
          decision.targetKey = responseTargetKey('gmail', reply.target)
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
        noopChannel = null
        for (const attempt of scopePending) displayedPending.add(attempt.id)
        decision.pending = true
        decision.status = null
        const sentReceiptUnverified = scopePending.some(
          ({ id, delivery }) =>
            delivery.channel === 'gmail' &&
            (unverifiedReceipts.has(id) || owners.get(delivery.rfcId) === null),
        )
        if (sentReceiptUnverified) decision.sentStatus = null
        if (!decision.cancelled) {
          decision.unavailableReason =
            gmailUnverified || sentReceiptUnverified
              ? sentVerificationReason
              : scopePending.some((attempt) => attempt.state === 'accepted')
                ? 'Google accepted your response; waiting for it to appear'
                : 'The response could not be confirmed. Check its status before sending again.'
        }
      }
      decision.mayRespond = reply !== null && !responseUnverified && !decision.pending
      const loadUpcoming = verifiedCopy?.upcomingLinks
      cards.push({
        source: {
          details:
            calendar?.kind === 'blocked' && calendar.navigationUnverified
              ? {
                  ...details,
                  conferenceUrl: null,
                  conferenceLinkSource: null,
                  htmlLink: null,
                  htmlLinkSource: null,
                }
              : details,
          bindingRevision: target.bindingRevision,
          joinOnly,
          calendar: verifiedCopy,
        },
        decision,
        reply,
        noopChannel,
        response: entry.response,
        recorded,
        priorSent,
        absentTargets,
        upcomingLinks: loadUpcoming
          ? () => loadUpcoming((slot) => suppressesSeriesSlot(selected, slot))
          : null,
      })
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
        const invitations = []
        for (const card of result.cards) {
          invitations.push(await displayCard(card))
          target.assertBinding()
        }
        return { invitations, recoveryReason: result.recoveryReason }
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
      expectedResponseTargetKey: string | null,
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
        if (!current || !sameInvitation(current.source.details.identity, identity)) throw conflict()
        const {
          source: { details },
          decision,
          reply,
        } = current
        const unchanged = (card: Resolved): Omit<RespondResult, 'invitation'> | null => {
          const channel = card.reply?.channel ?? card.noopChannel
          if (
            !channel ||
            (card.recorded !== answer &&
              !(
                (card.decision.mayRespond || card.noopChannel !== null) &&
                card.recorded === null &&
                card.decision.status === answer
              ))
          )
            return null
          return {
            outcome: 'unchanged',
            channel,
            answer,
            refreshPending: card.decision.pending || card.decision.status !== answer,
          }
        }
        const recorded = unchanged(current)
        if ((recorded || decision.mayRespond) && decision.targetKey !== expectedResponseTargetKey)
          throw conflict()
        if (recorded) return { ...recorded, invitation: await displayCard(current) }
        if (!reply || !decision.mayRespond)
          throw new CapabilityError(
            'FORBIDDEN',
            decision.unavailableReason ?? 'This invitation cannot be answered',
          )
        const { channel } = reply

        if (!details.identity.materialKey) throw conflict()
        const id = randomUUID()
        const { uid, recurrenceId, sequence, dtstamp, materialKey } = details.identity
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
              ? {
                  channel,
                  target: reply.target,
                  proof: reply.proof,
                  priorSent: current.priorSent,
                  organizer: details.organizer?.email,
                  series: details.identity.recurrenceId === null && details.recurring,
                }
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
          let absentTargets: Set<string> = new Set()
          const validate = async () => {
            // Runs after the write token has been obtained. Recheck the channel,
            // exact Calendar target/ETag or proven absence, and the prior answer.
            const newest = await selected(id)
            if (
              !newest ||
              !sameInvitation(newest.source.details.identity, identity) ||
              newest.response?.responseStatus !== current.response?.responseStatus ||
              newest.response?.rsvp !== current.response?.rsvp ||
              newest.decision.targetKey !== expectedResponseTargetKey
            )
              throw conflict()
            const recorded = unchanged(newest)
            if (
              recorded &&
              (newest.recorded === answer ||
                newest.noopChannel !== null ||
                (newest.reply && sameWriteTarget(newest.reply, reply)))
            )
              throw new AlreadyRecorded(recorded, newest)
            if (
              !newest.reply ||
              !newest.decision.mayRespond ||
              !sameWriteTarget(newest.reply, reply) ||
              newest.reply.key !== reply.key ||
              newest.decision.status !== decision.status
            )
              throw conflict()
            absentTargets = newest.absentTargets
          }
          const reserveDispatch = async () => {
            await store.update((journal) => {
              if (!journal.attempts.some((entry) => entry.id === id && entry.state === 'prepared'))
                throw conflict()
              // A concurrent reader can discover another copy after preflight.
              if (
                channel === 'gmail' &&
                (journal.calendarLocatorOverflow ||
                  [
                    ...relevantCalendarTargets(knownCalendarLocators(journal), target, details),
                  ].some((locator) => !absentTargets.has(locator)))
              )
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
            if (channel === 'calendar') {
              await reply.send(answer, gate)
              // A journal/readback failure after acceptance is never a failed send.
              await changeAttempt(id, (entry) => ({ ...entry, state: 'accepted' })).catch(
                () => null,
              )
            } else {
              const receipt = await sendCalendarReply(
                target.api,
                threadId,
                reply.headers,
                rfcId,
                email,
                reply.organizer,
                reply.body(email, answer),
                gate,
              )
              gmailOutcomes.set(id, { state: 'accepted', receipt })
              await flushGmailOutcome(id)
            }
          } catch (error) {
            if (error instanceof GoogleWriteUncertainError) {
              if (channel === 'gmail') {
                // This live operation knows it received no provider locator.
                // Retry may use RFC-only evidence once this outcome is known.
                gmailOutcomes.set(id, {
                  state: 'unresolved',
                  receipt: { id: null, threadId: null },
                })
                await flushGmailOutcome(id)
              }
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
            if (error instanceof AlreadyRecorded)
              return { ...error.result, invitation: await displayCard(error.card) }
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
          refreshed && sameInvitation(refreshed.source.details.identity, identity)
            ? await displayCard(refreshed)
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
