import { randomUUID } from 'node:crypto'
import { CapabilityError } from '../../../main/plugin-api'
import {
  GoogleApiError,
  GoogleWriteUncertainError,
  type GoogleApi,
  type GoogleDispatchGate,
} from './api'
import type { InviteAnswer } from './calendar'
import { relevantCalendarTargets } from './mail-invitation-calendar'
import { CalendarScanError } from './gmail-mime'
import { createCalendarScan, sendCalendarReply } from './gmail-invitation-transport'
import type { MailInvitationIdentity } from './mail-invitation'
import { projectMailInvitation } from './mail-invitation-projection'
import {
  createMailInvitationReconciler,
  type InvitationFacts,
  type InvitationReadTarget,
} from './mail-invitation-reconciliation'
import { sameInvitation, scopeKey } from './mail-invitation-revisions'
import {
  knownCalendarLocators,
  type createMailInvitationStore,
  type InvitationAttempt,
} from './mail-invitation-store'

type Target = Omit<InvitationReadTarget, 'api'> & { api: GoogleApi }
type MailInvitation = ReturnType<typeof projectMailInvitation>
type Channel = InvitationAttempt['delivery']['channel']
type Reply = NonNullable<InvitationFacts['reply']>
type RespondResult = {
  /** Sent means Google accepted it, not that the organizer received it. */
  outcome: 'sent' | 'unchanged' | 'uncertain'
  channel: Channel
  answer: InviteAnswer
  invitation: MailInvitation | null
  /** Read with mailInvitation to reconcile; never repeat the write on Retry. */
  refreshPending: boolean
}

function readTarget({ api, ...binding }: Target): InvitationReadTarget {
  return { ...binding, api: { get: api.get.bind(api) } }
}

function sameWriteTarget(a: Reply, b: Reply): boolean {
  if (a.channel === 'calendar' && b.channel === 'calendar')
    return a.target === b.target && a.proof === b.proof
  return a.channel === 'gmail' && b.channel === 'gmail' && a.target === b.target
}

// Only the session decides whether a candidate is eligible for dispatch.
function canWrite(card: InvitationFacts): card is InvitationFacts & { reply: Reply } {
  return card.reply !== null && !card.responseUnverified && !card.responseFacts.pending
}

/** Resolve navigation only on the way out, never during write preflight. */
async function displayCard(card: InvitationFacts): Promise<MailInvitation> {
  const { source, responseFacts, navigation } = card
  const links = await navigation?.()
  return projectMailInvitation(
    {
      ...source,
      navigationWithheld: source.navigationWithheld || links === false,
      response: { ...responseFacts, canRespond: canWrite(card) },
    },
    links === false ? undefined : links,
  )
}

// A no-op found by final preflight must leave the gate before reservation.
// It is not a provider refusal or an uncertain dispatch.
class AlreadyRecorded extends Error {
  constructor(
    readonly result: Omit<RespondResult, 'invitation'>,
    readonly card: InvitationFacts,
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
  const { readFacts, recordGmailOutcome } = createMailInvitationReconciler(store, dispatching)

  return {
    async read(target: Target) {
      try {
        const result = await readFacts(readTarget(target), createCalendarScan())
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
      const readOnly = readTarget(target)
      const selected = async (excludeAttempt?: string) =>
        (await readFacts(readOnly, scan, identity, excludeAttempt)).cards[0]
      if (busy.has(key))
        throw new CapabilityError('CONFLICT', 'An invitation response is already in progress')
      busy.add(key)
      try {
        const current = await selected()
        target.assertBinding()
        if (!current || !sameInvitation(current.source.details.identity, identity)) throw conflict()
        const {
          source: { details },
          responseFacts,
        } = current
        const unchanged = (card: InvitationFacts): Omit<RespondResult, 'invitation'> | null => {
          const channel = card.reply?.channel ?? card.noopChannel
          if (
            !channel ||
            (card.recorded !== answer &&
              !(
                (canWrite(card) || card.noopChannel !== null) &&
                card.recorded === null &&
                card.responseFacts.status === answer
              ))
          )
            return null
          return {
            outcome: 'unchanged',
            channel,
            answer,
            refreshPending: card.responseFacts.pending || card.responseFacts.status !== answer,
          }
        }
        const recorded = unchanged(current)
        if (
          (recorded || canWrite(current)) &&
          responseFacts.targetKey !== expectedResponseTargetKey
        )
          throw conflict()
        if (recorded) return { ...recorded, invitation: await displayCard(current) }
        if (!canWrite(current))
          throw new CapabilityError(
            'FORBIDDEN',
            responseFacts.unavailableReason ?? 'This invitation cannot be answered',
          )
        const { reply } = current
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
              newest.responseFacts.targetKey !== expectedResponseTargetKey
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
              !canWrite(newest) ||
              !sameWriteTarget(newest.reply, reply) ||
              newest.reply.key !== reply.key ||
              newest.responseFacts.status !== responseFacts.status
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
              const { url, attendee, etag } = reply.patch
              await target.api.patch(
                url,
                { attendeesOmitted: true, attendees: [{ ...attendee, responseStatus: answer }] },
                { ...gate, ifMatch: etag },
              )
              // A journal/readback failure after acceptance is never a failed send.
              await store
                .changeAttempt(id, (entry) => ({ ...entry, state: 'accepted' }))
                .catch(() => null)
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
              await recordGmailOutcome(id, 'accepted', receipt)
            }
          } catch (error) {
            if (error instanceof GoogleWriteUncertainError) {
              if (channel === 'gmail') {
                // This live operation knows it received no provider locator.
                // Retry may use RFC-only evidence once this outcome is known.
                await recordGmailOutcome(id, 'unresolved', { id: null, threadId: null })
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
            await store.changeAttempt(id, () => null)
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
