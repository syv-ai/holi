/**
 * How the calendar view writes days and times: in the person's language and
 * this machine's clock, never a fixed English pattern, as the Agenda does.
 */

/** Monday first, as the Agenda's month and ISO week numbers are. */
export const WEEK_STARTS_ON = 1

/** An instant's time of day: 14:30, or 2:30 PM where the clock says so. */
export const timeOf = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** "HH:mm" on this machine's clock. */
export function clockLabel(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number)
  return timeOf(new Date(2000, 0, 1, h, m))
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
