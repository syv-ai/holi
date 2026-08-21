/**
 * Minimal pure date helpers over ISO strings (`YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:MM[:SS]`), used by the reminder + recurrence math. All
 * arithmetic runs on UTC epoch numbers so wall-clock DST never bites —
 * "local-naive" datetimes are treated as points on an idealized clock, exactly
 * like the old Rust's chrono::Naive types. No timezone logic lives here.
 */

export const DAY_MS = 86_400_000

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

export function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isRealDate(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= lastDayOfMonth(y, m)
}

/** Parse `YYYY-MM-DD` to a UTC epoch (ms at midnight), or null. */
export function parseDate(s: string): number | null {
  const m = DATE_RE.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!isRealDate(y, mo, d)) return null
  return Date.UTC(y, mo - 1, d)
}

/** Parse `YYYY-MM-DDTHH:MM[:SS]` to a UTC epoch (ms), or null. */
export function parseDateTime(s: string): number | null {
  const m = DATETIME_RE.exec(s)
  if (!m) return null
  const [y, mo, d, h, min] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
  const sec = m[6] === undefined ? 0 : Number(m[6])
  if (!isRealDate(y, mo, d) || h > 23 || min > 59 || sec > 59) return null
  return Date.UTC(y, mo - 1, d, h, min, sec)
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** Format a UTC epoch as `YYYY-MM-DD`. */
export function formatDate(epoch: number): string {
  const d = new Date(epoch)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Format a UTC epoch as `YYYY-MM-DDTHH:MM` (minute precision). */
export function formatDateTime(epoch: number): string {
  const d = new Date(epoch)
  return `${formatDate(epoch)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// ────────────────────────────────────────────────────────────── stamps ──
//
// A **stamp** is a date that may or may not name a time: `YYYY-MM-DD` or
// `YYYY-MM-DDTHH:MM[:SS]`. It is the type a task's `due` and `reminder` both
// hold (D79).
//
// The `timed` flag is carried rather than re-derived at each call site because
// the absence of a time is *data*, not a formatting choice: a task due
// `2026-08-25` is due that day, and a task due `2026-08-25T00:00` is due at
// midnight, and only one of those is a thing anybody means. Everything below is
// built on the two strict parsers above — they own the validity rules
// (`isRealDate`, hour and minute bounds), and a third regex that re-stated them
// would be a third place for them to drift.

const TIME_RE = /^(\d{2}):(\d{2})$/

/** A stamp, parsed. */
export interface ParsedStamp {
  /** UTC epoch ms. Midnight when the stamp named no time. */
  epoch: number
  /** Whether the stamp actually named a time. */
  timed: boolean
}

/** Parse a stamp in either shape, or null. Never throws: an unparseable stamp
 *  is inert everywhere it appears, and a throw here would take a whole task
 *  file down with it. */
export function parseStamp(s: string): ParsedStamp | null {
  const date = parseDate(s)
  if (date !== null) return { epoch: date, timed: false }
  const datetime = parseDateTime(s)
  if (datetime !== null) return { epoch: datetime, timed: true }
  return null
}

/** Epoch for a stamp, substituting `defaultHour` when it names no time of its
 *  own. Null when unparseable. */
export function stampEpoch(s: string, defaultHour: number): number | null {
  const parsed = parseStamp(s)
  if (parsed === null) return null
  return parsed.timed ? parsed.epoch : parsed.epoch + defaultHour * 3_600_000
}

/** Format an epoch as a stamp — `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when
 *  `timed`. The inverse of `parseStamp` in both shapes. */
export function formatStamp(epoch: number, timed: boolean): string {
  return timed ? formatDateTime(epoch) : formatDate(epoch)
}

/** The date half of a stamp, always `YYYY-MM-DD`. Null when unparseable. */
export function stampDate(s: string): string | null {
  const parsed = parseStamp(s)
  return parsed === null ? null : formatDate(parsed.epoch)
}

/** The time half as `HH:MM` — null when the stamp is timeless *or* unparseable,
 *  which are the same thing to every caller: there is no time to show. Seconds
 *  are truncated, matching `formatDateTime`'s minute precision. */
export function stampTime(s: string): string | null {
  const parsed = parseStamp(s)
  if (parsed === null || !parsed.timed) return null
  return formatDateTime(parsed.epoch).slice(11)
}

/** The same day, with `time` (`HH:MM`) put on it — or taken off, when `time` is
 *  null. The one edit the picker performs on an existing value, so that moving
 *  between the two shapes never goes through a caller's own string surgery. */
export function withTime(s: string, time: string | null): string | null {
  const date = stampDate(s)
  if (date === null) return null
  if (time === null) return date
  if (!TIME_RE.test(time)) return null
  const combined = `${date}T${time}`
  return parseDateTime(combined) === null ? null : combined
}
