/**
 * When a reminder fires, and whether it still owes a notification — pure
 * functions, no clock read anywhere.
 *
 * **A reminder is a moment** (D79): a stamp, `YYYY-MM-DD` or
 * `YYYY-MM-DDTHH:MM`, and nothing else. It used to be a small grammar with a
 * relative form — `1d`, `2w`, meaning *N days before `due`, at 09:00* — and
 * that form is gone. It was never the thing anyone wanted stored: it could not
 * say "the evening before", it hid an anchor hour nobody chose, it was silently
 * inert on a task with no due date, and it made when-a-thing-fires depend on a
 * field you could edit somewhere else. The relative *offsets* survive as
 * presets in the picker, which resolve to a real datetime at the moment you
 * choose one — so the file says when the notification happens, in words a
 * person can read without a parser.
 *
 * A value that is not a stamp — a legacy `1d`, or a typo — is **inert, never an
 * error**. That rule predates this change and outlives it: the reader in
 * `task-file.ts` is deliberately lenient for the same reason, because a bad
 * reminder should cost you a notification, not a whole task file.
 *
 * Callers pass `now`/timestamps in; timezone conversion happens at the
 * scheduler's edge, never here.
 */
import { DAY_MS, formatStamp, parseStamp, stampDate, stampEpoch } from './dates'
import type { TaskStatus } from './types'

/**
 * The hour a **timeless** reminder fires at.
 *
 * All that is left of the old relative anchor, and now it only ever acts as a
 * fallback: it is never written into a file, so a reminder that says a time
 * says its own. Presets that know an hour write it explicitly, which is what
 * keeps the common case legible on disk.
 */
export const ANCHOR_HOUR = 9

/**
 * The local fire-time this reminder still owes, or null.
 *
 * Null when the task is done, when there is no reminder, when the reminder is
 * not a stamp, or when it has already been delivered at or after its own fire
 * time. `remindedAtLocal` is the machine-local watermark — deliberately not in
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
 * "leave the stored string alone" — an unparseable reminder or due is not
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
