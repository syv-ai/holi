import { join } from 'node:path'
import { jsonFileStore } from '../../../main/plugin-api'
import type { InviteAnswer } from './calendar'
import type { MailInvitationIdentity } from './mail-invitation'

type Revision = Omit<MailInvitationIdentity, 'messageId'>

type Delivery =
  | { channel: 'calendar'; target: string; proof?: string }
  | {
      channel: 'gmail'
      rfcId: string
      parent: string
      organizer: string
      mailbox: string
      receipt: { id: string | null; threadId: string | null } | null
    }

export type InvitationAttempt = {
  id: string
  accountSub: string
  threadId: string
  revision: Revision
  answer: InviteAnswer
  state: 'prepared' | 'unresolved' | 'accepted' | 'confirmed'
  delivery: Delivery
}

type Journal = { version: 1; attempts: InvitationAttempt[] }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value)
}

function nullableText(value: unknown): boolean {
  return value === null || text(value)
}

function isAttempt(value: unknown): value is InvitationAttempt {
  if (!record(value)) return false
  const { id, accountSub, threadId, revision, answer, state, delivery } = value
  if (
    !text(id) ||
    !text(accountSub) ||
    !text(threadId) ||
    !record(revision) ||
    !text(revision.uid) ||
    typeof revision.sequence !== 'number' ||
    !Number.isSafeInteger(revision.sequence) ||
    revision.sequence < 0 ||
    !nullableText(revision.recurrenceId) ||
    !nullableText(revision.dtstamp) ||
    !text(revision.materialKey) ||
    (answer !== 'accepted' && answer !== 'tentative' && answer !== 'declined') ||
    (state !== 'prepared' &&
      state !== 'unresolved' &&
      state !== 'accepted' &&
      state !== 'confirmed') ||
    !record(delivery)
  ) {
    return false
  }
  if (delivery.channel === 'calendar')
    return (
      state !== 'confirmed' &&
      text(delivery.target) &&
      (delivery.proof === undefined ||
        (typeof delivery.proof === 'string' && /^[0-9a-f]{64}$/.test(delivery.proof)))
    )
  if (delivery.channel !== 'gmail') return false
  const { rfcId, parent, mailbox, organizer, receipt } = delivery
  return (
    text(rfcId) &&
    rfcId === `<${id}@holi.invalid>` &&
    text(parent) &&
    text(mailbox) &&
    text(organizer) &&
    (receipt === null ||
      (record(receipt) && nullableText(receipt.id) && nullableText(receipt.threadId)))
  )
}

function verifyJournal(raw: unknown): Journal {
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !Array.isArray(raw.attempts) ||
    !raw.attempts.every(isAttempt) ||
    new Set(raw.attempts.map(({ id }) => id)).size !== raw.attempts.length
  ) {
    throw new Error('The mail invitation response journal is invalid; no response can be sent')
  }
  return { version: 1, attempts: raw.attempts }
}

/** An unreadable journal is not an empty journal: losing an attempt can send
 * another response. Store only correlation, never tokens or message bodies. */
export function createMailInvitationStore(userData: string) {
  const store = jsonFileStore<Journal>(
    join(userData, 'google-mail-invitations.json'),
    (raw, source) => (source === null ? { version: 1, attempts: [] } : verifyJournal(raw)),
    { mode: 0o600 },
  )
  return {
    read: store.read,
    update: (change: (journal: Journal) => Journal) =>
      store.update((journal) => verifyJournal(change(journal))),
  }
}
