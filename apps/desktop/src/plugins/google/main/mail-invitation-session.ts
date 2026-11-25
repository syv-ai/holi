import { CapabilityError } from '../../../main/plugin-api'
import { GoogleApiError, GoogleWriteUncertainError, type GoogleApi } from './api'
import { findInvitationCalendarCopy, type InviteAnswer } from './calendar'
import { fetchThreadCalendarPayloads, sendCalendarReply } from './gmail'
import {
  httpsLink,
  invitationReplyStatus,
  parseMailInvitation,
  type MailInvitationIdentity,
} from './mail-invitation'

type Invitation = NonNullable<ReturnType<typeof parseMailInvitation>>
type Mail = Awaited<ReturnType<typeof fetchThreadCalendarPayloads>>[number]
type MailInvitation = Invitation['details'] & {
  responseStatus: InviteAnswer | 'needsAction' | null
  canRespond: boolean
  /** A write has not yet been corroborated by Calendar or a sent REPLY. */
  responsePending: boolean
}
type Channel = 'calendar' | 'gmail'
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
  email: string
  validateSession: () => Promise<void>
}
type Resolved = {
  invitation: MailInvitation
  reply: {
    channel: Channel
    send: (answer: InviteAnswer, validate: () => Promise<void>) => Promise<unknown>
  } | null
}

function sameInvitation(a: MailInvitationIdentity, b: MailInvitationIdentity): boolean {
  return (
    a.messageId === b.messageId &&
    a.uid === b.uid &&
    a.sequence === b.sequence &&
    a.recurrenceId === b.recurrenceId
  )
}

async function latestIncoming(
  messages: Mail[],
): Promise<{ invitation: Invitation; mail: Mail } | null> {
  for (const mail of messages) {
    if (mail.sent) continue
    const candidates: Invitation[] = []
    for (const part of mail.parts) {
      const value = parseMailInvitation(mail.messageId, await part.read(), part.method)
      if (value) candidates.push(value)
    }
    const cancelled = candidates.find(({ details }) => details.cancelled)
    if (cancelled) return { invitation: cancelled, mail }
    // Common senders include both an inline calendar part and an equivalent
    // attachment. Do not choose between different invites in the same message.
    const usable = candidates.filter(({ request }) => request !== null)
    const selected = usable[0] ?? candidates[0]
    if (!selected) continue
    if (
      usable.some(
        ({ details }) =>
          !sameInvitation(details.identity, selected.details.identity) ||
          details.organizer?.email !== selected.details.organizer?.email,
      )
    ) {
      return {
        invitation: {
          details: {
            ...selected.details,
            unavailableReason: 'This message contains different invitations',
          },
          request: null,
        },
        mail,
      }
    }
    return { invitation: selected, mail }
  }
  return null
}

async function sentResponse(
  messages: Mail[],
  incoming: Mail,
  identity: MailInvitationIdentity,
  organizer: string,
  email: string,
): Promise<InviteAnswer | 'needsAction'> {
  for (const message of messages) {
    if (
      !message.sent ||
      message.timestamp < incoming.timestamp ||
      message.from !== email ||
      !message.to.includes(organizer)
    )
      continue
    for (const part of message.parts) {
      if (part.method && part.method.toUpperCase() !== 'REPLY') continue
      const answer = invitationReplyStatus(await part.read(), identity, organizer, email)
      if (answer) return answer
    }
  }
  return 'needsAction'
}

async function resolve(target: Target): Promise<Resolved | null> {
  const { api, threadId, email } = target
  const messages = await fetchThreadCalendarPayloads(api, threadId)
  const incoming = await latestIncoming(messages)
  if (!incoming) return null
  const { details, request } = incoming.invitation
  const invitation: MailInvitation = {
    ...details,
    responseStatus: null,
    canRespond: false,
    responsePending: false,
  }
  if (!request || !invitation.organizer) return { invitation, reply: null }
  const organizer = invitation.organizer.email
  if (organizer === email) {
    invitation.unavailableReason = 'You organize this event'
    return { invitation, reply: null }
  }

  const copy = await findInvitationCalendarCopy(api, { ...details.identity, organizer }, email)
  if (copy.kind === 'ambiguous') {
    invitation.unavailableReason = 'More than one Calendar event matches this invitation'
    return { invitation, reply: null }
  }
  if (copy.kind === 'found') {
    invitation.title = copy.title?.trim() || invitation.title
    invitation.start = copy.start ?? invitation.start
    invitation.end = copy.end ?? invitation.end
    if (copy.start) invitation.allDay = copy.allDay
    invitation.location = copy.location ?? invitation.location
    invitation.conferenceUrl = httpsLink(copy.conferenceUrl) ?? invitation.conferenceUrl
    invitation.htmlLink = httpsLink(copy.htmlLink) ?? invitation.htmlLink
    invitation.responseStatus = copy.responseStatus
    invitation.cancelled = copy.cancelled
    invitation.canRespond = copy.reply !== null
    invitation.unavailableReason = copy.unavailableReason
    return { invitation, reply: copy.reply ? { channel: 'calendar', send: copy.reply } : null }
  }

  if (!request.attendees.includes(email)) {
    invitation.unavailableReason =
      'This invitation does not list the connected mailbox as an attendee'
    return { invitation, reply: null }
  }
  invitation.responseStatus = await sentResponse(
    messages,
    incoming.mail,
    details.identity,
    organizer,
    email,
  )
  invitation.canRespond = true
  return {
    invitation,
    reply: {
      channel: 'gmail',
      send: (answer, validate) =>
        sendCalendarReply(
          api,
          threadId,
          incoming.mail.replyHeaders,
          email,
          organizer,
          request.reply(email, answer),
          validate,
        ),
    },
  }
}

/** Coordinates one explicit RSVP at a time per mailbox/thread, across vaults.
 * After an uncertain dispatch only reads may resolve it, never another send. */
export function createMailInvitationSession() {
  const busy = new Set<string>()
  const pending = new Map<
    string,
    { identity: MailInvitationIdentity; answer: InviteAnswer; accepted: boolean }
  >()
  const keyOf = (target: Target) => `${target.accountSub}:${target.threadId}`
  const read = async (target: Target): Promise<Resolved | null> => {
    const result = await resolve(target)
    await target.validateSession()
    if (!result) return null
    const key = keyOf(target)
    const write = pending.get(key)
    if (write) {
      const invitation = result.invitation
      if (
        !sameInvitation(write.identity, invitation.identity) ||
        invitation.cancelled ||
        invitation.responseStatus === write.answer
      ) {
        pending.delete(key)
      } else {
        invitation.canRespond = false
        invitation.responsePending = true
        invitation.unavailableReason = write.accepted
          ? 'Google accepted your response; waiting for it to appear'
          : 'The response could not be confirmed. Check its status before sending again.'
        // The write receipt carries the answer; the read model reports only
        // Calendar or Sent evidence, even when that evidence is still stale.
        result.reply = null
      }
    }
    return result
  }

  return {
    async read(target: Target): Promise<MailInvitation | null> {
      return (await read(target))?.invitation ?? null
    },
    async respond(
      target: Target,
      identity: MailInvitationIdentity,
      answer: InviteAnswer,
    ): Promise<RespondResult> {
      const key = keyOf(target)
      if (busy.has(key))
        throw new CapabilityError('CONFLICT', 'An invitation response is already in progress')
      busy.add(key)
      try {
        const current = await read(target)
        if (!current || !sameInvitation(current.invitation.identity, identity)) {
          throw new CapabilityError(
            'CONFLICT',
            'This invitation changed; reload it before responding',
          )
        }
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
        const validate = async () => {
          // Run inside the write seam, after obtaining its token. A changed
          // thread must not write; Calendar also uses the matched event's ETag.
          const newest = await latestIncoming(
            await fetchThreadCalendarPayloads(target.api, target.threadId),
          )
          if (
            !newest?.invitation.request ||
            !sameInvitation(newest.invitation.details.identity, identity)
          ) {
            throw new CapabilityError(
              'CONFLICT',
              'This invitation changed; reload it before responding',
            )
          }
        }
        try {
          await reply.send(answer, validate)
        } catch (error) {
          if (error instanceof GoogleWriteUncertainError) {
            pending.set(key, { identity, answer, accepted: false })
            return { outcome: 'uncertain', channel, answer, invitation: null, refreshPending: true }
          }
          if (error instanceof GoogleApiError && error.status === 412) {
            throw new CapabilityError(
              'CONFLICT',
              'The Calendar event changed; reload it before responding',
            )
          }
          throw error
        }
        pending.set(key, { identity, answer, accepted: true })
        // No failure after a 2xx can turn it into a failed send. Gmail may
        // accept a REPLY before it can be read back from the thread.
        const refreshed = await read(target).catch(() => null)
        return {
          outcome: 'sent',
          channel,
          answer,
          invitation: refreshed?.invitation ?? null,
          refreshPending: refreshed === null || refreshed.invitation.responsePending,
        }
      } finally {
        busy.delete(key)
      }
    },
  }
}
