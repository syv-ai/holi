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
  findInvitationCalendarCopy,
  verifyInvitationCalendarResponse,
} from './mail-invitation-calendar'
import {
  CalendarScanError,
  createCalendarScan,
  fetchThreadCalendarPayloads,
  findSentCalendarReply,
  ignoreMissingCalendarEvidence,
  sendCalendarReply,
} from './gmail'
import { parseCalendarMail } from './invite'
import {
  identityOf,
  onLineage,
  sameGroup,
  sameInvitation,
  sameRevision,
  scopeKey,
  selectInvitationRevisions,
  supersedes,
  type Candidate,
} from './mail-invitation-revisions'
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
type Reply = { key: string } & (
  | {
      channel: 'calendar'
      target: string
      proof: string
      send: (answer: InviteAnswer, gate: GoogleDispatchGate) => Promise<void>
    }
  | {
      channel: 'gmail'
      headers: NonNullable<Mail['replyHeaders']>
      organizer: string
      body: (email: string, answer: InviteAnswer) => string
    }
)
type Resolved = {
  invitation: MailInvitation
  reply: Reply | null
  response: Revision['mailboxResponse']
}
type ReadResult = { cards: Resolved[]; recoveryReason: string | null }
type CalendarCopy = Awaited<ReturnType<typeof findInvitationCalendarCopy>>

type SentAddress = { organizer: string; mailbox: string }

async function latestByScope(messages: Mail[], mailbox: string) {
  const candidates: Candidate[] = []
  for (const mail of messages) {
    if (mail.sent && mail.from !== mailbox) continue
    for (const part of mail.parts) {
      if (part.method === null)
        throw new CalendarScanError('Gmail could not verify the calendar MIME declaration')
      if (mail.sent && part.method?.toUpperCase() === 'REPLY') continue
      const parsed = parseCalendarMail(mail.messageId, await part.read(), part.method)
      if (parsed && (!mail.sent || parsed.value.method || parsed.published))
        candidates.push({ ...parsed, mail })
    }
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
  for (const part of mail.parts) {
    if (part.method && part.method.toUpperCase() !== 'REPLY') return []
    // A REPLY's DTSTAMP describes the reply. Its parent, not its own stamp,
    // associates it with the precise incoming REQUEST revision.
    const answer = invitationReplyStatus(
      await part.read(),
      { ...revision, messageId: '' },
      organizer,
      mailbox,
    )
    if (!answer) return []
    answers.add(answer)
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
              )),
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
    const visibleParents = new Set(messages.flatMap((message) => message.rfcId ?? []))
    const corroborates = (
      entry: (typeof scopes)[number],
      { revision, delivery }: InvitationAttempt,
    ) =>
      delivery.channel === 'gmail' &&
      delivery.organizer === entry.selected.value.details.organizer?.email &&
      delivery.mailbox === email &&
      onLineage(entry, revision, email) &&
      (entry.parents.has(delivery.parent) || !visibleParents.has(delivery.parent))
    // Confirmed receipts are only useful for a Gmail answer on this lineage.
    // Never spend the shared evidence budget on known-obsolete confirmations.
    const attempts = relevant.filter(
      (attempt) =>
        attempt.state !== 'confirmed' ||
        scopes.some(
          (entry) =>
            copies.get(scopeKey(identityOf(entry.selected)))?.kind === 'absent' &&
            corroborates(entry, attempt),
        ),
    )
    const { pending, receipts } = await reconcile(target, attempts, messages, scan, copies)
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
            const { delivery } = attempt
            if (delivery.channel !== 'gmail' || !corroborates(entry, attempt)) continue
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
        (attempt) =>
          sameGroup(attempt.revision, identity) && !supersedes(entry, attempt.revision, email),
      )
      if (scopePending.length) {
        for (const attempt of scopePending) displayedPending.add(attempt.id)
        invitation.responsePending = true
        if (!invitation.cancelled) {
          invitation.unavailableReason = scopePending.some(
            (attempt) => attempt.state === 'accepted',
          )
            ? 'Google accepted your response; waiting for it to appear'
            : 'The response could not be confirmed. Check its status before sending again.'
        }
        reply = null
      }
      invitation.canRespond = reply !== null
      cards.push({ invitation, reply, response: entry.response })
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
              newest.invitation.responseStatus !== invitation.responseStatus ||
              newest.response?.responseStatus !== current.response?.responseStatus ||
              newest.response?.rsvp !== current.response?.rsvp
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
