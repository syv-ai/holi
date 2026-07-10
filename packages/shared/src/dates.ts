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
