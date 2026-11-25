import { join } from 'node:path'
import { CapabilityError, jsonFileStore } from '../../../main/plugin-api'
import type { InviteAnswer } from './calendar'
import type { CalendarReplyReceipt } from './gmail-invitation-transport'
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
  | {
      channel: 'calendar'
      target: string
      proof?: string
      priorSent?: SentEvidence | null
      organizer?: string
      series?: boolean
    }
  | {
      channel: 'gmail'
      rfcId: string
      parent: string
      organizer: string
      mailbox: string
      priorSentTimestamp?: number
      /** Verified provider order, not proof that the parent still belongs to this invitation. */
      confirmedSentTimestamp?: number
      /** Null means the dispatch outcome is unknown. An observed no-ID
       * outcome is a receipt object with null locator fields. */
      receipt: CalendarReplyReceipt | null
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
  /** Legacy anchors without a receipt locator cannot provide independent proof. */
  reply?: { rfcId: string; messageId: string; threadId?: string | null; answer?: InviteAnswer }
}

/** Existence evidence only, retained independently of confirmation and ETags. */
export type CalendarLocator = Pick<Revision, 'uid' | 'recurrenceId'> & {
  accountSub: string
  target: string
  /** Not recorded by older Calendar attempts. */
  organizer?: string
  series?: boolean
  /** The event identified an occurrence but its original slot was unverifiable. */
  occurrenceUnverified?: true
}

type Journal = {
  version: 1
  attempts: InvitationAttempt[]
  parentAnchors: ParentAnchor[]
  calendarLocators: CalendarLocator[]
  calendarLocatorOverflow: boolean
}
const MAX_PARENT_ANCHORS = 4096
const MAX_CALENDAR_LOCATORS = 4096

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
    text(value.mailbox) &&
    (value.reply === undefined ||
      (record(value.reply) &&
        text(value.reply.rfcId) &&
        text(value.reply.messageId) &&
        (value.reply.threadId === undefined || nullableText(value.reply.threadId)) &&
        (value.reply.answer === undefined ||
          value.reply.answer === 'accepted' ||
          value.reply.answer === 'tentative' ||
          value.reply.answer === 'declined')))
  )
}

function validCalendarScope(value: Record<string, unknown>): boolean {
  return (
    (value.organizer === undefined || text(value.organizer)) &&
    (value.series === undefined || typeof value.series === 'boolean')
  )
}

function isCalendarLocator(value: unknown): value is CalendarLocator {
  return (
    record(value) &&
    text(value.accountSub) &&
    text(value.target) &&
    text(value.uid) &&
    nullableText(value.recurrenceId) &&
    (value.occurrenceUnverified === undefined ||
      (value.occurrenceUnverified === true && value.recurrenceId === null)) &&
    validCalendarScope(value)
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
      validCalendarScope(delivery) &&
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
    (delivery.confirmedSentTimestamp === undefined ||
      (typeof delivery.confirmedSentTimestamp === 'number' &&
        Number.isSafeInteger(delivery.confirmedSentTimestamp) &&
        delivery.confirmedSentTimestamp > 0)) &&
    (receipt === null ||
      (record(receipt) &&
        nullableText(receipt.id) &&
        nullableText(receipt.threadId) &&
        (receipt.invalidLocator === undefined || receipt.invalidLocator === true)))
  )
}

function verifyJournal(raw: unknown): Journal {
  const parentAnchors = record(raw) && raw.parentAnchors !== undefined ? raw.parentAnchors : []
  const calendarLocators =
    record(raw) && raw.calendarLocators !== undefined ? raw.calendarLocators : []
  const calendarLocatorOverflow =
    record(raw) && raw.calendarLocatorOverflow !== undefined ? raw.calendarLocatorOverflow : false
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !Array.isArray(raw.attempts) ||
    !raw.attempts.every(isAttempt) ||
    new Set(raw.attempts.map(({ id }) => id)).size !== raw.attempts.length ||
    !Array.isArray(parentAnchors) ||
    parentAnchors.length > MAX_PARENT_ANCHORS ||
    !parentAnchors.every(isParentAnchor) ||
    !Array.isArray(calendarLocators) ||
    calendarLocators.length > MAX_CALENDAR_LOCATORS ||
    !calendarLocators.every(isCalendarLocator) ||
    typeof calendarLocatorOverflow !== 'boolean'
  ) {
    throw new Error('The mail invitation response journal is invalid; no response can be sent')
  }
  return {
    version: 1,
    attempts: raw.attempts,
    parentAnchors,
    calendarLocators,
    calendarLocatorOverflow,
  }
}

function calendarLocatorFor({
  accountSub,
  revision,
  delivery,
}: InvitationAttempt): CalendarLocator | null {
  if (delivery.channel !== 'calendar') return null
  const { uid, recurrenceId } = revision
  const { target, organizer, series } = delivery
  return { accountSub, uid, recurrenceId, target, organizer, series }
}

function calendarLocatorKey(locator: CalendarLocator): string {
  const { accountSub, uid, recurrenceId, target, organizer, series, occurrenceUnverified } = locator
  return JSON.stringify([
    accountSub,
    organizer,
    uid,
    recurrenceId,
    series,
    target,
    occurrenceUnverified,
  ])
}

/** Legacy attempts can contribute locators before they have been compacted. */
export function knownCalendarLocators({ attempts, calendarLocators }: Journal): CalendarLocator[] {
  return [
    ...calendarLocators,
    ...attempts.flatMap((attempt) => {
      const locator = attempt.state !== 'prepared' && calendarLocatorFor(attempt)
      return locator ? [locator] : []
    }),
  ]
}

function anchorFor({ accountSub, revision, delivery, answer }: InvitationAttempt): ParentAnchor[] {
  if (delivery.channel !== 'gmail') return []
  const { parent, organizer, mailbox, receipt, rfcId } = delivery
  const reply = receipt?.id
    ? { rfcId, messageId: receipt.id, threadId: receipt.threadId, answer }
    : undefined
  return [{ accountSub, revision, parent, organizer, mailbox, reply }]
}

function anchorKey(
  { accountSub, revision, parent, organizer, mailbox, reply }: ParentAnchor,
  dispatchRfcId = reply?.rfcId,
): string {
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
    // Separate replies to the same REQUEST still have separate dispatch identities.
    dispatchRfcId,
  ])
}

/** An unreadable journal is not an empty journal: losing an attempt can send
 * another response. Store only correlation, never tokens or message bodies. */
export function createMailInvitationStore(userData: string) {
  const store = jsonFileStore<Journal>(
    join(userData, 'google-mail-invitations.json'),
    (raw, source) =>
      source === null
        ? {
            version: 1,
            attempts: [],
            parentAnchors: [],
            calendarLocators: [],
            calendarLocatorOverflow: false,
          }
        : verifyJournal(raw),
    { mode: 0o600 },
  )
  const update = (change: (journal: Journal) => Journal) =>
    store.update((journal) => verifyJournal(change(journal)))
  return {
    read: store.read,
    update,
    async rememberCalendarLocator(locator: CalendarLocator, assertBinding: () => void) {
      assertBinding()
      const key = calendarLocatorKey(locator)
      const alreadyRetained = (journal: Journal) =>
        journal.calendarLocatorOverflow ||
        journal.calendarLocators.some((entry) => calendarLocatorKey(entry) === key)
      if (!alreadyRetained(await store.read()))
        await store.update(
          (journal) => {
            if (alreadyRetained(journal)) return journal
            // A full registry is not absence. Do not silently forget a copy.
            return verifyJournal(
              journal.calendarLocators.length >= MAX_CALENDAR_LOCATORS
                ? { ...journal, calendarLocatorOverflow: true }
                : { ...journal, calendarLocators: [...journal.calendarLocators, locator] },
            )
          },
          undefined,
          () => {
            assertBinding()
            return true
          },
        )
      assertBinding()
    },
    addAttempt: (attempt: InvitationAttempt) =>
      update((journal) => {
        const attempts = [...journal.attempts, attempt]
        // Reserve space even for an uncertain Gmail write: its later confirmation
        // must not evict an older parent or become impossible to record.
        const keys = new Set([
          ...journal.parentAnchors.map((anchor) => anchorKey(anchor)),
          ...attempts.flatMap((entry) => {
            const { delivery } = entry
            return delivery.channel === 'gmail'
              ? anchorFor(entry).map((anchor) => anchorKey(anchor, delivery.rfcId))
              : []
          }),
        ])
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
      provesAnchor: (attempt: InvitationAttempt) => boolean,
    ) =>
      update((journal) => {
        const index = journal.attempts.findIndex(({ id }) => id === confirmed.id)
        if (index < 0) return journal
        const anchors = new Map(journal.parentAnchors.map((anchor) => [anchorKey(anchor), anchor]))
        const locators = new Map(
          journal.calendarLocators.map((entry) => [calendarLocatorKey(entry), entry]),
        )
        const retain = (attempt: InvitationAttempt) => {
          if (provesAnchor(attempt))
            for (const anchor of anchorFor(attempt)) anchors.set(anchorKey(anchor), anchor)
        }
        const attempts = journal.attempts.flatMap((entry, prior) => {
          if (prior === index) return confirmed
          if (prior < index && entry.state === 'confirmed' && replaces(entry)) {
            // Compact old answers only when their independent evidence survives.
            const locator = calendarLocatorFor(entry)
            if (locator) {
              const key = calendarLocatorKey(locator)
              if (!locators.has(key) && locators.size >= MAX_CALENDAR_LOCATORS) return entry
              locators.set(key, locator)
            }
            retain(entry)
            return []
          }
          return entry
        })
        retain(confirmed)
        return {
          ...journal,
          attempts,
          parentAnchors: [...anchors.values()],
          calendarLocators: [...locators.values()],
        }
      }),
  }
}
