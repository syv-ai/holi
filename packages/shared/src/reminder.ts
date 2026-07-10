/**
 * Reminder parsing, resolution and the pending rule — pure functions, ported
 * from the old Rust `services/reminder.rs` (D19). A reminder is one of:
 *
 *  - Absolute local datetime `2026-06-14T18:00` (seconds optional, no
 *    timezone — wall-clock naive).
 *  - Relative offset before due: `0d`, `1d`, `2w` — resolves to
 *    `due − offset` at {@link ANCHOR_HOUR} local.
 *
 * Callers pass `now`/timestamps in; timezone conversion happens at the
 * server's scheduler edge, never here.
 */
import { DAY_MS, formatDateTime, parseDate, parseDateTime } from './dates'
import type { TaskStatus } from './types'

/** Time of day a relative reminder fires on its resolved date. */
export const ANCHOR_HOUR = 9

export type ReminderSpec =
  /** Fire at this exact local datetime (`YYYY-MM-DDTHH:MM[:SS]`, as given). */
  | { kind: 'absolute'; at: string }
  /** Fire `days` days before the due date, at {@link ANCHOR_HOUR}. */
  | { kind: 'relative'; days: number }

/**
 * Parse a reminder string into a spec. Throws with the agent-facing message
 * listing the accepted forms.
 */
export function parseReminder(raw: string): ReminderSpec {
  const s = raw.trim()

  // Bare digits only — a leading '+' would shadow the due-date sugar `+1d`.
  const days = /^(\d+)d$/.exec(s)
  if (days) return { kind: 'relative', days: Number(days[1]) }
  const weeks = /^(\d+)w$/.exec(s)
  if (weeks) return { kind: 'relative', days: Number(weeks[1]) * 7 }

  if (parseDateTime(s) !== null) return { kind: 'absolute', at: s }

  throw new Error(
    `invalid reminder '${s}' (expected days/weeks before due like '1d' or '2w', ` +
      `or a local datetime 'YYYY-MM-DDTHH:MM' like '2026-06-14T18:00')`,
  )
}

/**
 * Resolve a spec to a concrete local fire-time (`YYYY-MM-DDTHH:MM[:SS]`).
 * A relative spec without a parseable due date is inert (null).
 */
export function resolveReminder(spec: ReminderSpec, due: string | undefined): string | null {
  if (spec.kind === 'absolute') return spec.at
  const dueEpoch = due === undefined ? null : parseDate(due)
  if (dueEpoch === null) return null
  return formatDateTime(dueEpoch - spec.days * DAY_MS + ANCHOR_HOUR * 3_600_000)
}

/**
 * Full pending rule: the task is open, the reminder resolves, and it has not
 * already fired at or after the resolved time. Returns the local fire-time
 * when pending. Invalid reminder strings are inert, never an error.
 */
export function pendingFireTime(
  status: TaskStatus,
  reminder: string | undefined,
  due: string | undefined,
  remindedAtLocal: string | undefined,
): string | null {
  if (status === 'done' || reminder === undefined) return null
  let spec: ReminderSpec
  try {
    spec = parseReminder(reminder)
  } catch {
    return null
  }
  const fire = resolveReminder(spec, due)
  if (fire === null) return null
  const fireEpoch = parseDateTime(fire)
  const lastEpoch = remindedAtLocal === undefined ? null : parseDateTime(remindedAtLocal)
  if (fireEpoch !== null && lastEpoch !== null && lastEpoch >= fireEpoch) return null
  return fire
}

/**
 * Recurrence rollover: shift an absolute reminder by the same day-delta the
 * due date moved, preserving time of day. Relative and unparseable reminders
 * return null (leave the stored string unchanged).
 */
export function shiftForRollover(
  reminder: string,
  oldDue: string,
  newDue: string,
): string | null {
  let spec: ReminderSpec
  try {
    spec = parseReminder(reminder)
  } catch {
    return null
  }
  if (spec.kind !== 'absolute') return null
  const at = parseDateTime(spec.at)
  const oldEpoch = parseDate(oldDue)
  const newEpoch = parseDate(newDue)
  if (at === null || oldEpoch === null || newEpoch === null) return null
  return formatDateTime(at + (newEpoch - oldEpoch))
}
