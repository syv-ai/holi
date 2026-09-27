/**
 * The shortcuts the date pickers offer, resolved (D79).
 *
 * A preset is a label and a finished stamp: "1 day before" writes
 * `2026-08-24T09:00`, so the file holds the moment, never an offset resolved
 * against another field. `now` is passed in, for testability.
 *
 * A reminder reads against the due date when there is one ("1 day before"),
 * and forward from now when there is not ("in 1 day").
 */
import { ANCHOR_HOUR, formatStamp, parseStamp, stampDate, stampTime } from '@holi/shared'

/** A rail entry: its label, the finished stamp it writes, and a hint saying
 *  where that lands. */
export interface DatePreset {
  label: string
  value: string
  hint?: string
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** The hour a shortcut lands on when it names a day but not a time. */
const MORNING = ANCHOR_HOUR
/** The hour "later today" means. Early evening — after a working day, before bed. */
const EVENING = 18

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-08-24T09:00` → `24 Aug, 09:00`, shown beside a preset's label. */
export function shortStamp(stamp: string): string {
  const date = stampDate(stamp)
  if (date === null) return stamp
  const [, month, day] = date.split('-')
  const short = `${Number(day)} ${MONTHS[Number(month) - 1]}`
  const time = stampTime(stamp)
  return time === null ? short : `${short}, ${time}`
}

const preset = (label: string, value: string): DatePreset => ({
  label,
  value,
  hint: shortStamp(value),
})

/** Midnight of a stamp's day, as an epoch. Null when it will not parse. */
function dayStart(stamp: string): number | null {
  const date = stampDate(stamp)
  return date === null ? null : (parseStamp(date)?.epoch ?? null)
}

/**
 * Shortcuts for a due date: timeless stamps, since a task is due on a day
 * unless you add an hour.
 */
export function duePresets(now: string): DatePreset[] {
  const start = dayStart(now)
  if (start === null) return []
  const day = (n: number) => formatStamp(start + n * DAY_MS, false)

  // Days to the coming Monday, in a Monday-first week: 7 on a Monday, not 0.
  const weekday = (new Date(start).getUTCDay() + 6) % 7
  const untilMonday = 7 - weekday

  return [
    preset('today', day(0)),
    preset('tomorrow', day(1)),
    preset('in 2 days', day(2)),
    preset('in 3 days', day(3)),
    preset('next Monday', day(untilMonday)),
    preset('in a week', day(7)),
    preset('in 2 weeks', day(14)),
  ]
}

/**
 * Shortcuts for a reminder: always timed. Relative to `due` when there is one,
 * else to `now`.
 */
export function reminderPresets(due: string | undefined, now: string): DatePreset[] {
  const dueParsed = due === undefined ? null : parseStamp(due)
  return dueParsed === null ? forwardFromNow(now) : beforeDue(due!, dueParsed.timed)
}

/** "N before" — anchored on the due date, at the morning hour, except the one
 *  entry that can only exist when the due date itself names a time. */
function beforeDue(due: string, dueIsTimed: boolean): DatePreset[] {
  const start = dayStart(due)
  const at = parseStamp(due)
  if (start === null || at === null) return []
  const before = (days: number) => formatStamp(start - days * DAY_MS + MORNING * HOUR_MS, true)

  return [
    preset('on the day', before(0)),
    // Only when the due date names an hour.
    ...(dueIsTimed ? [preset('1 hour before', formatStamp(at.epoch - HOUR_MS, true))] : []),
    preset('1 day before', before(1)),
    preset('2 days before', before(2)),
    preset('3 days before', before(3)),
    preset('a week before', before(7)),
    preset('2 weeks before', before(14)),
  ]
}

/** "in N" — anchored on now, for a task with no due date to be before. */
function forwardFromNow(now: string): DatePreset[] {
  const at = parseStamp(now)
  const start = dayStart(now)
  if (at === null || start === null) return []
  const morning = (days: number) => formatStamp(start + days * DAY_MS + MORNING * HOUR_MS, true)
  const tonight = start + EVENING * HOUR_MS

  return [
    preset('in an hour', formatStamp(at.epoch + HOUR_MS, true)),
    // Dropped once the evening has passed.
    ...(at.epoch < tonight ? [preset('this evening', formatStamp(tonight, true))] : []),
    preset('tomorrow', morning(1)),
    preset('in 2 days', morning(2)),
    preset('in 3 days', morning(3)),
    preset('in a week', morning(7)),
    preset('in 2 weeks', morning(14)),
  ]
}
