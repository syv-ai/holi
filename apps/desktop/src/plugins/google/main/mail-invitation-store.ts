import { join } from 'node:path'
import { CapabilityError, jsonFileStore } from '../../../main/plugin-api'
import type { InviteAnswer } from './calendar'
import type { MailInvitationIdentity } from './mail-invitation'

type Revision = Omit<MailInvitationIdentity, 'messageId'> & {
  /** Absent on journals written before mailbox response was separate from event material. */
  mailboxResponse?: {
    responseStatus: 'needsAction' | 'delegated' | InviteAnswer
    rsvp: boolean | null
  } | null
}

export type SentEvidence = { timestamp: number; messageIds: string[]; answer: InviteAnswer | null }

type Delivery =
  | { channel: 'calendar'; target: string; proof?: string; priorSent?: SentEvidence | null }
  | {
      channel: 'gmail'
      rfcId: string
      parent: string
      organizer: string
      mailbox: string
      priorSentTimestamp?: number
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

/** Correlation proven by a confirmed Gmail REPLY, independent of the latest answer. */
export type ParentAnchor = {
  accountSub: string
  revision: Revision
  parent: string
  organizer: string
  mailbox: string
}

type Journal = { version: 1; attempts: InvitationAttempt[]; parentAnchors: ParentAnchor[] }
const MAX_PARENT_ANCHORS = 4096

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value)
}

function nullableText(value: unknown): boolean {
  return value === null || text(value)
}

function validMailboxResponse(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (record(value) &&
      (value.responseStatus === 'needsAction' ||
        value.responseStatus === 'delegated' ||
        value.responseStatus === 'accepted' ||
        value.responseStatus === 'tentative' ||
        value.responseStatus === 'declined') &&
      (value.rsvp === null || typeof value.rsvp === 'boolean'))
  )
}

function validSentEvidence(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (record(value) &&
      Number.isSafeInteger(value.timestamp) &&
      (value.answer === null ||
        value.answer === 'accepted' ||
        value.answer === 'tentative' ||
        value.answer === 'declined') &&
      Array.isArray(value.messageIds) &&
      value.messageIds.length > 0 &&
      value.messageIds.length <= 32 &&
      value.messageIds.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id)))
  )
}

function validRevision(value: unknown): value is Revision {
  return (
    record(value) &&
    text(value.uid) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    nullableText(value.recurrenceId) &&
    nullableText(value.dtstamp) &&
    text(value.materialKey) &&
    validMailboxResponse(value.mailboxResponse)
  )
}

function isParentAnchor(value: unknown): value is ParentAnchor {
  return (
    record(value) &&
    text(value.accountSub) &&
    validRevision(value.revision) &&
    text(value.parent) &&
    text(value.organizer) &&
    text(value.mailbox)
  )
}

function isAttempt(value: unknown): value is InvitationAttempt {
  if (!record(value)) return false
  const { id, accountSub, threadId, revision, answer, state, delivery } = value
  if (
    !text(id) ||
    !text(accountSub) ||
    !text(threadId) ||
    !validRevision(revision) ||
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
      text(delivery.target) &&
      validSentEvidence(delivery.priorSent) &&
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
    (delivery.priorSentTimestamp === undefined ||
      (typeof delivery.priorSentTimestamp === 'number' &&
        Number.isSafeInteger(delivery.priorSentTimestamp) &&
        delivery.priorSentTimestamp >= 0)) &&
    (receipt === null ||
      (record(receipt) && nullableText(receipt.id) && nullableText(receipt.threadId)))
  )
}

function verifyJournal(raw: unknown): Journal {
  const parentAnchors = record(raw) && raw.parentAnchors !== undefined ? raw.parentAnchors : []
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !Array.isArray(raw.attempts) ||
    !raw.attempts.every(isAttempt) ||
    new Set(raw.attempts.map(({ id }) => id)).size !== raw.attempts.length ||
    !Array.isArray(parentAnchors) ||
    parentAnchors.length > MAX_PARENT_ANCHORS ||
    !parentAnchors.every(isParentAnchor)
  ) {
    throw new Error('The mail invitation response journal is invalid; no response can be sent')
  }
  return { version: 1, attempts: raw.attempts, parentAnchors }
}

function anchorFor({ accountSub, revision, delivery }: InvitationAttempt): ParentAnchor[] {
  if (delivery.channel !== 'gmail') return []
  const { parent, organizer, mailbox } = delivery
  return [{ accountSub, revision, parent, organizer, mailbox }]
}

function anchorKey({ accountSub, revision, parent, organizer, mailbox }: ParentAnchor): string {
  const { uid, recurrenceId, sequence, dtstamp, materialKey, mailboxResponse } = revision
  return JSON.stringify([
    accountSub,
    mailbox,
    organizer,
    uid,
    recurrenceId,
    sequence,
    dtstamp,
    materialKey,
    parent,
    mailboxResponse === undefined ? [] : [mailboxResponse?.responseStatus, mailboxResponse?.rsvp],
  ])
}

/** An unreadable journal is not an empty journal: losing an attempt can send
 * another response. Store only correlation, never tokens or message bodies. */
export function createMailInvitationStore(userData: string) {
  const store = jsonFileStore<Journal>(
    join(userData, 'google-mail-invitations.json'),
    (raw, source) =>
      source === null ? { version: 1, attempts: [], parentAnchors: [] } : verifyJournal(raw),
    { mode: 0o600 },
  )
  const update = (change: (journal: Journal) => Journal) =>
    store.update((journal) => verifyJournal(change(journal)))
  return {
    read: store.read,
    update,
    addAttempt: (attempt: InvitationAttempt) =>
      update((journal) => {
        const attempts = [...journal.attempts, attempt]
        // Reserve space even for an uncertain Gmail write: its later confirmation
        // must not evict an older parent or become impossible to record.
        const keys = new Set(
          [...journal.parentAnchors, ...attempts.flatMap(anchorFor)].map(anchorKey),
        )
        if (keys.size > MAX_PARENT_ANCHORS)
          throw new CapabilityError(
            'FORBIDDEN',
            'The invitation response journal cannot retain more reply evidence',
          )
        return { ...journal, attempts }
      }),
    confirmAttempt: (
      confirmed: InvitationAttempt,
      replaces: (prior: InvitationAttempt) => boolean,
    ) =>
      update((journal) => {
        const index = journal.attempts.findIndex(({ id }) => id === confirmed.id)
        if (index < 0) return journal
        const anchors = new Map(journal.parentAnchors.map((anchor) => [anchorKey(anchor), anchor]))
        const retain = (attempt: InvitationAttempt) => {
          for (const anchor of anchorFor(attempt)) anchors.set(anchorKey(anchor), anchor)
        }
        retain(confirmed)
        const attempts = journal.attempts.flatMap((entry, prior) => {
          if (prior === index) return confirmed
          if (prior < index && entry.state === 'confirmed' && replaces(entry)) {
            // Also migrate older confirmed Gmail receipts before dropping them.
            retain(entry)
            return []
          }
          return entry
        })
        return { ...journal, attempts, parentAnchors: [...anchors.values()] }
      }),
  }
}
