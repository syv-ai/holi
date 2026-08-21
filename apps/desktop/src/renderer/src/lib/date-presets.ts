/**
 * The shortcuts the date pickers offer, resolved (D79).
 *
 * A preset is a **label and a finished stamp**: choosing "1 day before" writes
 * `2026-08-24T09:00` and you adjust from there. That is the whole trick that
 * let the reminder grammar go — the convenience of "a day before" survives, and
 * the file still says the moment rather than an offset that has to be resolved
 * against a field you could edit somewhere else.
 *
 * Pure, and `now` is passed in rather than read from the clock, so this is
 * testable without a DOM or a frozen timer.
 *
 * **Two vocabularies for a reminder, and that is the point.** With a due date,
 * a reminder is naturally expressed *against* it — "1 day before". Without one
 * there is nothing to be before, so the same shortcuts read forward from now —
 * "in 1 day". The old grammar had only the first, which is why a reminder on a
 * task with no due date was silently inert.
 */
import { ANCHOR_HOUR, formatStamp, parseStamp, stampDate, stampTime } from '@holi/shared'
import type { DatePreset } from '@/composites'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** The hour a shortcut lands on when it names a day but not a time. */
const MORNING = ANCHOR_HOUR
/** The hour "later today" means. Early evening — after a working day, before bed. */
const EVENING = 18

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-08-24T09:00` → `24 Aug, 09:00`. What the rail shows beside a label, so
 *  choosing a shortcut is never a guess about where it lands. */
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
 * Shortcuts for a **due date**: days, not moments. A task is due on a day
 * unless you say otherwise, so every one of these writes a timeless stamp and
 * the time row is where you add an hour if you want one.
 */
export function duePresets(now: string): DatePreset[] {
  const start = dayStart(now)
  if (start === null) return []
  const day = (n: number) => formatStamp(start + n * DAY_MS, false)

  // Days to the coming Monday, in a Monday-first week. On a Monday this is 7,
  // not 0 — "next Monday" has to move, or the row does nothing. That falls out
  // of the subtraction rather than needing a case: a mutation check proved the
  // guard that used to be here could not change an answer.
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
 * Shortcuts for a **reminder**: moments, always — a notification with no time
 * is not a notification. Relative to `due` when there is one, and to `now` when
 * there is not.
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
    // Only offered when the due date names an hour — "1 hour before" a day is
    // not a thing anyone can mean.
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
    // Dropped once the evening has arrived: a shortcut that resolves to a
    // moment already past is a row that does nothing.
    ...(at.epoch < tonight ? [preset('this evening', formatStamp(tonight, true))] : []),
    preset('tomorrow', morning(1)),
    preset('in 2 days', morning(2)),
    preset('in 3 days', morning(3)),
    preset('in a week', morning(7)),
    preset('in 2 weeks', morning(14)),
  ]
}
