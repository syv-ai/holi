import { randomUUID } from 'node:crypto'
import { CapabilityError } from '../../../main/plugin-api'
import { GoogleApiError, GoogleWriteUncertainError, type GoogleApi } from './api'
import {
  findInvitationCalendarCopy,
  verifyInvitationCalendarResponse,
  type InviteAnswer,
} from './calendar'
import {
  CalendarScanError,
  createCalendarScan,
  fetchThreadCalendarPayloads,
  findSentCalendarReply,
  ignoreMissingCalendarEvidence,
  sendCalendarReply,
} from './gmail'
import { parseCalendarMail } from './invite'
import type { createMailInvitationStore, InvitationAttempt } from './mail-invitation-store'
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
  responseStatus: InviteAnswer | 'needsAction' | null
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
type Candidate = NonNullable<ReturnType<typeof parseCalendarMail>> & { mail: Mail }
type Incoming = {
  selected: Candidate
  parents: Set<string>
  history: Candidate[]
  reason?: string
}
type DispatchGate = { validate: () => Promise<void>; reserveDispatch: () => Promise<void> }
type Reply = { key: string } & (
  | {
      channel: 'calendar'
      target: string
      proof: string
      send: (answer: InviteAnswer, gate: DispatchGate) => Promise<void>
    }
  | {
      channel: 'gmail'
      headers: NonNullable<Mail['replyHeaders']>
      organizer: string
      body: (email: string, answer: InviteAnswer) => string
    }
)
type Resolved = { invitation: MailInvitation; reply: Reply | null }
type ReadResult = { cards: Resolved[]; recoveryReason: string | null }
type CalendarCopy = Awaited<ReturnType<typeof findInvitationCalendarCopy>>

type SentAddress = { organizer: string; mailbox: string }

function sameGroup(a: Revision, b: Revision): boolean {
  return a.uid === b.uid && a.recurrenceId === b.recurrenceId
}

function sameRevision(a: Revision, b: Revision): boolean {
  return (
    sameGroup(a, b) &&
    a.sequence === b.sequence &&
    a.dtstamp === b.dtstamp &&
    a.materialKey === b.materialKey
  )
}

function sameInvitation(a: MailInvitationIdentity, b: MailInvitationIdentity): boolean {
  return a.messageId === b.messageId && sameRevision(a, b)
}

const identityOf = ({ value }: Candidate) => value.details.identity
const scopeKey = ({ uid, recurrenceId }: Revision) => JSON.stringify([uid, recurrenceId])

function sameMaterial(a: Candidate, b: Candidate): boolean {
  const first = identityOf(a)
  const second = identityOf(b)
  return (
    a.published === b.published &&
    a.value.method !== null &&
    a.value.method === b.value.method &&
    first.sequence === second.sequence &&
    first.materialKey !== null &&
    first.materialKey === second.materialKey
  )
}

function blocked(selected: Candidate, reason: string): Incoming {
  return { selected, reason, parents: new Set(), history: [] }
}

async function latestByScope(messages: Mail[], mailbox: string): Promise<Incoming[]> {
  const candidates: Candidate[] = []
  for (const mail of messages) {
    if (mail.sent && mail.from !== mailbox) continue
    for (const part of mail.parts) {
      if (mail.sent && part.method?.toUpperCase() === 'REPLY') continue
      const parsed = parseCalendarMail(mail.messageId, await part.read(), part.method)
      if (parsed && (!mail.sent || parsed.value.method || parsed.published))
        candidates.push({ ...parsed, mail })
    }
  }
  // Arrival breaks ties among equivalent deliveries. Sequence and DTSTAMP
  // order revisions within an original occurrence (or the master), never across scopes.
  candidates.sort(
    (a, b) =>
      Number(a.mail.sent) - Number(b.mail.sent) ||
      b.mail.timestamp - a.mail.timestamp ||
      a.mail.messageId.localeCompare(b.mail.messageId),
  )
  const first = candidates[0]
  if (!first) return []
  const unknown = candidates.find((candidate) => !identityOf(candidate).materialKey)
  if (unknown)
    return [
      blocked(
        unknown,
        unknown.value.details.unavailableReason ??
          'Gmail could not identify a revision in this conversation',
      ),
    ]
  const groups = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const identity = identityOf(candidate)
    if (identity.uid !== identityOf(first).uid)
      return [blocked(first, 'This conversation contains unrelated invitations')]
    const key = scopeKey(identity)
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => selectScope(group, candidates))
}

function selectScope(group: Candidate[], candidates: Candidate[]): Incoming {
  const sequence = Math.max(...group.map((candidate) => identityOf(candidate).sequence))
  const history = group.filter((candidate) => identityOf(candidate).sequence === sequence)
  const stamps = [...new Set(history.flatMap((candidate) => identityOf(candidate).dtstamp ?? []))]
    .sort()
    .reverse()
  const newest = stamps[0] ?? null
  const unknownOrder = history.filter((candidate) => identityOf(candidate).dtstamp === null)
  const latest = history.filter((candidate) => identityOf(candidate).dtstamp === newest)
  const selected = latest[0]!
  if (
    (newest !== null && unknownOrder.length) ||
    latest.some((candidate) => candidate !== selected && !sameMaterial(candidate, selected))
  )
    return blocked(selected, 'This conversation contains conflicting invitation revisions')

  // For Sent continuity walk backwards through equal material without crossing
  // a CANCEL, conflict, material change, or attendee PARTSTAT/RSVP reset.
  const lineage = [...latest]
  for (const stamp of stamps.slice(1)) {
    const deliveries = history.filter((candidate) => identityOf(candidate).dtstamp === stamp)
    if (!deliveries.every((candidate) => sameMaterial(candidate, selected))) break
    lineage.push(...deliveries)
  }
  const parents = new Set<string>()
  for (const candidate of lineage) {
    const parent = candidate.mail.replyHeaders?.inReplyTo
    if (
      parent &&
      candidates.every(
        (other) =>
          other.mail.rfcId !== parent ||
          (candidate.mail.messageId === other.mail.messageId &&
            !sameGroup(identityOf(candidate), identityOf(other))) ||
          (sameRevision(identityOf(candidate), identityOf(other)) &&
            sameMaterial(candidate, other)),
      )
    )
      parents.add(parent)
  }
  return { selected, history, parents }
}

function onLineage(incoming: Incoming, revision: Revision): boolean {
  const current = identityOf(incoming.selected)
  if (sameRevision(current, revision)) return true
  if (
    incoming.reason ||
    !sameGroup(current, revision) ||
    current.sequence !== revision.sequence ||
    current.materialKey !== revision.materialKey ||
    !current.dtstamp ||
    !revision.dtstamp ||
    current.dtstamp <= revision.dtstamp
  )
    return false
  // A journal receipt can anchor a parent no longer present in the thread.
  // Every visible candidate back to that anchor must still agree.
  const anchor = revision.dtstamp
  return incoming.history.every((candidate) => {
    const stamp = identityOf(candidate).dtstamp
    return stamp !== null && (stamp < anchor || sameMaterial(candidate, incoming.selected))
  })
}

function supersedes(incoming: Incoming, revision: Revision): boolean {
  const current = identityOf(incoming.selected)
  if (incoming.reason || !sameGroup(current, revision)) return false
  if (current.sequence !== revision.sequence) return current.sequence > revision.sequence
  if (
    onLineage(incoming, revision) ||
    !current.dtstamp ||
    !revision.dtstamp ||
    current.dtstamp <= revision.dtstamp
  )
    return false
  // An older parent may have disappeared. Do not unlock a stamp-only
  // redelivery without proof of a newer material revision in between.
  const prevStamp = revision.dtstamp
  return (
    current.materialKey !== revision.materialKey ||
    incoming.history.some((candidate) => {
      const prior = identityOf(candidate)
      return (
        prior.dtstamp !== null &&
        prior.dtstamp >= prevStamp &&
        !sameMaterial(candidate, incoming.selected)
      )
    })
  )
}

async function sentAnswer(mail: Mail, revision: Revision, { mailbox, organizer }: SentAddress) {
  if (!mail.sent || mail.from !== mailbox || mail.to.length !== 1 || mail.to[0] !== organizer)
    return []
  const answers = new Set<InviteAnswer>()
  for (const part of mail.parts) {
    if (part.method && part.method.toUpperCase() !== 'REPLY') continue
    // A REPLY's DTSTAMP describes the reply. Its parent, not its own stamp,
    // associates it with the precise incoming REQUEST revision.
    const answer = invitationReplyStatus(
      await part.read(),
      { ...revision, messageId: '' },
      organizer,
      mailbox,
    )
    if (answer) answers.add(answer)
  }
  return [...answers]
}

async function sentResponse(
  messages: Mail[],
  parents: Set<string>,
  revision: Revision,
  address: SentAddress,
) {
  let newest = -1
  const answers = new Set<InviteAnswer>()
  const evidence = new Set<string>()
  for (const message of messages) {
    if (!message.parent || !parents.has(message.parent) || message.timestamp < newest) continue
    const matched = await sentAnswer(message, revision, address)
    if (!matched.length) continue
    if (message.timestamp > newest) {
      answers.clear()
      evidence.clear()
      newest = message.timestamp
    }
    for (const answer of matched) answers.add(answer)
    evidence.add(message.messageId)
  }
  return { answers, evidence: [...evidence].sort() }
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
  ) {
    const pending: InvitationAttempt[] = []
    const receipts: { attempt: InvitationAttempt; mail: Mail | null }[] = []
    for (const attempt of attempts) {
      const { id, delivery, revision, answer } = attempt
      if (dispatching.has(id)) {
        pending.push(attempt)
        continue
      }
      if (attempt.state === 'prepared') {
        target.assertBinding()
        await changeAttempt(id, (entry) => (entry.state === 'prepared' ? null : entry))
        continue
      }
      if (delivery.channel === 'calendar') {
        const copy = copies.get(scopeKey(revision))
        const matching =
          copy?.kind === 'verified' &&
          copy.target === delivery.target &&
          (delivery.proof ? copy.proof === delivery.proof : sameRevision(copy.revision, revision))
        const confirmed = matching
          ? copy.responseStatus === answer
          : Boolean(
              delivery.proof &&
              (await verifyInvitationCalendarResponse(
                target.api,
                delivery.target,
                delivery.proof,
                answer,
              ).catch(() => false)),
            )
        if (confirmed) {
          target.assertBinding()
          await changeAttempt(id, () => null)
        } else pending.push(attempt)
        continue
      }
      const isAnswer = async (mail: Mail) => {
        if (mail.parent !== delivery.parent) return false
        const answers = await sentAnswer(mail, revision, delivery)
        return answers.length === 1 && answers[0] === answer
      }
      const inThread = messages.filter((message) => message.rfcId === delivery.rfcId)
      let mail: Mail | null = null
      if (inThread.length === 1 && (await isAnswer(inThread[0]!))) mail = inThread[0]!
      if (!mail) {
        mail = await findSentCalendarReply(
          target.api,
          delivery.rfcId,
          delivery.receipt,
          scan,
          isAnswer,
        ).catch(ignoreMissingCalendarEvidence)
      }
      if (!mail && attempt.state !== 'confirmed') {
        pending.push(attempt)
        continue
      }
      if (mail && attempt.state !== 'confirmed') {
        target.assertBinding()
        const receipt = { id: mail.messageId, threadId: mail.threadId }
        await changeAttempt(id, (entry) => ({
          ...entry,
          state: 'confirmed',
          delivery: { ...delivery, receipt },
        }))
      }
      receipts.push({ attempt, mail })
    }
    return { pending, receipts }
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
    const { pending, receipts } = await reconcile(target, relevant, messages, scan, copies)
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
        bindingRevision: target.bindingRevision,
        kind: joinOnly ? 'meeting' : 'invitation',
        scope:
          identity.recurrenceId !== null ? 'occurrence' : details.recurring ? 'series' : 'single',
        responseStatus: null,
        canRespond: false,
        responsePending: false,
      }
      let reply: Reply | null = null
      if (entry.reason) invitation.unavailableReason = entry.reason
      if (calendar?.kind === 'blocked') invitation.unavailableReason = calendar.reason
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
      } else if (calendar?.kind === 'absent' && request && organizer) {
        const headers = selected.mail.replyHeaders
        const attendee = Object.hasOwn(request.attendeeStates, email)
          ? request.attendeeStates[email]
          : undefined
        if (!attendee) {
          invitation.unavailableReason =
            'This invitation does not list the connected mailbox as an attendee'
        } else {
          const responseParents = new Set(parents)
          const located: Mail[] = []
          let missingConfirmed = false
          for (const { attempt, mail } of receipts) {
            const { revision, delivery } = attempt
            if (
              delivery.channel !== 'gmail' ||
              delivery.organizer !== organizer ||
              delivery.mailbox !== email ||
              !onLineage(entry, revision)
            )
              continue
            if (
              !parents.has(delivery.parent) &&
              messages.some((message) => message.rfcId === delivery.parent)
            )
              continue
            // A durable receipt validated this parent when the original
            // REQUEST was selected. It can outlive Gmail's threading.
            if (mail) {
              located.push(mail)
              responseParents.add(delivery.parent)
            } else missingConfirmed = true
          }
          const eligibleSent = messages.filter((mail) => mail.parent && parents.has(mail.parent))
          const response = await sentResponse(
            [...eligibleSent, ...located],
            responseParents,
            identity,
            { organizer, mailbox: email },
          )
          if (response.answers.size > 1 || missingConfirmed) {
            invitation.unavailableReason = 'Gmail could not verify the latest sent response'
          } else {
            invitation.responseStatus =
              response.answers.values().next().value ?? attendee.responseStatus
            if (!headers || !parents.has(headers.inReplyTo)) {
              invitation.unavailableReason = 'This invitation has no valid Gmail reply headers'
            } else {
              reply = {
                channel: 'gmail',
                organizer,
                headers,
                body: request.reply,
                key: JSON.stringify([organizer, email, headers, response.evidence]),
              }
            }
          }
        }
      }
      const scopePending = pending.filter(
        (attempt) => sameGroup(attempt.revision, identity) && !supersedes(entry, attempt.revision),
      )
      if (scopePending.length) {
        for (const attempt of scopePending) displayedPending.add(attempt.id)
        invitation.responsePending = true
        invitation.unavailableReason = scopePending.some((attempt) => attempt.state === 'accepted')
          ? 'Google accepted your response; waiting for it to appear'
          : 'The response could not be confirmed. Check its status before sending again.'
        reply = null
      }
      invitation.canRespond = reply !== null
      cards.push({ invitation, reply })
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
        if (!reply)
          throw new CapabilityError(
            'FORBIDDEN',
            invitation.unavailableReason ?? 'This invitation cannot be answered',
          )
        const { channel } = reply
        if (invitation.responseStatus === answer) {
          return { outcome: 'unchanged', channel, answer, invitation, refreshPending: false }
        }

        if (!invitation.identity.materialKey) throw conflict()
        const id = randomUUID()
        const { uid, recurrenceId, sequence, dtstamp, materialKey } = invitation.identity
        const rfcId = `<${id}@holi.invalid>`
        const attempt: InvitationAttempt = {
          id,
          accountSub,
          threadId,
          revision: { uid, recurrenceId, sequence, dtstamp, materialKey },
          answer,
          state: 'prepared',
          delivery:
            channel === 'calendar'
              ? { channel, target: reply.target, proof: reply.proof }
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
              newest.reply.channel !== channel ||
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
          const gate = { validate, reserveDispatch }
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
          refreshPending: confirmed === null || confirmed.responsePending,
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
