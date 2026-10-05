/**
 * The arithmetic of the agenda's month grid: which days an event is drawn on,
 * which window of the calendar a month needs, and the week numbers down its
 * side. Pure, over `YYYY-MM-DD` labels, so it needs no DOM.
 */
import { DAY_MS, formatDate, monthGrid, parseDate, type GridDay } from '@holi/shared'

/** The slice of an event the grid reads. */
export interface DayEvent {
  start: string
  end: string
  allDay: boolean
}

/** A local calendar day as `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The day after `day`. */
export function nextDay(day: string): string {
  return formatDate((parseDate(day) ?? 0) + DAY_MS)
}

/**
 * The days an event is drawn on. An all-day event covers every day from its
 * start to the one before its `end` (Google's all-day end is exclusive); a
 * timed one is drawn on the day it starts, however long it runs.
 */
export function eventDays(event: DayEvent): string[] {
  if (!event.allDay) return [localDay(new Date(event.start))]
  const first = event.start.slice(0, 10)
  const last = event.end.slice(0, 10)
  const days = [first]
  // A guard rather than a trust: a year-long all-day block is still a year.
  for (let day = nextDay(first); day < last && days.length < 400; day = nextDay(day)) {
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

/** The six weeks a month is drawn as, Monday first. */
export function weeksOf(year: number, month: number): GridDay[][] {
  return monthGrid(year, month)
}

/** The instants to ask Google for to fill a month's grid: its first cell's
 *  midnight to the midnight after its last, in this machine's time. */
export function monthWindow(year: number, month: number): { from: string; to: string } {
  const weeks = weeksOf(year, month)
  const first = weeks[0]![0]!.date
  const last = nextDay(weeks[weeks.length - 1]![6]!.date)
  return {
    from: new Date(`${first}T00:00:00`).toISOString(),
    to: new Date(`${last}T00:00:00`).toISOString(),
  }
}

/** The ISO week number (1-53) of a day: the week of its Thursday. */
export function isoWeek(day: string): number {
  const epoch = parseDate(day) ?? 0
  const weekday = (new Date(epoch).getUTCDay() + 6) % 7
  const thursday = epoch + (3 - weekday) * DAY_MS
  const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1)
  return Math.floor((thursday - jan1) / DAY_MS / 7) + 1
}

/** `[year, month]` (month 1-12), `delta` months from `year`/`month`. */
export function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta
  return [Math.floor(index / 12), (index % 12) + 1]
}
