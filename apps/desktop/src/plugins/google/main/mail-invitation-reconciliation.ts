import { createHash } from 'node:crypto'
import { GoogleApiError, type GoogleApi } from './api'
import type { InviteAnswer, RsvpStatus } from './calendar'
import {
  calendarTargetIsMailbox,
  findInvitationCalendarCopy,
  relevantCalendarTargets,
  createInvitationCalendarResourceLookup,
  type InvitationTarget,
  type InvitationLinks,
} from './mail-invitation-calendar'
import { CalendarScanError } from './gmail-mime'
import {
  CalendarLeafError,
  createCalendarScan,
  createMessageIdOwnership,
  fetchThreadCalendarPayloads,
  createSentCalendarLookup,
  type CalendarReplyReceipt,
} from './gmail-invitation-transport'
import { parseCalendarMail } from './invite'
import type { InvitationCardSource } from './mail-invitation-projection'
import {
  hasConflictingAlternatives,
  identityOf,
  representationOf,
  onLineage,
  revisionOrder,
  sameGroup,
  sameRevision,
  scopeKey,
  selectInvitationRevisions,
  supersedes,
  type Candidate,
} from './mail-invitation-revisions'
import {
  knownCalendarLocators,
  type createMailInvitationStore,
  type InvitationAttempt,
  type ParentAnchor,
  type SentEvidence,
} from './mail-invitation-store'
import { invitationReplyStatus } from './mail-invitation'

type Thread = Awaited<ReturnType<typeof fetchThreadCalendarPayloads>>
type Mail = Thread['messages'][number]
type Revision = InvitationAttempt['revision']
type Channel = InvitationAttempt['delivery']['channel']
export type InvitationReadTarget = {
  api: Pick<GoogleApi, 'get'>
  threadId: string
  accountSub: string
  bindingRevision: string
  email: string
  assertBinding: () => void
}
type Scan = ReturnType<typeof createCalendarScan>
type CalendarResources = ReturnType<typeof createInvitationCalendarResourceLookup>
type ResponseFacts = {
  cancelled: boolean
  unavailableReason: string | null
  status: NonNullable<Revision['mailboxResponse']>['responseStatus'] | null
  sentStatus: InviteAnswer | null
  recordedCalendarStatus: RsvpStatus | null
  targetKey: string | null
  pending: boolean
}
type Reply = { key: string } & (
  | {
      channel: 'calendar'
      target: string
      proof: string
      patch: NonNullable<VerifiedCopy['reply']>
    }
  | {
      channel: 'gmail'
      target: string
      headers: NonNullable<Mail['replyHeaders']>
      organizer: string
      body: (email: string, answer: InviteAnswer) => string
    }
)
export type InvitationFacts = {
  source: InvitationCardSource
  responseFacts: ResponseFacts
  responseUnverified: boolean
  /** A candidate from this snapshot, not authorization to write. */
  reply: Reply | null
  noopChannel: Channel | null
  response: Revision['mailboxResponse']
  recorded: InviteAnswer | null
  priorSent: SentEvidence | null
  absentTargets: Set<string>
  /** Recheck against durable evidence at reservation, independently of the provider target. */
  blockedByConfirmation: (attempt: InvitationAttempt) => boolean
  navigation: (() => Promise<InvitationLinks | false | null | undefined>) | null
}
type ReadResult = { cards: InvitationFacts[]; recoveryReason: string | null }
type CalendarCopy = Awaited<ReturnType<typeof findInvitationCalendarCopy>>
type VerifiedCopy = Extract<CalendarCopy, { kind: 'verified' }>

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
    // This pass compares event revisions, not REPLYs. Only the latter can
    // be reconciled by Sent envelope, scope, and timestamp.
    if (
      (!mail.sent || renditions.some(({ candidate }) => candidate)) &&
      hasConflictingAlternatives(renditions.filter(verified))
    )
      throw new CalendarScanError('Gmail contains conflicting calendar alternatives')
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
    else if (answer) {
      answers.add(answer)
      representations.push({ alternatives: part.alternatives, signature: answer })
    } else unrelated = true
  }
  // Reply renditions are compared only after verifying the same envelope and
  // iTIP scope; prose and encoding differences do not change an answer. A
  // conflicting alternative or a mix of matching and unrelated material is
  // uncertain evidence, not a positive answer or a conversation-wide error.
  unresolved ||= answers.size > 0 && (unrelated || hasConflictingAlternatives(representations))
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

function isAnswer(status: ResponseFacts['status']): status is InviteAnswer {
  return status === 'accepted' || status === 'tentative' || status === 'declined'
}

function calendarInvitation(
  entry: Awaited<ReturnType<typeof latestByScope>>['scopes'][number],
  email: string,
): InvitationTarget | null {
  const { details, request, revisionMaterial } = entry.selected.value
  if (entry.reason || !request || !revisionMaterial || !details.organizer) return null
  const legacyJoinOnly = entry.selected.joinOnly
  // Revision selection has already limited history to this scope and sequence.
  // Calendar must distinguish the selected REQUEST from each strictly earlier
  // REQUEST it might still be showing, for both the occurrence card and Join.
  const predecessors = entry.history.flatMap(({ value }) =>
    value.method === 'REQUEST' &&
    value.revisionMaterial &&
    value.details.identity.dtstamp !== null &&
    details.identity.dtstamp !== null &&
    value.details.identity.dtstamp < details.identity.dtstamp
      ? [{ details: value.details, material: value.revisionMaterial }]
      : [],
  )
  return {
    details,
    request,
    material: revisionMaterial,
    joinOnly: legacyJoinOnly || entry.selected.mail.sent || details.organizer.email === email,
    legacyJoinOnly,
    predecessors,
  }
}

function bindsConfirmation(
  attempt: InvitationAttempt,
  { accountSub, email }: InvitationReadTarget,
  { identity, organizer }: Candidate['value']['details'],
): boolean {
  const { delivery } = attempt
  return (
    attempt.accountSub === accountSub &&
    sameGroup(attempt.revision, identity) &&
    organizer !== null &&
    delivery.organizer === organizer.email &&
    (delivery.channel === 'gmail'
      ? delivery.mailbox === email
      : calendarTargetIsMailbox(delivery.target, email))
  )
}

function responseTargetKey(channel: Channel, target: string): string {
  return createHash('sha256')
    .update(JSON.stringify([channel, target]))
    .digest('hex')
}

/** Reconcile provider observations and the local journal without dispatching a reply. */
export function createMailInvitationReconciler(
  store: ReturnType<typeof createMailInvitationStore>,
  dispatching: ReadonlySet<string>,
) {
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
    await store.changeAttempt(id, withGmailOutcome).then(
      () => gmailOutcomes.delete(id),
      () => undefined,
    )
  }

  async function collectCalendarCopies(
    target: InvitationReadTarget,
    scopes: Awaited<ReturnType<typeof latestByScope>>['scopes'],
  ) {
    const { api, accountSub, email } = target
    const copies = new Map<string, CalendarCopy>()
    target.assertBinding()
    for (const entry of scopes) {
      const invitation = calendarInvitation(entry, email)
      if (!invitation) continue
      const copy = await findInvitationCalendarCopy(api, invitation, email, (locator) =>
        store.rememberCalendarLocator({ accountSub, ...locator }, target.assertBinding),
      )
      copies.set(scopeKey(invitation.details.identity), copy)
    }
    const journal = await store.read()
    target.assertBinding()
    return { copies, journal }
  }

  const readFacts = async (
    target: InvitationReadTarget,
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
    const { scopes: incoming, selectSeriesSlot, disputedSent } = await latestByScope(thread, email)
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
    async function receiptObscured(attempt: InvitationAttempt, mail: Mail): Promise<boolean> {
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
    }

    async function reconcileAttempts() {
      let latestJournal = journal
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
      for (const attempt of [...relevant].reverse()) {
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
          await store.changeAttempt(id, (entry) => (entry.state === 'prepared' ? null : entry))
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
            latestJournal.parentAnchors.some(
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
        const scope = entries.get(key)?.selected.value.details
        latestJournal = await store.confirmAttempt(
          attempt,
          (entry) => {
            // Compaction must preserve the durable revision frontier as well as
            // the old locator. Dispatch order alone cannot retire a version.
            const order = revisionOrder(attempt.revision, entry.revision)
            return (
              (order === 0 || order === 1) &&
              scope !== undefined &&
              bindsConfirmation(attempt, target, scope) &&
              bindsConfirmation(entry, target, scope) &&
              matchLineage?.(attempt) === 'linked' &&
              matchLineage(entry) === 'linked' &&
              (entry.delivery.channel !== 'gmail' || hasStoredAnchor(entry) || provesAnchor(entry))
            )
          },
          provesAnchor,
        )
        gmailOutcomes.delete(attempt.id)
      }
      return { pending, confirmations, latestJournal, contested, unverifiedReceipts }
    }
    const { pending, confirmations, latestJournal, contested, unverifiedReceipts } =
      await reconcileAttempts()
    const { parentAnchors } = latestJournal
    const cards: InvitationFacts[] = []
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
      const occurrenceRevisionBlocked = identity.recurrenceId !== null && Boolean(entry.reason)
      const navigationWithheld =
        occurrenceRevisionBlocked ||
        (calendar?.kind === 'blocked' && calendar.navigationUnverified === true)
      const responseFacts: ResponseFacts = {
        // A disputed CANCEL can be the displayed rendition, but arrival order
        // alone doesn't confirm cancellation or remove the read-only Retry.
        cancelled:
          verifiedCopy?.cancelled ??
          ((details.cancelled && !occurrenceRevisionBlocked) ||
            entry.cancelledBy !== undefined ||
            (calendar?.kind === 'blocked' && calendar.cancelled === true)),
        unavailableReason: verifiedCopy
          ? verifiedCopy.unavailableReason
          : calendar?.kind === 'blocked'
            ? calendar.reason
            : (entry.reason ?? details.unavailableReason),
        status: verifiedCopy?.responseStatus ?? null,
        sentStatus: null,
        recordedCalendarStatus: verifiedCopy?.responseStatus ?? null,
        targetKey:
          verifiedCopy && !joinOnly ? responseTargetKey('calendar', verifiedCopy.target) : null,
        pending: false,
      }
      let reply: Reply | null = verifiedCopy?.reply
        ? {
            channel: 'calendar',
            target: verifiedCopy.target,
            proof: verifiedCopy.proof,
            key: JSON.stringify([verifiedCopy.target, verifiedCopy.etag, verifiedCopy.proof]),
            patch: verifiedCopy.reply,
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
        !responseFacts.cancelled &&
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
          if (absenceContradicted && delivery?.channel === 'calendar' && historical) {
            // Only a confirmation on the selected lineage reaches here. The
            // exact resource corroborates its answer, not a current write target.
            exactConfirmed = await exactCalendarAnswer(resources, delivery, historical)
            if (exactConfirmed) responseFacts.recordedCalendarStatus = historical
          }
          const headers = selected.mail.replyHeaders
          if (absenceContradicted) {
            responseFacts.unavailableReason =
              'Calendar could not verify whether it has a copy of this invitation'
          } else if (!attendee) {
            responseFacts.unavailableReason =
              'This invitation does not list the connected mailbox as an attendee'
          } else if (request.replyUnavailableReason) {
            responseFacts.unavailableReason = request.replyUnavailableReason
          } else if (!headers || !responseParents.has(headers.inReplyTo)) {
            responseFacts.unavailableReason = 'This invitation has no valid Gmail reply headers'
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
        responseFacts.sentStatus = receiptUnsettled ? null : sentStatus
        const calendarStatus = isAnswer(responseFacts.recordedCalendarStatus)
          ? responseFacts.recordedCalendarStatus
          : null
        recorded = calendarStatus ?? (calendar.kind === 'absent' ? responseFacts.sentStatus : null)
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
          if (gmailUnverified) responseFacts.unavailableReason = sentVerificationReason
          else if (answersDiffer)
            responseFacts.unavailableReason ??= `Calendar records ${calendarStatus}, but the other confirmed response is ${otherAnswer}.`
          responseFacts.status = null
        } else {
          responseFacts.status =
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
          responseFacts.status === historical
        ) {
          noopChannel = 'calendar'
          responseFacts.targetKey = responseTargetKey('calendar', delivery.target)
        }
        if (reply?.channel === 'gmail')
          responseFacts.targetKey = responseTargetKey('gmail', reply.target)
        if (reply)
          reply.key = JSON.stringify([
            reply.key,
            confirmation?.attempt.id,
            sent.evidence,
            calendarObserved,
          ])
      }
      // Off-lineage confirmation is negative version evidence only. It must
      // not supply a status, parent, or target for the revision being shown.
      const blockedByConfirmation = (attempt: InvitationAttempt) =>
        attempt.state === 'confirmed' &&
        bindsConfirmation(attempt, target, details) &&
        !onLineage(entry, attempt.revision, email) &&
        !supersedes(entry, attempt.revision, email)
      if (!joinOnly && request && latestJournal.attempts.some(blockedByConfirmation)) {
        reply = null
        noopChannel = null
        responseFacts.targetKey = null
        responseFacts.unavailableReason ??= 'This invitation does not match a confirmed revision'
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
        responseFacts.pending = true
        responseFacts.status = null
        const sentReceiptUnverified = scopePending.some(
          ({ id, delivery }) =>
            delivery.channel === 'gmail' &&
            (unverifiedReceipts.has(id) || owners.get(delivery.rfcId) === null),
        )
        if (sentReceiptUnverified) responseFacts.sentStatus = null
        if (!responseFacts.cancelled) {
          responseFacts.unavailableReason =
            gmailUnverified || sentReceiptUnverified
              ? sentVerificationReason
              : scopePending.some((attempt) => attempt.state === 'accepted')
                ? 'Google accepted your response; waiting for it to appear'
                : 'The response could not be confirmed. Check its status before sending again.'
        }
      }
      cards.push({
        source: {
          details,
          bindingRevision: target.bindingRevision,
          joinOnly,
          calendar: verifiedCopy,
          navigationWithheld,
        },
        responseFacts,
        responseUnverified,
        reply,
        noopChannel,
        response: entry.response,
        recorded,
        priorSent,
        absentTargets,
        blockedByConfirmation,
        navigation:
          !navigationWithheld && verifiedCopy
            ? () =>
                verifiedCopy.navigation((slot) => {
                  const occurrence = selectSeriesSlot(selected, slot)
                  return occurrence ? (calendarInvitation(occurrence, email) ?? false) : occurrence
                })
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
    readFacts,
    async recordGmailOutcome(
      id: string,
      state: 'unresolved' | 'accepted',
      receipt: CalendarReplyReceipt,
    ) {
      gmailOutcomes.set(id, { state, receipt })
      await flushGmailOutcome(id)
    },
  }
}
