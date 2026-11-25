import { randomUUID } from 'node:crypto'
import { CapabilityError } from '../../../main/plugin-api'
import { GoogleApiError, GoogleWriteUncertainError, type GoogleApi } from './api'
import { findInvitationCalendarCopy, type InviteAnswer } from './calendar'
import { fetchThreadCalendarPayloads, findSentCalendarReply, sendCalendarReply } from './gmail'
import type { createMailInvitationStore, InvitationAttempt } from './mail-invitation-store'
import {
  httpsLink,
  invitationReplyStatus,
  parseMailInvitation,
  type MailInvitationIdentity,
} from './mail-invitation'

type Invitation = NonNullable<ReturnType<typeof parseMailInvitation>>
type Mail = Awaited<ReturnType<typeof fetchThreadCalendarPayloads>>[number]
type Revision = InvitationAttempt['revision']
type MailInvitation = Invitation['details'] & {
  bindingRevision: string
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
type Candidate = { value: Invitation; mail: Mail }
type Incoming = {
  selected: Candidate
  parents: Set<string>
  reason?: string
}
type Reply = { key: string } & (
  | {
      channel: 'calendar'
      target: string
      send: (answer: InviteAnswer, validate: () => Promise<void>) => Promise<void>
    }
  | {
      channel: 'gmail'
      headers: NonNullable<Mail['replyHeaders']>
      organizer: string
      body: (email: string, answer: InviteAnswer) => string
    }
)
type Resolved = { invitation: MailInvitation; reply: Reply | null }

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

function equivalent(a: Invitation, b: Invitation): boolean {
  return (
    a.method !== null &&
    a.method === b.method &&
    a.details.identity.materialKey !== null &&
    sameRevision(a.details.identity, b.details.identity)
  )
}

async function latestIncoming(messages: Mail[]): Promise<Incoming | null> {
  const candidates: Candidate[] = []
  for (const mail of messages) {
    if (mail.sent) continue
    for (const part of mail.parts) {
      const value = parseMailInvitation(mail.messageId, await part.read(), part.method)
      if (value) candidates.push({ value, mail })
    }
  }
  // Arrival only selects a parent for equivalent deliveries (or the card to
  // show when blocked). It never orders distinct invitation revisions.
  candidates.sort(
    (a, b) =>
      b.mail.timestamp - a.mail.timestamp || a.mail.messageId.localeCompare(b.mail.messageId),
  )
  const first = candidates[0]
  if (!first) return null
  const blocked = (reason: string) => ({ selected: first, parents: new Set<string>(), reason })
  const group = first.value.details.identity
  if (candidates.some(({ value }) => !sameGroup(group, value.details.identity))) {
    return blocked('This conversation contains different invitations')
  }
  const sequence = candidates.reduce(
    (max, { value }) => Math.max(max, value.details.identity.sequence),
    0,
  )
  const atSequence = candidates.filter(({ value }) => value.details.identity.sequence === sequence)
  const stamps = atSequence.flatMap(({ value }) => value.details.identity.dtstamp ?? [])
  const newest = stamps.sort().at(-1) ?? null
  // An unstamped candidate at the same sequence cannot be ordered against a
  // stamped one. Keep it in contention rather than guessing which came later.
  const latest = atSequence.filter(({ value }) => {
    const stamp = value.details.identity.dtstamp
    return stamp === null || stamp === newest
  })
  const selected = latest[0]!
  if (latest.some(({ value }) => value !== selected.value && !equivalent(value, selected.value))) {
    return blocked('This conversation contains conflicting invitation revisions')
  }
  const parents = new Set<string>()
  for (const { value, mail } of candidates) {
    const parent = mail.replyHeaders?.inReplyTo
    if (
      parent &&
      equivalent(value, selected.value) &&
      candidates.every((other) => other.mail.rfcId !== parent || equivalent(other.value, value))
    ) {
      parents.add(parent)
    }
  }
  return { selected, parents }
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

/** One Electron-process owner, used by every vault. A durable reservation
 * precedes dispatch; Retry reads Google and never replays a write. */
export function createMailInvitationSession(store: ReturnType<typeof createMailInvitationStore>) {
  const busy = new Set<string>()
  const dispatching = new Set<string>()
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

  const read = async (target: Target, excludeAttempt?: string): Promise<Resolved | null> => {
    const { api, threadId, accountSub, email } = target
    target.assertBinding()
    const journal = await store.read()
    const messages = await fetchThreadCalendarPayloads(api, threadId)
    const incoming = await latestIncoming(messages)
    target.assertBinding()
    if (!incoming) return null
    const { details, request } = incoming.selected.value
    const identity = details.identity
    const relevant = journal.attempts.filter(
      (attempt) =>
        attempt.id !== excludeAttempt &&
        attempt.accountSub === accountSub &&
        (attempt.state === 'confirmed'
          ? sameRevision(attempt.revision, identity)
          : sameGroup(attempt.revision, identity) || attempt.threadId === threadId),
    )
    const invitation: MailInvitation = {
      ...details,
      bindingRevision: target.bindingRevision,
      responseStatus: null,
      canRespond: false,
      responsePending: false,
    }
    let reply: Reply | null = null
    const pending: InvitationAttempt[] = []
    const located: Mail[] = []
    const locatedParents = new Set(incoming.parents)
    let missingConfirmed = false
    const organizer = details.organizer?.email
    let calendar: Awaited<ReturnType<typeof findInvitationCalendarCopy>> | undefined
    if (incoming.reason) invitation.unavailableReason = incoming.reason
    else if (request && organizer) {
      if (organizer === email) invitation.unavailableReason = 'You organize this event'
      else calendar = await findInvitationCalendarCopy(api, { ...identity, organizer }, email)
    }

    for (const attempt of relevant) {
      const { id, answer, delivery, revision } = attempt
      if (dispatching.has(id)) {
        pending.push(attempt)
        continue
      }
      if (delivery.channel === 'calendar') {
        if (
          sameRevision(revision, identity) &&
          calendar?.kind === 'verified' &&
          !calendar.cancelled &&
          delivery.target === calendar.target &&
          answer === calendar.responseStatus
        ) {
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
      let mail = await findSentCalendarReply(api, delivery.rfcId, delivery.receipt, isAnswer).catch(
        () => null,
      )
      if (!mail) {
        const inThread = messages.find((message) => message.rfcId === delivery.rfcId)
        if (inThread && (await isAnswer(inThread))) mail = inThread
      }
      if (!mail) {
        if (attempt.state !== 'confirmed') pending.push(attempt)
        else missingConfirmed = true
        continue
      }
      target.assertBinding()
      if (attempt.state !== 'confirmed') {
        const receipt = { id: mail.messageId, threadId: mail.threadId }
        await changeAttempt(id, (current) => ({
          ...current,
          state: 'confirmed',
          delivery: { ...delivery, receipt: delivery.receipt?.id ? delivery.receipt : receipt },
        }))
      }
      if (
        sameRevision(revision, identity) &&
        delivery.organizer === organizer &&
        delivery.mailbox === email
      ) {
        located.push(mail)
        locatedParents.add(delivery.parent)
      }
    }

    if (calendar?.kind === 'blocked') invitation.unavailableReason = calendar.reason
    if (calendar?.kind === 'verified') {
      invitation.title = calendar.title?.trim() || invitation.title
      invitation.start = calendar.start ?? invitation.start
      invitation.end = calendar.end ?? invitation.end
      if (calendar.start) invitation.allDay = calendar.allDay
      invitation.location = calendar.location ?? invitation.location
      const conferenceUrl = httpsLink(calendar.conferenceUrl)
      const htmlLink = httpsLink(calendar.htmlLink)
      if (conferenceUrl) {
        invitation.conferenceUrl = conferenceUrl
        invitation.conferenceLinkSource = 'calendar'
      }
      if (htmlLink) {
        invitation.htmlLink = htmlLink
        invitation.htmlLinkSource = 'calendar'
      }
      invitation.responseStatus = calendar.responseStatus
      invitation.cancelled = calendar.cancelled
      invitation.unavailableReason = calendar.unavailableReason
      if (calendar.reply)
        reply = {
          channel: 'calendar',
          target: calendar.target,
          key: JSON.stringify([calendar.target, calendar.etag]),
          send: calendar.reply,
        }
    } else if (calendar?.kind === 'absent' && request && organizer) {
      const headers = incoming.selected.mail.replyHeaders
      if (!request.attendees.includes(email)) {
        invitation.unavailableReason =
          'This invitation does not list the connected mailbox as an attendee'
      } else {
        const eligibleSent = messages.filter(
          (mail) => mail.parent && incoming.parents.has(mail.parent),
        )
        const response = await sentResponse(
          [...eligibleSent, ...located],
          locatedParents,
          identity,
          { organizer, mailbox: email },
        )
        if (response.answers.size > 1 || missingConfirmed) {
          invitation.unavailableReason = 'Gmail could not verify the latest sent response'
        } else {
          invitation.responseStatus = response.answers.values().next().value ?? 'needsAction'
          if (!headers || !incoming.parents.has(headers.inReplyTo)) {
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
    if (pending.length) {
      invitation.responsePending = true
      invitation.unavailableReason = pending.some((attempt) => attempt.state === 'accepted')
        ? 'Google accepted your response; waiting for it to appear'
        : 'The response could not be confirmed. Check its status before sending again.'
      reply = null
    }
    invitation.canRespond = reply !== null
    target.assertBinding()
    return { invitation, reply }
  }

  return {
    async read(target: Target): Promise<MailInvitation | null> {
      const result = await read(target)
      target.assertBinding()
      return result?.invitation ?? null
    },
    async respond(
      target: Target,
      identity: MailInvitationIdentity,
      answer: InviteAnswer,
    ): Promise<RespondResult> {
      const { accountSub, threadId, email } = target
      if (busy.has(accountSub))
        throw new CapabilityError('CONFLICT', 'An invitation response is already in progress')
      busy.add(accountSub)
      try {
        const current = await read(target)
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
          state: 'unresolved',
          delivery:
            channel === 'calendar'
              ? { channel, target: reply.target }
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
            const newest = await read(target, id)
            if (
              !newest?.reply ||
              !sameInvitation(newest.invitation.identity, identity) ||
              newest.reply.channel !== channel ||
              newest.reply.key !== reply.key ||
              newest.invitation.responseStatus !== invitation.responseStatus
            )
              throw conflict()
          }
          try {
            let receipt = null
            if (channel === 'calendar') await reply.send(answer, validate)
            else
              receipt = await sendCalendarReply(
                target.api,
                threadId,
                reply.headers,
                rfcId,
                email,
                reply.organizer,
                reply.body(email, answer),
                validate,
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
            if (error instanceof GoogleApiError && error.status === 412) throw conflict()
            throw error
          }
        } finally {
          dispatching.delete(id)
        }
        const refreshed = await read(target).catch(() => null)
        const confirmed = refreshed?.invitation ?? null
        return {
          outcome: 'sent',
          channel,
          answer,
          invitation: confirmed,
          refreshPending: confirmed === null || confirmed.responsePending,
        }
      } finally {
        busy.delete(accountSub)
      }
    },
  }
}
