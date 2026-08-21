/**
 * The month grid a date picker draws — pure arithmetic over the same UTC epochs
 * the rest of the date math uses, so a calendar is a data structure here rather
 * than a component's internal state (D79).
 *
 * Hand-rolled rather than `react-day-picker`: this repo carries no date library
 * at all, the grid is a small amount of arithmetic on helpers that already
 * exist, and the alternative would bring a second class-name API to theme.
 * Keeping it here rather than in the renderer is what lets the hard part be
 * tested without a DOM.
 */
import { DAY_MS, formatDate, lastDayOfMonth, parseDate } from './dates'

/** One cell. */
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
 * Monday-first to match `WEEKDAYS` in the recurrence editor, which is already
 * `['mon', …]` — one week shape across the app.
 *
 * A `month` outside 1-12 normalises into the neighbouring year (13 → January of
 * the next), rather than throwing. The picker pages by incrementing a number,
 * and December → January is exactly the step that would hit it; normalising is
 * what lets the caller stay arithmetic instead of carrying the wrap itself.
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
 * Returns a date rather than a cell, because the focus is allowed to leave the
 * month it started in — the caller re-pages the view onto whatever comes back,
 * which is what makes a grid navigable at all rather than a box you tab across.
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
 * back a month is 28 February, not 3 March. The clamp is `nextDue`'s rule, and
 * it is here for the same reason: a paging step that skipped a month whenever
 * the day was too high would be wrong in exactly the months people notice.
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
