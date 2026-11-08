/**
 * How the calendar view writes days and times: in the person's language, on
 * the clock the `timeFormat` setting names, never a fixed English pattern.
 */
/** Which clock the calendar writes times on: 14:30, or 2:30 PM (the
 *  plugin's `timeFormat` setting). */
export type TimeFormat = '24h' | '12h'

/** Monday first, as the Agenda's month and ISO week numbers are. */
export const WEEK_STARTS_ON = 1

/** An instant's time of day on the given clock: 14:30, or 2:30 PM. */
export const timeOf = (date: Date, clock: TimeFormat): string =>
  date.toLocaleTimeString(
    undefined,
    clock === '12h'
      ? { hour: 'numeric', minute: '2-digit', hour12: true }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  )

/** "HH:mm" written on the given clock. */
export function clockLabel(hhmm: string, clock: TimeFormat): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number)
  return timeOf(new Date(2000, 0, 1, h, m), clock)
}

/** "Thu, 23 Oct". */
export const shortDay = (date: Date): string =>
  date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** "Thursday, 23 October". */
export const longDay = (date: Date): string =>
  date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

/** "23 Oct". */
export const dayMonth = (date: Date): string =>
  date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** "HH:mm" of an instant, for the form's time selects. */
export const hhmm = (date: Date): string =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
