import { join } from 'node:path'
import { CapabilityError, jsonFileStore } from '../../../main/plugin-api'
import type { InviteAnswer } from './calendar'
import type { CalendarReplyReceipt } from './gmail-invitation-transport'
import type { MailInvitationIdentity } from './mail-invitation'
import {
  calendarLocatorKey,
  calendarLocatorMatches,
  CalendarEvidenceStoreError,
  CALENDAR_RESOURCE_BUDGET,
  createCalendarEvidence,
  MAX_CALENDAR_LOCATORS,
  type CalendarLocator,
} from './mail-invitation-calendar-evidence'

type Revision = Omit<MailInvitationIdentity, 'messageId'> & {
  /** Absent on journals written before mailbox response was separate from event material. */
  mailboxResponse?: {
    responseStatus: 'needsAction' | 'delegated' | InviteAnswer
    rsvp: boolean | null
  } | null
}

const calendarMaterialFields = [
  'attendees',
  'exceptions',
  'title',
  'status',
  'location',
  'description',
  'descriptionConference',
  'conference',
  'htmlLink',
  'start',
  'end',
] as const

/** Comparison inputs from the REQUEST, not a Calendar observation or a reply receipt. */
export type CalendarMaterialEvidence = { version: 1 } & Record<
  (typeof calendarMaterialFields)[number],
  string
>

/** Negative source evidence only. An absent digest is a legacy source whose
 * material cannot be reconstructed from its opaque revision key. */
export type CalendarMaterialSource = {
  accountSub: string
  mailbox: string
  organizer?: string
  revision: Revision
  evidence?: CalendarMaterialEvidence
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
  /** Absent on older attempts. No message text or guest addresses are stored here. */
  calendarMaterial?: CalendarMaterialEvidence
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

type Journal = {
  version: 2
  materialHistory: CalendarMaterialSource[]
  attempts: InvitationAttempt[]
  parentAnchors: ParentAnchor[]
  calendarLocators: CalendarLocator[]
  calendarLocatorOverflow: boolean
}
const MAX_MATERIAL_HISTORY = 4096
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

function validCalendarMaterial(value: unknown): boolean {
  return (
    record(value) &&
    value.version === 1 &&
    calendarMaterialFields.every((field) => {
      const digest = value[field]
      return typeof digest === 'string' && digest.length === 64 && /^[0-9a-f]+$/.test(digest)
    })
  )
}

function isMaterialSource(value: unknown): value is CalendarMaterialSource {
  return (
    record(value) &&
    text(value.accountSub) &&
    text(value.mailbox) &&
    (value.organizer === undefined || text(value.organizer)) &&
    validRevision(value.revision) &&
    (value.evidence === undefined || validCalendarMaterial(value.evidence))
  )
}

function isAttempt(value: unknown): value is InvitationAttempt {
  if (!record(value)) return false
  const { id, accountSub, threadId, revision, calendarMaterial, answer, state, delivery } = value
  if (
    !text(id) ||
    !text(accountSub) ||
    !text(threadId) ||
    !validRevision(revision) ||
    (calendarMaterial !== undefined && !validCalendarMaterial(calendarMaterial)) ||
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
      (calendarMaterial === undefined || text(delivery.organizer)) &&
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
  // Legacy attempts and anchors remain available to reconciliation. A current
  // journal missing its material history is damaged, not a legacy journal.
  const materialHistory = record(raw) && raw.version === 1 ? [] : record(raw) && raw.materialHistory
  if (
    !record(raw) ||
    (raw.version !== 1 && raw.version !== 2) ||
    !Array.isArray(materialHistory) ||
    materialHistory.length > MAX_MATERIAL_HISTORY ||
    !materialHistory.every(isMaterialSource) ||
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
    version: 2,
    materialHistory,
    attempts: raw.attempts,
    parentAnchors,
    calendarLocators,
    calendarLocatorOverflow,
  }
}

export function materialSourceForAttempt(
  attempt: InvitationAttempt,
  mailbox: string,
): CalendarMaterialSource {
  const { accountSub, delivery, revision, calendarMaterial: evidence } = attempt
  const { uid, recurrenceId, sequence, dtstamp, materialKey } = revision
  return {
    accountSub,
    mailbox,
    organizer: delivery.organizer,
    revision: {
      uid,
      recurrenceId,
      sequence,
      dtstamp,
      materialKey,
      ...(evidence ? {} : { mailboxResponse: revision.mailboxResponse }),
    },
    evidence,
  }
}

export function materialSourceKey(
  { accountSub, mailbox, organizer, revision, evidence }: CalendarMaterialSource,
  includeEvidence = true,
): string {
  const { uid, recurrenceId, sequence, dtstamp, materialKey } = revision
  return JSON.stringify([
    accountSub,
    mailbox,
    organizer,
    uid,
    recurrenceId,
    sequence,
    dtstamp,
    materialKey,
    includeEvidence && evidence ? calendarMaterialFields.map((field) => evidence[field]) : null,
  ])
}

/** A full registry cannot silently forget comparisons to make room for a write. */
export function retainMaterialSources(
  journal: Journal,
  sources: CalendarMaterialSource[],
): Journal {
  if (!sources.length) return journal
  const retained = new Map(
    journal.materialHistory.map((source) => [materialSourceKey(source), source]),
  )
  for (const source of sources) retained.set(materialSourceKey(source), source)
  if (retained.size > MAX_MATERIAL_HISTORY)
    throw new CapabilityError(
      'FORBIDDEN',
      'The invitation journal cannot retain more revision evidence',
    )
  return { ...journal, materialHistory: [...retained.values()] }
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
            version: 2,
            materialHistory: [],
            attempts: [],
            parentAnchors: [],
            calendarLocators: [],
            calendarLocatorOverflow: false,
          }
        : verifyJournal(raw),
    { mode: 0o600 },
  )
  const evidence = createCalendarEvidence(join(userData, 'google-mail-invitation-calendar.db'))
  // Older versions retained these exact locators in the journal. New writes
  // leave them intact; count their distinct keys against the same account cap.
  let legacyKeys: Map<string, Set<string>> | undefined
  const initLegacy = (journal: Journal) => {
    if (legacyKeys === undefined) {
      legacyKeys = new Map()
      for (const locator of journal.calendarLocators) {
        const keys = legacyKeys.get(locator.accountSub) ?? new Set<string>()
        keys.add(calendarLocatorKey(locator))
        legacyKeys.set(locator.accountSub, keys)
      }
    }
    return journal
  }
  const update = (change: (journal: Journal) => Journal, publishOwned?: () => boolean) =>
    store.update((journal) => verifyJournal(change(initLegacy(journal))), undefined, publishOwned)
  function retainLocator(locator: CalendarLocator, keepInJournalIfFull = false) {
    if (!isCalendarLocator(locator)) throw new Error('Invalid Calendar invitation locator')
    return evidence.remember(locator, legacyKeys?.get(locator.accountSub), keepInJournalIfFull)
  }
  return {
    read: async () => initLegacy(await store.read()),
    update,
    close: evidence.close,
    lookupCalendarEvidence(
      journal: Journal,
      target: { accountSub: string; email: string },
      details: {
        identity: Pick<Revision, 'uid' | 'recurrenceId'>
        organizer?: { email: string } | null
      },
      occurrencesOnly = false,
    ) {
      const { uid, recurrenceId } = details.identity
      const scope = { ...target, uid, recurrenceId, organizer: details.organizer?.email }
      const targets = new Set<string>()
      // A v2 overflow bit has no trustworthy attribution. Keep it as global
      // uncertainty, but never create it for a new observation.
      let incomplete = !occurrencesOnly && journal.calendarLocatorOverflow
      const include = (copy: CalendarLocator) => {
        if (
          (occurrencesOnly && copy.recurrenceId === null && !copy.occurrenceUnverified) ||
          !calendarLocatorMatches(copy, scope) ||
          targets.has(copy.target)
        )
          return
        if (targets.size < CALENDAR_RESOURCE_BUDGET) targets.add(copy.target)
        else incomplete = true
      }
      for (const copy of journal.calendarLocators) include(copy)
      for (const attempt of journal.attempts) {
        const copy = attempt.state !== 'prepared' && calendarLocatorFor(attempt)
        if (copy) include(copy)
      }
      const indexedIncomplete = evidence.lookup(scope, targets, occurrencesOnly)
      return { targets, incomplete: incomplete || indexedIncomplete }
    },
    changeAttempt: (id: string, change: (attempt: InvitationAttempt) => InvitationAttempt | null) =>
      update((journal) => ({
        ...journal,
        attempts: journal.attempts.flatMap((attempt) => {
          if (attempt.id !== id) return attempt
          const changed = change(attempt)
          if (!changed && attempt.state !== 'prepared') {
            const locator = calendarLocatorFor(attempt)
            if (locator) retainLocator(locator)
          }
          return changed ?? []
        }),
      })),
    async rememberCalendarLocator(locator: CalendarLocator, assertBinding: () => void) {
      assertBinding()
      // Provider reads (including deferred Join) can outlive the journal
      // snapshot. Validate the current journal even when legacy keys are loaded.
      const journal = await store.read().catch((cause) => {
        throw new CalendarEvidenceStoreError(cause)
      })
      initLegacy(journal)
      assertBinding()
      retainLocator(locator)
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
      mailbox: string,
    ) =>
      update((journal) => {
        const index = journal.attempts.findIndex(({ id }) => id === confirmed.id)
        if (index < 0) return journal
        const anchors = new Map(journal.parentAnchors.map((anchor) => [anchorKey(anchor), anchor]))
        const materials = new Map(
          journal.materialHistory.map((source) => [materialSourceKey(source), source]),
        )
        const confirmedLocator = calendarLocatorFor(confirmed)
        const confirmedLocatorKey = confirmedLocator && calendarLocatorKey(confirmedLocator)
        const retain = (attempt: InvitationAttempt) => {
          if (provesAnchor(attempt))
            for (const anchor of anchorFor(attempt)) anchors.set(anchorKey(anchor), anchor)
        }
        const attempts = journal.attempts.flatMap((entry, prior) => {
          if (prior === index) return confirmed
          if (prior < index && entry.state === 'confirmed' && replaces(entry)) {
            // Compact old answers only when their independent evidence survives.
            const source = materialSourceForAttempt(entry, mailbox)
            const key = materialSourceKey(source)
            if (!materials.has(key) && materials.size >= MAX_MATERIAL_HISTORY) return entry
            const locator = calendarLocatorFor(entry)
            // The replacement may already retain the same exact locator.
            // Otherwise commit it first, or leave the old entry at capacity.
            if (
              locator &&
              calendarLocatorKey(locator) !== confirmedLocatorKey &&
              !retainLocator(locator, true)
            )
              return entry
            materials.set(key, source)
            retain(entry)
            return []
          }
          return entry
        })
        retain(confirmed)
        return {
          ...journal,
          attempts,
          materialHistory: [...materials.values()],
          parentAnchors: [...anchors.values()],
        }
      }),
  }
}
