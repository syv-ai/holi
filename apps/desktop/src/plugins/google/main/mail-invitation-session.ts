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
  createCalendarScan,
  fetchThreadCalendarPayloads,
  findSentCalendarReply,
  sendCalendarReply,
} from './gmail'
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
  SentEvidence,
} from './mail-invitation-store'
import {
  invitationReplyStatus,
  parseMailInvitation,
  type MailInvitationIdentity,
} from './mail-invitation'

type Invitation = NonNullable<ReturnType<typeof parseMailInvitation>>
type Mail = Awaited<ReturnType<typeof fetchThreadCalendarPayloads>>[number]
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

type Confirmation = { attempt: InvitationAttempt; mail: Mail | null }
type Corroborates = (attempt: InvitationAttempt) => boolean

type SentAddress = { organizer: string; mailbox: string }

async function latestByScope(messages: Mail[], mailbox: string) {
  const candidates: Candidate[] = []
  for (const mail of messages) {
    if (mail.sent && mail.from !== mailbox) continue
    const representations = []
    let hasCandidate = false
    for (const part of mail.parts) {
      if (part.method === null)
        throw new CalendarScanError('Gmail could not verify the calendar MIME declaration')
      if (mail.sent && part.method === 'REPLY' && !part.alternatives.length) continue
      const source = await part.read()
      const parsed = parseCalendarMail(mail.messageId, source, part.method)
      const candidate =
        parsed && (!mail.sent || parsed.value.method || parsed.published)
          ? { ...parsed, mail }
          : null
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
  return selectInvitationRevisions(candidates, mailbox)
}

async function sentAnswer(mail: Mail, revision: Revision, { mailbox, organizer }: SentAddress) {
  if (
    !mail.sent ||
    !mail.rfcId ||
    mail.from !== mailbox ||
    mail.to.length !== 1 ||
    mail.to[0] !== organizer ||
    mail.parts.some((part) => part.method === null)
  )
    return []
  const answers = new Set<InviteAnswer>()
  const representations = []
  let malformed = false
  for (const part of mail.parts) {
    // A REPLY's DTSTAMP describes the reply. Its parent, not its own stamp,
    // associates it with the precise incoming REQUEST revision.
    const source = await part.read()
    const answer =
      !part.method || part.method === 'REPLY'
        ? invitationReplyStatus(source, { ...revision, messageId: '' }, organizer, mailbox)
        : null
    if (answer) answers.add(answer)
    else malformed = true
    if (part.alternatives.length)
      representations.push({
        alternatives: part.alternatives,
        signature: answer ?? `unrecognized:${source}`,
      })
  }
  if (answers.size) assertEquivalentAlternatives(representations)
  return malformed ? [] : [...answers]
}

async function sentResponse(
  messages: Mail[],
  parents: Set<string>,
  revision: Revision,
  address: SentAddress,
) {
  let newest = -Infinity
  const answers = new Set<InviteAnswer>()
  const messageIds = new Set<string>()
  for (const message of messages
    .filter((mail) => mail.sent && mail.parent && parents.has(mail.parent))
    .sort((a, b) => b.timestamp - a.timestamp)) {
    if (message.timestamp < newest) break
    const matched = await sentAnswer(message, revision, address)
    if (!matched.length) continue
    newest = message.timestamp
    for (const answer of matched) answers.add(answer)
    messageIds.add(message.messageId)
  }
  const evidence: SentEvidence | null = messageIds.size
    ? {
        timestamp: newest,
        messageIds: [...messageIds].sort(),
        answer: answers.size === 1 ? answers.values().next().value! : null,
      }
    : null
  return { answers, evidence }
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
    messages: Mail[],
    scan: Scan,
    copies: Map<string, CalendarCopy>,
    lineages: Map<string, Corroborates>,
  ) {
    const pending: InvitationAttempt[] = []
    const confirmations = new Map<string, Confirmation>()
    // Journal order is dispatch order for a scope. Verify unresolved writes,
    // but do not read old confirmations once a newer one owns the lineage.
    for (const attempt of [...attempts].reverse()) {
      const { id, delivery, revision, answer } = attempt
      const key = scopeKey(revision)
      const corroborates = lineages.get(key)
      const relevant = corroborates?.(attempt) === true
      if (dispatching.has(id)) {
        pending.push(attempt)
        continue
      }
      if (attempt.state === 'prepared') {
        target.assertBinding()
        await changeAttempt(id, (entry) => (entry.state === 'prepared' ? null : entry))
        continue
      }
      if (attempt.state === 'confirmed' && (!relevant || confirmations.has(key))) continue

      let mail: Mail | null = null
      let confirmed = attempt
      if (delivery.channel === 'calendar') {
        if (attempt.state !== 'confirmed') {
          const copy = copies.get(key)
          const matching =
            copy?.kind === 'verified' &&
            copy.target === delivery.target &&
            (delivery.proof ? copy.proof === delivery.proof : sameRevision(copy.revision, revision))
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
      } else {
        const isAnswer = async (mail: Mail) => {
          if (mail.parent !== delivery.parent) return false
          const answers = await sentAnswer(mail, revision, delivery)
          return answers.length === 1 && answers[0] === answer
        }
        const inThread = messages.filter((message) => message.rfcId === delivery.rfcId)
        if (inThread.length === 1 && (await isAnswer(inThread[0]!))) mail = inThread[0]!
        if (!mail)
          mail = await findSentCalendarReply(
            target.api,
            delivery.rfcId,
            delivery.receipt,
            scan,
            isAnswer,
          )
        if (attempt.state !== 'confirmed') {
          if (!mail) {
            pending.push(attempt)
            continue
          }
          confirmed = {
            ...attempt,
            state: 'confirmed',
            delivery: { ...delivery, receipt: { id: mail.messageId, threadId: mail.threadId } },
          }
        }
      }
      if (confirmed !== attempt) {
        target.assertBinding()
        await store.update((journal) => {
          const index = journal.attempts.findIndex((entry) => entry.id === id)
          if (index < 0) return journal
          return {
            ...journal,
            attempts: journal.attempts.flatMap((entry, prior) => {
              if (prior === index) return confirmed
              // Keep ambiguous, pending and superseded revisions. Only a
              // newer corroborated answer can replace a same-lineage receipt.
              if (
                prior < index &&
                relevant &&
                entry.accountSub === target.accountSub &&
                entry.state === 'confirmed' &&
                corroborates?.(entry)
              )
                return []
              return entry
            }),
          }
        })
      }
      if (relevant && !confirmations.has(key)) confirmations.set(key, { attempt: confirmed, mail })
    }
    return { pending, confirmations }
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
    const messages = await fetchThreadCalendarPayloads(api, threadId, scan).catch((error) => {
      if (!(error instanceof GoogleApiError) || error.status !== 404) throw error
      missingThread = true
      return []
    })
    const incoming = await latestByScope(messages, email)
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
      const { details, request } = entry.selected.value
      const joinOnly =
        entry.selected.published || entry.selected.mail.sent || details.organizer?.email === email
      if (!entry.reason && request && details.organizer) {
        const copy = await findInvitationCalendarCopy(api, { details, request, joinOnly }, email)
        copies.set(scopeKey(details.identity), copy)
      }
    }
    const visibleParents = new Set(messages.flatMap((message) => message.rfcId ?? []))
    const lineages = new Map<string, Corroborates>()
    for (const entry of scopes) {
      const { organizer, identity } = entry.selected.value.details
      lineages.set(
        scopeKey(identity),
        ({ revision, delivery }) =>
          onLineage(entry, revision, email) &&
          (delivery.channel === 'calendar'
            ? calendarTargetIsMailbox(delivery.target, email)
            : delivery.organizer === organizer?.email &&
              delivery.mailbox === email &&
              (entry.parents.has(delivery.parent) || !visibleParents.has(delivery.parent))),
      )
    }
    const { pending, confirmations } = await reconcile(
      target,
      relevant,
      messages,
      scan,
      copies,
      lineages,
    )
    const cards: Resolved[] = []
    const displayedPending = new Set<string>()
    for (const entry of scopes) {
      const { selected, parents } = entry
      const { details, request } = selected.value
      const identity = details.identity
      const organizer = details.organizer?.email
      const joinOnly = selected.published || selected.mail.sent || organizer === email
      const calendar = copies.get(scopeKey(identity))
      // Organizer/Sent/PUBLISH mail does not get any link without a verified
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
          delivery.proof === calendar.proof
        const responseParents = new Set(parents)
        const eligibleSent = messages.filter((mail) => mail.parent && parents.has(mail.parent))
        if (delivery?.channel === 'gmail' && confirmation?.mail) {
          responseParents.add(delivery.parent)
          if (!eligibleSent.some(({ messageId }) => messageId === confirmation.mail?.messageId))
            eligibleSent.push(confirmation.mail)
        }
        const sent = await sentResponse(eligibleSent, responseParents, identity, {
          organizer,
          mailbox: email,
        })
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
        const sentStatus = superseded ? null : (sent.evidence?.answer ?? null)
        invitation.sentResponseStatus = sentStatus
        const calendarStatus = isAnswer(calendarObserved) ? calendarObserved : null
        const historical = confirmation?.attempt.answer ?? null
        const historicalCalendar =
          delivery?.channel === 'calendar' && !sameTarget ? historical : null
        if (calendar.kind === 'absent') {
          const headers = selected.mail.replyHeaders
          if (!attendee) {
            invitation.unavailableReason =
              'This invitation does not list the connected mailbox as an attendee'
          } else if (!headers || !parents.has(headers.inReplyTo)) {
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
        recorded = calendar.kind === 'verified' ? calendarStatus : sentStatus
        const sentUnverified =
          (!superseded && sent.answers.size > 1) ||
          (delivery?.channel === 'gmail' &&
            (!confirmation?.mail || (sentStatus !== null && sentStatus !== historical)))
        const otherAnswer = sentStatus ?? historicalCalendar
        const answersDiffer =
          calendarStatus !== null && otherAnswer !== null && calendarStatus !== otherAnswer
        // Two verified answers can differ without making the current write target ambiguous.
        // Only a writable Calendar copy and actual Sent evidence allow resolving that difference.
        const canResolveDifference = reply?.channel === 'calendar' && sentStatus !== null
        responseUnverified = sentUnverified || (answersDiffer && !canResolveDifference)
        if (responseUnverified) {
          invitation.unavailableReason ??= sentUnverified
            ? 'Gmail could not verify the latest sent response'
            : `Calendar records ${calendarStatus}, but the other confirmed response is ${otherAnswer}.`
          invitation.responseStatus = null
        } else {
          invitation.responseStatus =
            calendarStatus ??
            sentStatus ??
            historical ??
            (attendee?.responseStatus === 'delegated' && calendarObserved === 'needsAction'
              ? attendee.responseStatus
              : calendarObserved) ??
            attendee?.responseStatus ??
            null
        }
        if (reply)
          reply.key = JSON.stringify([
            reply.key,
            confirmation?.attempt.id,
            sent.evidence,
            calendarObserved,
          ])
      }
      const scopePending = pending.filter(
        (attempt) =>
          sameGroup(attempt.revision, identity) && !supersedes(entry, attempt.revision, email),
      )
      if (scopePending.length) {
        for (const attempt of scopePending) displayedPending.add(attempt.id)
        invitation.responsePending = true
        invitation.responseStatus = null
        if (!invitation.cancelled) {
          invitation.unavailableReason = scopePending.some(
            (attempt) => attempt.state === 'accepted',
          )
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
                  receipt: null,
                },
        }
        dispatching.add(id)
        try {
          await store.update((journal) => ({
            ...journal,
            attempts: [...journal.attempts, attempt],
          }))
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
