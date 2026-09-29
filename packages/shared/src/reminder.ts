/**
 * When a reminder fires, and whether it still owes a notification: pure
 * functions, no clock read anywhere.
 *
 * **A reminder is a moment**: a stamp, `YYYY-MM-DD` or
 * `YYYY-MM-DDTHH:MM`, and nothing else. Relative offsets ("1 day before") are
 * presets in the picker that resolve to a real datetime when chosen, so the
 * file says when the notification happens and it never depends on `due`.
 *
 * A value that is not a stamp (a legacy `1d`, or a typo) is **inert, never an
 * error**: a bad reminder should cost you a notification, not a whole task file.
 *
 * Callers pass `now`/timestamps in; timezone conversion happens at the
 * scheduler's edge, never here.
 */
import { DAY_MS, formatStamp, parseStamp, stampDate, stampEpoch } from './dates'
import type { TaskStatus } from './types'

/**
 * The hour a **timeless** reminder fires at.
 *
 * Only ever a fallback: it is never written into a file. Presets that know an
 * hour write it explicitly.
 */
export const ANCHOR_HOUR = 9

/**
 * The local fire-time this reminder still owes, or null.
 *
 * Null when the task is done, when there is no reminder, when the reminder is
 * not a stamp, or when it has already been delivered at or after its own fire
 * time. `remindedAtLocal` is the machine-local watermark, deliberately not in
 * the repo, because a write on every fire would be a commit on every fire.
 */
export function pendingFireTime(
  status: TaskStatus,
  reminder: string | undefined,
  remindedAtLocal: string | undefined,
): string | null {
  if (status === 'done' || reminder === undefined) return null
  const epoch = stampEpoch(reminder, ANCHOR_HOUR)
  if (epoch === null) return null
  const fire = formatStamp(epoch, true)
  const last = remindedAtLocal === undefined ? null : stampEpoch(remindedAtLocal, ANCHOR_HOUR)
  if (last !== null && last >= epoch) return null
  return fire
}

/**
 * Recurrence rollover: move a reminder by the same whole-day delta the due date
 * moved, preserving its own time of day **and its timed-ness**.
 *
 * The delta is measured between the dues' *date halves*, so a due date that
 * carries a time of its own cannot drag the reminder off its hour. Null means
 * "leave the stored string alone": an unparseable reminder or due is not
 * something to guess at.
 */
export function shiftForRollover(reminder: string, oldDue: string, newDue: string): string | null {
  const at = parseStamp(reminder)
  // Midnight-to-midnight, via the date halves: `stampEpoch(_, 0)` on a timed
  // due would carry that due's hours into the delta and knock the reminder off
  // its own time.
  const from = stampEpoch(stampDate(oldDue) ?? '', 0)
  const to = stampEpoch(stampDate(newDue) ?? '', 0)
  if (at === null || from === null || to === null) return null
  const days = Math.round((to - from) / DAY_MS)
  return formatStamp(at.epoch + days * DAY_MS, at.timed)
}
