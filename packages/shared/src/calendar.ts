/**
 * The month grid a date picker draws: pure arithmetic over the same UTC epochs
 * the rest of the date math uses, so it is testable without a DOM.
 *
 * Hand-rolled rather than `react-day-picker`: the repo carries no date library,
 * and that one would bring a second class-name API to theme.
 */
import { DAY_MS, formatDate, lastDayOfMonth, parseDate } from './dates'

export interface GridDay {
  /** `YYYY-MM-DD`. */
  date: string
  /** False for the leading and trailing days borrowed from the neighbouring
   *  months — still real dates, and still clickable; just not this month's. */
  inMonth: boolean
}

/** Days per row, and rows per grid. See `monthGrid` for why the row count is fixed. */
const WEEK = 7
const WEEKS = 6

/**
 * Six weeks of seven days covering `month` (1-12) of `year`, **Monday-first**.
 *
 * **Always six rows**, even for a month five would cover exactly: a popover that
 * changed height as you paged between months would move the controls under the
 * pointer, which is a worse cost than a row of borrowed days.
 *
 * Monday-first to match `WEEKDAYS` in the recurrence editor.
 *
 * A `month` outside 1-12 normalises into the neighbouring year (13 → January of
 * the next) rather than throwing, so the picker can page by incrementing.
 */
export function monthGrid(year: number, month: number): GridDay[][] {
  const first = Date.UTC(year, month - 1, 1)
  // Monday-first: JS weeks start on Sunday, so rotate by six.
  const lead = (new Date(first).getUTCDay() + 6) % WEEK
  const start = first - lead * DAY_MS

  // Read the month back off the normalised date rather than trusting the
  // argument, so the `inMonth` test is right for month 13 too.
  const normalizedMonth = new Date(first).getUTCMonth()
  const normalizedYear = new Date(first).getUTCFullYear()

  const grid: GridDay[][] = []
  for (let w = 0; w < WEEKS; w++) {
    const week: GridDay[] = []
    for (let d = 0; d < WEEK; d++) {
      const epoch = start + (w * WEEK + d) * DAY_MS
      const at = new Date(epoch)
      week.push({
        date: formatDate(epoch),
        inMonth: at.getUTCMonth() === normalizedMonth && at.getUTCFullYear() === normalizedYear,
      })
    }
    grid.push(week)
  }
  return grid
}

/**
 * Where the arrow keys move the focus in a month grid, or null for a key this
 * grid does not claim.
 *
 * Returns a date rather than a cell, because the focus may leave the month it
 * started in: the caller re-pages the view onto whatever comes back.
 */
export function gridFocusMove(date: string, key: string): string | null {
  const epoch = parseDate(date)
  if (epoch === null) return null
  switch (key) {
    case 'ArrowLeft':
      return formatDate(epoch - DAY_MS)
    case 'ArrowRight':
      return formatDate(epoch + DAY_MS)
    case 'ArrowUp':
      return formatDate(epoch - WEEK * DAY_MS)
    case 'ArrowDown':
      return formatDate(epoch + WEEK * DAY_MS)
    case 'PageUp':
      return shiftMonth(date, -1)
    case 'PageDown':
      return shiftMonth(date, 1)
    default:
      return null
  }
}

/**
 * The same day, `delta` months away, clamped to a day that month has — 31 March
 * back a month is 28 February, not 3 March. The same clamp as `nextDue`.
 */
function shiftMonth(date: string, delta: number): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const target = month - 1 + delta
  const y = year + Math.floor(target / 12)
  const m = ((target % 12) + 12) % 12
  return formatDate(Date.UTC(y, m, Math.min(day, lastDayOfMonth(y, m + 1))))
}
