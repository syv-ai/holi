/**
 * Recurrence roll-forward math — pure functions over stamps (`YYYY-MM-DD`, or
 * `YYYY-MM-DDTHH:MM`; the hour rides along and the arithmetic is on days),
 * ported from the old Rust `services/recurrence.rs` (D19). The server runs
 * this on `tasks.complete`; clients only display the results.
 */
import {
  DAY_MS,
  formatDate,
  lastDayOfMonth,
  parseDate,
  stampDate,
  stampTime,
  withTime,
} from './dates'
import type { Recurrence, RecurrenceFrequency, RecurrenceWeekday } from './types'

/**
 * Given a task's current due date and recurrence rule, return the next due
 * date, or null if the date can't be parsed or the next occurrence would be
 * past `endDate`.
 *
 * `currentDue` is a **stamp** (D79) — it may name an hour, and if it does, the
 * result names the same one. The arithmetic below runs on whole calendar days
 * and is untouched by that: the month and year helpers clamp on days (Jan 31 +
 * 1 month → Feb 28), so a time component would only be along for the ride and
 * would round-trip through the clamp badly. Split it off, step, put it back.
 */
/** Weekday order, so a summary reads Mon-first however the list was written. */
const WEEKDAY_ORDER: readonly RecurrenceWeekday[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
]

const FREQUENCY_NOUN: Record<RecurrenceFrequency, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
}

/**
 * A rule, in words: `every week on Mon, Wed`, `every 3 days until 2026-12-01`.
 *
 * For the one row that stands in for the whole nested map. A summary rather
 * than four rows because `recurrence` is one key, and a block that draws a row
 * per key cannot have one key quietly occupying four of them.
 */
export function describeRecurrence(rule: Recurrence): string {
  const noun = FREQUENCY_NOUN[rule.frequency]
  const every = rule.interval === 1 ? `every ${noun}` : `every ${rule.interval} ${noun}s`
  const days =
    rule.frequency === 'weekly' && rule.weekdays !== undefined && rule.weekdays.length > 0
      ? ` on ${WEEKDAY_ORDER.filter((d) => rule.weekdays!.includes(d))
          .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
          .join(', ')}`
      : ''
  const until = rule.endDate === undefined ? '' : ` until ${rule.endDate}`
  return `${every}${days}${until}`
}

export function nextDue(currentDue: string, rule: Recurrence): string | null {
  const time = stampTime(currentDue)
  const date = stampDate(currentDue)
  const current = date === null ? null : parseDate(date)
  if (current === null) return null
  const interval = Math.max(1, rule.interval)

  let next: number | null
  switch (rule.frequency) {
    case 'daily':
      next = current + interval * DAY_MS
      break
    case 'weekly':
      next = rule.weekdays?.length
        ? nextWeeklyWeekday(current, interval, rule.weekdays)
        : current + interval * 7 * DAY_MS
      break
    case 'monthly':
      next = addMonths(current, interval)
      break
    case 'yearly':
      next = addYears(current, interval)
      break
  }
  if (next === null) return null

  if (rule.endDate !== undefined) {
    // On the DATE half: `endDate` is a boundary on the rule, not an appointment,
    // so a due at 23:00 on the end date is still inside it.
    const end = parseDate(rule.endDate)
    if (end !== null && next > end) return null
  }
  return withTime(formatDate(next), time)
}

/**
 * Advance the recurrence until the next due date is on or after `today`
 * (`YYYY-MM-DD`). Used when completing a stale (overdue) recurring task — a
 * single `nextDue` step would still leave the task in the past.
 */
export function nextDueCatchup(currentDue: string, rule: Recurrence, today: string): string | null {
  const time = stampTime(currentDue)
  const date = stampDate(currentDue)
  const current = date === null ? null : parseDate(date)
  const todayEpoch = parseDate(today)
  if (current === null || todayEpoch === null) return null

  // Closed-form leap to a cursor close to (but strictly before) today, so we
  // then iterate at most a handful of times. Without this, decades-stale
  // tasks would silently return null once they exceeded the iteration cap.
  let cursor = withTime(formatDate(leapCloseToToday(current, rule, todayEpoch)), time)!

  // After the leap we're within a couple of intervals of today. 60 covers
  // weekly+weekday rules where a single step may only advance within one
  // week, and gives slack for monthly day-clamping that pulls earlier.
  for (let i = 0; i < 60; i++) {
    const next = nextDue(cursor, rule)
    if (next === null) return null
    // A timed `next` compared against a date-only `today` is lexicographically
    // correct and looks like a bug: '2026-04-14T14:00' >= '2026-04-14' is true,
    // which is the answer we want — a task due later today has caught up. Do
    // not "fix" this into a stamp comparison.
    if (next >= today) return next
    cursor = next
  }
  return null
}

/**
 * Leap strictly before `today` along the recurrence's interval grid. A leap
 * equal to today would force the iteration to step past it, missing today
 * even when today itself is a valid recurrence date — so we deliberately
 * stop one step short.
 */
function leapCloseToToday(current: number, rule: Recurrence, today: number): number {
  if (current >= today) return current
  const interval = Math.max(1, rule.interval)
  switch (rule.frequency) {
    case 'daily': {
      const days = Math.floor((today - current) / DAY_MS)
      const n = Math.max(0, Math.floor(days / interval) - 1)
      return current + n * interval * DAY_MS
    }
    case 'weekly': {
      const weeks = Math.floor((today - current) / (7 * DAY_MS))
      const n = Math.max(0, Math.floor(weeks / interval) - 1)
      return current + n * interval * 7 * DAY_MS
    }
    case 'monthly': {
      // Day clamping (Jan 31 + 1 month → Feb 28) can put addMonths past
      // today even when the months count says it shouldn't, so we back off
      // in interval-sized steps until strictly earlier.
      let n = Math.floor(monthsBetween(current, today) / interval)
      for (;;) {
        if (n <= 0) return current
        const candidate = addMonths(current, n * interval)
        if (candidate < today) return candidate
        n -= 1
      }
    }
    case 'yearly': {
      let n = Math.floor((ymd(today).y - ymd(current).y) / interval)
      for (;;) {
        if (n <= 0) return current
        const candidate = addYears(current, n * interval)
        if (candidate < today) return candidate
        n -= 1
      }
    }
  }
}

function monthsBetween(from: number, to: number): number {
  const a = ymd(from)
  const b = ymd(to)
  return (b.y - a.y) * 12 + (b.m - a.m)
}

function ymd(epoch: number): { y: number; m: number; d: number } {
  const date = new Date(epoch)
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
}

/** Build a date, clamping `d` down to the last valid day of the month. */
function clampDay(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, Math.min(d, lastDayOfMonth(y, m)))
}

function addMonths(epoch: number, months: number): number {
  const { y, m, d } = ymd(epoch)
  const totalMonth0 = m - 1 + months
  const year = y + Math.floor(totalMonth0 / 12)
  const month = ((totalMonth0 % 12) + 12) % 12
  return clampDay(year, month + 1, d)
}

function addYears(epoch: number, years: number): number {
  const { y, m, d } = ymd(epoch)
  return clampDay(y + years, m, d)
}

const WEEKDAY_INDEX: Record<RecurrenceWeekday, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
}

/** Monday-0 weekday index of a UTC epoch. */
const weekdayMon0 = (epoch: number) => (new Date(epoch).getUTCDay() + 6) % 7

/** Epoch of the Monday starting this date's ISO week (same Monday ⟺ same week). */
const mondayOf = (epoch: number) => epoch - weekdayMon0(epoch) * DAY_MS

/**
 * `interval` is the number of weeks between repetitions. For interval=1 we
 * step day-by-day until we hit a selected weekday. For interval>1, once we
 * cross into a new week the next hit must be at least `interval-1` weeks
 * later — so we jump to the Monday of the target week and scan it.
 */
function nextWeeklyWeekday(
  current: number,
  interval: number,
  weekdays: RecurrenceWeekday[],
): number | null {
  const allowed = new Set(weekdays.map((w) => WEEKDAY_INDEX[w]))
  if (allowed.size === 0) return null

  const currentMonday = mondayOf(current)
  let cursor = current + DAY_MS

  for (let i = 0; i < 14; i++) {
    const sameWeek = mondayOf(cursor) === currentMonday
    if (sameWeek || interval <= 1) {
      if (allowed.has(weekdayMon0(cursor))) return cursor
      cursor += DAY_MS
    } else {
      const targetMonday = mondayOf(cursor) + (interval - 1) * 7 * DAY_MS
      for (let offset = 0; offset < 7; offset++) {
        const candidate = targetMonday + offset * DAY_MS
        if (allowed.has(weekdayMon0(candidate))) return candidate
      }
      return null
    }
  }
  return null
}
