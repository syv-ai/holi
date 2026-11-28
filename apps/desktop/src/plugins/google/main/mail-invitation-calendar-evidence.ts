import { closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { calendarDate, calendarInstant } from './mail-invitation-zones'

export function calendarTargetParts(target: string): [string, string] | null {
  try {
    const binding: unknown = JSON.parse(target)
    if (
      Array.isArray(binding) &&
      binding.length === 2 &&
      typeof binding[0] === 'string' &&
      typeof binding[1] === 'string'
    )
      return [binding[0], binding[1]]
  } catch {
    // Not a locator. No request may be made with this value.
  }
  return null
}

/** Existence evidence only, independent of confirmation and ETags. */
export type CalendarLocator = {
  accountSub: string
  uid: string
  recurrenceId: string | null
  target: string
  /** Unknown on sparse observations and older attempts. */
  organizer?: string
  series?: boolean
  occurrenceUnverified?: true
}

type Slot = Pick<CalendarLocator, 'recurrenceId' | 'occurrenceUnverified'>

function slot(recurrenceId: string | null): [kind: number, value: string] {
  if (recurrenceId === null) return [0, '']
  if (calendarDate(recurrenceId)) return [1, recurrenceId]
  const instant = calendarInstant(recurrenceId)
  return Number.isFinite(instant) ? [2, String(instant)] : [0, '']
}

/** Only different comparable original slots disprove overlap. A root,
 * unverifiable or floating slot, or different time basis, cannot. */
export function distinctSlots(a: string | null, b: string | null): boolean {
  const [kind, value] = slot(a)
  const [otherKind, otherValue] = slot(b)
  return kind !== 0 && kind === otherKind && value !== otherValue
}

export function calendarLocatorMayMatchScope(copy: Slot, requested: Slot): boolean {
  return (
    copy.occurrenceUnverified === true || !distinctSlots(copy.recurrenceId, requested.recurrenceId)
  )
}

export function calendarLocatorKey(locator: CalendarLocator): string {
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

type Scope = {
  accountSub: string
  email: string
  uid: string
  organizer?: string
  recurrenceId: string | null
}

export function calendarLocatorMatches(copy: CalendarLocator, scope: Scope): boolean {
  return (
    copy.accountSub === scope.accountSub &&
    copy.uid === scope.uid &&
    (copy.organizer === undefined || copy.organizer === scope.organizer) &&
    (calendarTargetParts(copy.target)?.[1] ?? scope.email) === scope.email &&
    calendarLocatorMayMatchScope(copy, scope)
  )
}

export const MAX_CALENDAR_LOCATORS = 4096
export const CALENDAR_RESOURCE_BUDGET = 32

export class CalendarEvidenceStoreError extends Error {
  readonly code = 'EVIDENCE_STORE_FAILURE'

  constructor(cause: unknown) {
    super('Could not read or retain Calendar invitation evidence', { cause })
  }
}

// Encode provider strings losslessly, including embedded NULs and lone UTF-16
// surrogates. Empty indexes below denote unknown, never a provider string.
const indexText = (value: string | undefined) => (value === undefined ? '' : JSON.stringify(value))

/** Machine evidence, not a provider cache. Never reset this file on failure.
 * The retained history is capped per account; the footprint table grows by one
 * small row per distinct lost scope, with no eviction. Lookups only ask whether
 * a footprint exists, never materialize that history. */
export function createCalendarEvidence(filename: string) {
  let connection: DatabaseSync | undefined

  function open(create: boolean) {
    if (connection) return connection
    const stat = statSync(filename, { throwIfNoEntry: false })
    if (!stat && !create) return undefined
    if (!stat) {
      mkdirSync(dirname(filename), { recursive: true })
      closeSync(openSync(filename, 'wx', 0o600))
    }
    const db = new DatabaseSync(filename)
    try {
      if (!stat) {
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          BEGIN;
          CREATE TABLE locators (
            account TEXT NOT NULL, key TEXT NOT NULL, mailbox TEXT NOT NULL,
            uid TEXT NOT NULL, organizer TEXT NOT NULL, kind INTEGER NOT NULL,
            slot TEXT NOT NULL, occurrence INTEGER NOT NULL, target TEXT NOT NULL,
            PRIMARY KEY (account, key)
          ) STRICT, WITHOUT ROWID;
          CREATE INDEX locator_scope ON locators (account, mailbox, uid, organizer);
          CREATE TABLE footprints (
            account TEXT NOT NULL, mailbox TEXT NOT NULL, uid TEXT NOT NULL,
            organizer TEXT NOT NULL, kind INTEGER NOT NULL, slot TEXT NOT NULL,
            occurrence INTEGER NOT NULL,
            PRIMARY KEY (account, mailbox, uid, organizer, kind, slot)
          ) STRICT, WITHOUT ROWID;
          CREATE INDEX footprint_occurrence ON footprints (account, mailbox, uid, organizer, kind, slot)
            WHERE occurrence = 1;
          PRAGMA user_version = 1;
          COMMIT;
        `)
      } else {
        db.exec('PRAGMA synchronous = FULL')
        if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
          throw new Error('Invalid Calendar evidence database version')
      }
      connection = db
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  function evidence<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      throw new CalendarEvidenceStoreError(error)
    }
  }

  return {
    // Releasing the file handle is not retirement of the process-owned
    // invitation session. Other vaults may reopen it with the same evidence.
    close() {
      connection?.close()
      connection = undefined
    },
    remember(
      locator: CalendarLocator,
      legacyKeys: ReadonlySet<string> | undefined,
      keepInJournalIfFull: boolean,
    ): boolean {
      const key = calendarLocatorKey(locator)
      if (legacyKeys?.has(key)) return true
      return evidence(() => {
        const db = open(true)!
        const account = indexText(locator.accountSub)
        const mailbox = indexText(calendarTargetParts(locator.target)?.[1])
        const uid = indexText(locator.uid)
        const organizer = indexText(locator.organizer)
        const [kind, value] = slot(locator.recurrenceId)
        const occurrence = locator.recurrenceId !== null || locator.occurrenceUnverified ? 1 : 0
        db.exec('BEGIN IMMEDIATE')
        try {
          const retained = db
            .prepare('SELECT 1 FROM locators WHERE account = ? AND key = ?')
            .get(account, key)
          const space =
            !retained &&
            Number(
              db.prepare('SELECT count(*) AS n FROM locators WHERE account = ?').get(account)?.n,
            ) +
              (legacyKeys?.size ?? 0) <
              MAX_CALENDAR_LOCATORS
          if (space) {
            db.prepare('INSERT INTO locators VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
              account,
              key,
              mailbox,
              uid,
              organizer,
              kind,
              value,
              occurrence,
              JSON.stringify(locator.target),
            )
          } else if (!retained && !keepInJournalIfFull) {
            db.prepare(
              `
              INSERT INTO footprints VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT DO UPDATE SET occurrence = 1
              WHERE excluded.occurrence = 1 AND footprints.occurrence = 0
            `,
            ).run(account, mailbox, uid, organizer, kind, value, occurrence)
          }
          db.exec('COMMIT')
          return Boolean(retained || space)
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK')
          throw error
        }
      })
    },
    lookup(scope: Scope, targets: Set<string>, occurrencesOnly: boolean): boolean {
      return evidence(() => {
        const db = open(false)
        if (!db) return false
        const [kind, value] = slot(scope.recurrenceId)
        const select = db.prepare(`
          SELECT DISTINCT target FROM locators
          WHERE account = ? AND mailbox = ? AND uid = ? AND organizer = ?
            AND (? = 0 OR occurrence = 1) AND (? = 0 OR kind <> ? OR slot = ?)
          LIMIT ${CALENDAR_RESOURCE_BUDGET + 1}
        `)
        const footprintScope = `account = ? AND mailbox = ? AND uid = ? AND organizer = ?${
          occurrencesOnly ? ' AND occurrence = 1' : ''
        }`
        const anySlot = db.prepare(`SELECT 1 FROM footprints WHERE ${footprintScope} LIMIT 1`)
        const slotKind = db.prepare(
          `SELECT 1 FROM footprints WHERE ${footprintScope} AND kind = ? LIMIT 1`,
        )
        const exactSlot = db.prepare(
          `SELECT 1 FROM footprints WHERE ${footprintScope} AND kind = ? AND slot = ?`,
        )
        let incomplete = false
        for (const mailbox of ['', indexText(scope.email)]) {
          const organizers = scope.organizer === undefined ? [''] : ['', indexText(scope.organizer)]
          for (const organizer of organizers) {
            const prefix = [indexText(scope.accountSub), mailbox, indexText(scope.uid), organizer]
            for (const row of select.iterate(
              ...prefix,
              occurrencesOnly ? 1 : 0,
              kind,
              kind,
              value,
            )) {
              const target: unknown = JSON.parse(String(row.target))
              if (typeof target !== 'string') throw new Error('Invalid Calendar evidence target')
              if (targets.has(target)) continue
              if (targets.size < CALENDAR_RESOURCE_BUDGET) targets.add(target)
              else incomplete = true
            }
            // These are prefix existence checks or a point lookup, even when
            // one UID has a large history of distinct comparable slots.
            if (!incomplete) {
              incomplete = Boolean(
                kind === 0
                  ? anySlot.get(...prefix)
                  : exactSlot.get(...prefix, kind, value) ||
                      slotKind.get(...prefix, 0) ||
                      slotKind.get(...prefix, kind === 1 ? 2 : 1),
              )
            }
          }
        }
        return incomplete
      })
    },
  }
}
