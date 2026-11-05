/**
 * The site's room schedule, read as times Holi can use.
 *
 * The site thinks in its own wall clock: a schedule is a list of half-hour
 * slots for one local day (`2026-11-04T09:00:00`, no offset) in the site's
 * timezone (`Europe/Oslo`), each `free` or `busy`, and a booking is sent the
 * same way. Holi's callers speak in instants, so this converts both ways
 * through `@date-fns/tz`, which knows the zone's daylight saving, and folds
 * a run of busy slots into one busy interval.
 */
import { TZDate, tz } from '@date-fns/tz'
import { format, parseISO } from 'date-fns'

/** A slot as the site sends it. */
export interface SiteSlot {
  /** Local wall-clock time, no offset. */
  start: string
  end: string
  status: string
  booking?: SiteSlotBooking | null
}

interface SiteSlotBooking {
  id?: string
  title?: string | null
  organizer_email?: string | null
  user_id?: string | null
}

/** A stretch of time a room is taken, as instants. */
export interface BusyInterval {
  start: string
  end: string
  /** The site's booking behind it, when the site says; an Outlook event or
   *  another company's booking may come with none. */
  bookingId: string | null
  title: string | null
  organizer: string | null
  mine: boolean
}

const LOCAL = "yyyy-MM-dd'T'HH:mm:ss"

/** `instant` on the site's wall clock: `2026-11-04T09:00:00`. */
export function toLocal(instant: Date, timeZone: string): string {
  return format(new TZDate(instant, timeZone), LOCAL)
}

/** The site's local day `instant` falls on: `2026-11-04`. */
export function localDay(instant: Date, timeZone: string): string {
  return toLocal(instant, timeZone).slice(0, 10)
}

/**
 * A wall-clock time on the site's clock, as an instant.
 * @public exported for its test
 */
export function fromLocal(local: string, timeZone: string): Date {
  const at = +parseISO(local, { in: tz(timeZone) })
  if (Number.isNaN(at)) throw new Error(`not a local time: ${local}`)
  return new Date(at)
}

/** A booking at its exact times, as instants. */
export interface ExactBooking {
  id: string
  start: string
  end: string
}

/**
 * The intervals with the person's own bookings at their exact times. The
 * schedule knows only half hours, so a 13:30–14:15 booking fills the 14:00
 * slot and folds out to 14:30; the site's bookings list has 14:15.
 */
export function withExactTimes(
  busy: readonly BusyInterval[],
  exact: readonly ExactBooking[],
): BusyInterval[] {
  const byId = new Map(exact.map((b) => [b.id, b]))
  return busy.map((x) => {
    const b = x.bookingId === null ? undefined : byId.get(x.bookingId)
    return b === undefined ? x : { ...x, start: b.start, end: b.end }
  })
}

/**
 * The busy slots, folded into intervals: consecutive busy slots that share a
 * booking are one interval. Slots with no booking id (an Outlook event, say)
 * are one interval while their title and organizer stay the same, so two
 * events back to back stay two.
 */
export function busyIntervals(
  slots: readonly SiteSlot[],
  timeZone: string,
  me: { userId: string; email: string },
): BusyInterval[] {
  const out: BusyInterval[] = []
  for (const slot of slots) {
    if (slot.status === 'free') continue
    const booking = slot.booking ?? null
    const id = booking?.id ?? null
    const title = booking?.title ?? null
    const organizer = booking?.organizer_email ?? null
    const start = fromLocal(slot.start, timeZone).toISOString()
    const end = fromLocal(slot.end, timeZone).toISOString()
    const last = out.at(-1)
    const same =
      last !== undefined &&
      last.end === start &&
      last.bookingId === id &&
      (id !== null || (last.title === title && last.organizer === organizer))
    if (same) {
      last.end = end
      continue
    }
    out.push({
      start,
      end,
      bookingId: id,
      title,
      organizer,
      mine: booking !== null && isMine(booking, me),
    })
  }
  return out
}

/** A booking is the signed-in person's by their user id or their address; an
 *  unknown id or address on either side matches nothing. */
function isMine(booking: SiteSlotBooking, me: { userId: string; email: string }): boolean {
  if (me.userId !== '' && booking.user_id === me.userId) return true
  const organizer = booking.organizer_email ?? ''
  return organizer !== '' && organizer.toLowerCase() === me.email.toLowerCase()
}
