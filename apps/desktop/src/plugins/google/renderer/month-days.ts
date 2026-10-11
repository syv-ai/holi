/**
 * The arithmetic of the agenda's month grid: which days an event is drawn on
 * and which window of the calendar a month needs. Pure, over `YYYY-MM-DD`
 * labels, so it needs no DOM. The calendar itself (the grid, week numbers,
 * a day's label) is `@holi/shared`'s.
 */
import { dayAfter, localDate, monthGrid } from '@holi/shared'

/** The slice of an event the grid reads. */
export interface DayEvent {
  start: string
  end: string
  allDay: boolean
}

/**
 * The days an event is drawn on: every day from its start to its end, in this
 * machine's time. Google's end is exclusive, so an all-day event stops the day
 * before its `end` and a timed one that ends at midnight does not reach into
 * the next day.
 */
export function eventDays(event: DayEvent): string[] {
  const first = event.allDay ? event.start.slice(0, 10) : localDate(new Date(event.start))
  const last = event.allDay
    ? event.end.slice(0, 10)
    : dayAfter(localDate(new Date(Date.parse(event.end) - 1)))
  const days = [first]
  // A guard rather than a trust: a year-long block is still a year.
  for (let day = dayAfter(first); day < last && days.length < 400; day = dayAfter(day)) {
    days.push(day)
  }
  return days
}

/** Events by the day they are drawn on, each day's in the order given. */
export function groupByDay<T extends DayEvent>(events: readonly T[]): Map<string, T[]> {
  const byDay = new Map<string, T[]>()
  for (const event of events) {
    for (const day of eventDays(event)) byDay.set(day, [...(byDay.get(day) ?? []), event])
  }
  return byDay
}

/** The instants to ask Google for to fill a month's grid: its first cell's
 *  midnight to the midnight after its last, in this machine's time. */
export function monthWindow(year: number, month: number): { from: string; to: string } {
  const weeks = monthGrid(year, month)
  const first = weeks[0]![0]!.date
  const last = dayAfter(weeks[weeks.length - 1]![6]!.date)
  return {
    from: new Date(`${first}T00:00:00`).toISOString(),
    to: new Date(`${last}T00:00:00`).toISOString(),
  }
}

/** `[year, month]` (month 1-12), `delta` months from `year`/`month`. */
export function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta
  return [Math.floor(index / 12), (index % 12) + 1]
}
