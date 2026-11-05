/**
 * Mødelokale Booking's capabilities (docs/features/booking.md), one list for every
 * door: the Booking app's bridge (`holi.booking.*`), the agent's
 * `holi booking <verb>`, and Holi's own UI.
 *
 * **At the app door every entry needs the `booking` grant.** The session is
 * one person's sign-in, and a booking is made in their name, so an app must
 * declare `dangerously-allow: [booking]` and the person approve it, as for
 * mail and the calendar.
 *
 * **Signing in reads Gmail through the Google plugin**, at its UI door
 * (`call`), when that plugin is on and an account is connected; otherwise
 * the person pastes the link from the email (`booking.finish`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  type CapabilityTable,
} from '../../../main/plugin-api'
import {
  BookingApiError,
  type AuthTokens,
  type BookingApi,
  type BookingErrorKind,
  type Room,
} from './api'
import type { BookingAuth } from './auth'
import { secretText, waitForLoginSecret, type MailLookup } from './login-mail'
import {
  busyIntervals,
  localDay,
  toLocal,
  withExactTimes,
  type BusyInterval,
  type ExactBooking,
  type SiteSlot,
} from './schedule'
import type { BookingSite } from './site'

export const BOOKING_NAMESPACES = ['booking'] as const

/** The affordance an app declares to reach any of this. */
const GRANT = 'booking'
/** The longest one booking may run. */
const MAX_BOOKING_MS = 12 * 60 * 60_000
/** A booking may start this far in the past: "now" typed a minute ago. */
const PAST_SLACK_MS = 15 * 60_000

export interface BookingCapabilityDeps {
  site: BookingSite
  api: BookingApi
  auth: BookingAuth
  /** Gmail for the vault `remote`, through the Google plugin. */
  mailFor(remote: string): MailLookup
  /** How long `login` watches Gmail for the email. */
  loginWait?: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> }
  now?: () => number
}

/** One room's day: when it is taken, by anyone. */
export interface RoomDay {
  id: string
  name: string
  email: string
  busy: BusyInterval[]
}

/** What `book` made. */
export interface MadeBooking {
  roomId: string
  roomName: string
  start: string
  end: string
  title: string
}

export function bookingCapabilities(deps: BookingCapabilityDeps) {
  const now = deps.now ?? Date.now
  const host = new URL(deps.site.base).host
  const wait = deps.loginWait ?? { timeoutMs: 90_000, intervalMs: 4_000 }

  const status = async () => {
    const who = await deps.auth.current()
    return { signedIn: who !== null, email: who?.email ?? null, site: host }
  }

  /** The session and the rooms, which every read below needs. */
  const signedIn = () => Promise.all([deps.auth.session(), deps.api.rooms()])

  /**
   * A room's busy times on `day`, with the person's own bookings at their
   * exact times rather than the schedule's half hours. Those times only
   * sharpen the picture, so without them (the list not answering) the half
   * hours stand.
   */
  const busyOn = (
    slots: readonly SiteSlot[],
    session: AuthTokens,
    exact: readonly ExactBooking[],
  ) =>
    withExactTimes(
      busyIntervals(slots, deps.site.timeZone, { userId: session.userId, email: session.email }),
      exact,
    )
  const exactOn = (session: AuthTokens, day: string) =>
    deps.api.myBookings(session, day).catch(() => [])

  /** HH:MM on the site's clock, for the CLI's text. */
  const clock = (iso: string) => toLocal(new Date(iso), deps.site.timeZone).slice(11, 16)

  return {
    'booking.status': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: { args: [], summary: 'whether you are signed in to the booking site' },
      params: noParams,
      run: async () => status(),
    }),

    /**
     * Ask the site for a login email, then watch Gmail for it and finish the
     * sign-in. Long-lived, but about 90 seconds all told (refused links and
     * Gmail's own time included; a poll under way finishes), so the agent's
     * command, cut off at two minutes, still hears the answer. When Gmail cannot be read, or
     * the mail is slow, it answers `signedIn: false` with the email sent, and
     * `booking.finish` takes the link the person pastes.
     */
    'booking.login': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: { args: ['email'], summary: 'email a login link and sign in with it from Gmail' },
      params: (raw) => {
        const p = paramsObject(raw)
        const email = stringParam(p, 'email').trim()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new CapabilityError('BAD_REQUEST', 'that is not an email address')
        }
        return { email }
      },
      run: async (ctx, { email }) => {
        const sent = await site(() => deps.auth.start(email))
        // Every answer is the sign-in as it now stands, and what to do next.
        const answer = async (message: string | null) => ({ ...(await status()), message })
        // One deadline for the whole watch: a refused link does not restart it.
        const deadline = now() + wait.timeoutMs
        // Still this login's email: a pasted link, a newer login or a sign-out
        // ends it, and then there is nothing left to watch for.
        const ours = () => deps.auth.pending()?.sentAt === sent.sentAt
        // Links the site refused: an older login's email can land within the
        // clock slack, and this login's own is still on its way.
        const refused = new Set<string>()
        // Why the last of them was refused: when no other link comes, it may
        // have been this login's own, and the person needs to hear why.
        let refusal: string | null = null
        for (;;) {
          let secret
          try {
            secret = await waitForLoginSecret(deps.mailFor(ctx.remote), host, sent.sentAt, {
              intervalMs: wait.intervalMs,
              ...(wait.sleep ? { sleep: wait.sleep } : {}),
              stop: () => !ours() || now() > deadline,
              skip: refused,
            })
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err)
            return answer(`Gmail could not be read here (${why}). ${PASTE}`)
          }
          if (!ours()) {
            const settled = await answer(null)
            if (settled.signedIn) return settled
            return { ...settled, message: 'This login was cancelled or replaced by a newer one.' }
          }
          if (secret === null) {
            if (refusal !== null) return answer(`The site refused the login link: ${refusal}`)
            return answer(`The email has not arrived yet. ${PASTE}`)
          }
          const text = secretText(secret)
          const took = await site(async () => {
            try {
              await deps.auth.finish(text)
              return true
            } catch (err) {
              const stale =
                err instanceof BookingApiError && (err.kind === 'auth' || err.kind === 'rejected')
              if (!stale) throw err
              refusal = err.message
              return false
            }
          })
          if (took) return answer(null)
          refused.add(text)
        }
      },
    }),

    /** Finish a sign-in with the link (or code) from the login email. */
    'booking.finish': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: { args: ['link'], summary: 'sign in with the link or code from the login email' },
      params: (raw) => ({ link: stringParam(paramsObject(raw), 'link') }),
      run: async (_ctx, { link }) => {
        await site(() => deps.auth.finish(link))
        return status()
      },
    }),

    'booking.logout': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: { args: [], summary: 'sign out of the booking site on this machine' },
      params: noParams,
      run: async () => {
        await deps.auth.signOut()
        return status()
      },
    }),

    /** The bookable rooms. Needs no sign-in. */
    'booking.rooms': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: { args: [], summary: 'the meeting rooms' },
      params: noParams,
      run: async () => site(() => deps.api.rooms()),
      text: (rooms: Room[]) => rooms.map((r) => `${r.name}\t${r.email}\t${r.id}`).join('\n'),
    }),

    /**
     * Every room's busy times on one of the site's days (today by default), as
     * the site's own booking page reads them: every company's bookings and the
     * rooms' Outlook events, not only those the caller may list.
     */
    'booking.availability': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: { args: ['day?'], summary: "every room's busy times on a day, YYYY-MM-DD (today)" },
      params: (raw) => {
        const day = optionalStringParam(paramsObject(raw), 'day')
        if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          throw new CapabilityError('BAD_REQUEST', '`day` is a date, like 2026-11-05')
        }
        return day === undefined ? {} : { day }
      },
      run: async (_ctx, p: { day?: string }) =>
        site(async () => {
          const [session, rooms] = await signedIn()
          const day = p.day ?? localDay(new Date(now()), deps.site.timeZone)
          const [days, exact] = await Promise.all([
            Promise.all(rooms.map((r) => deps.api.schedule(session, r.id, day))),
            exactOn(session, day),
          ])
          return {
            day,
            rooms: rooms.map((r, i): RoomDay => ({
              id: r.id,
              name: r.name,
              email: r.email,
              busy: busyOn(days[i]!, session, exact),
            })),
          }
        }),
      text: (a: { day: string; rooms: RoomDay[] }) =>
        [
          a.day,
          ...a.rooms.map(
            (r) =>
              `${r.name}\t${
                r.busy.length === 0
                  ? 'free all day'
                  : 'busy ' +
                    r.busy
                      .map(
                        (b) =>
                          `${clock(b.start)}–${clock(b.end)}${
                            b.mine ? ` (yours${b.bookingId ? `, id ${b.bookingId}` : ''})` : ''
                          }`,
                      )
                      .join(', ')
              }`,
          ),
        ].join('\n'),
    }),

    /**
     * Book a room. `room` is its id, its mailbox, its name ("Garage 2") or its
     * number ("2"). Refused when the room's schedule shows it taken; then
     * made through the site's own route, as its booking page does, so the
     * booking reaches the room's Outlook calendar. The site has the last word.
     */
    'booking.book': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: {
        args: ['room', 'start', 'end', 'title', 'description?'],
        summary: 'book a room from start to end (ISO instants)',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const start = instant(p, 'start')
        const end = instant(p, 'end')
        const title = stringParam(p, 'title').trim()
        const description = optionalStringParam(p, 'description')?.trim()
        if (end <= start)
          throw new CapabilityError('BAD_REQUEST', 'the booking must end after it starts')
        if (end.getTime() - start.getTime() > MAX_BOOKING_MS) {
          throw new CapabilityError('BAD_REQUEST', 'a booking can run at most 12 hours')
        }
        if (title === '' || title.length > 200) {
          throw new CapabilityError(
            'BAD_REQUEST',
            'a booking needs a title of at most 200 characters',
          )
        }
        return {
          room: stringParam(p, 'room'),
          start,
          end,
          title,
          ...(description ? { description: description.slice(0, 2000) } : {}),
        }
      },
      run: async (_ctx, b) => {
        if (b.start.getTime() < now() - PAST_SLACK_MS) {
          throw new CapabilityError('BAD_REQUEST', 'that time has passed')
        }
        return site(async (): Promise<MadeBooking> => {
          const [session, rooms] = await signedIn()
          const room = resolveRoom(rooms, b.room)
          const day = localDay(b.start, deps.site.timeZone)
          if (localDay(new Date(b.end.getTime() - 1), deps.site.timeZone) !== day) {
            throw new CapabilityError('BAD_REQUEST', 'a booking starts and ends on the same day')
          }
          const [slots, exact] = await Promise.all([
            deps.api.schedule(session, room.id, day),
            exactOn(session, day),
          ])
          const clash = busyOn(slots, session, exact).find(
            (x) => Date.parse(x.start) < b.end.getTime() && Date.parse(x.end) > b.start.getTime(),
          )
          if (clash !== undefined) {
            throw new CapabilityError(
              'CONFLICT',
              `${room.name} is busy from ${clock(clash.start)} to ${clock(clash.end)}`,
              TAKEN,
            )
          }
          await deps.api.createBooking(session, {
            roomId: room.id,
            title: b.title,
            description: b.description,
            start: b.start,
            end: b.end,
          })
          return {
            roomId: room.id,
            roomName: room.name,
            start: b.start.toISOString(),
            end: b.end.toISOString(),
            title: b.title,
          }
        })
      },
      text: (b: MadeBooking) =>
        `booked ${b.roomName}, ${clock(b.start)}–${clock(b.end)} on ${localDay(new Date(b.start), deps.site.timeZone)}: ${b.title}`,
    }),

    /**
     * Cancel one of the person's bookings by its id, which `availability`
     * gives for each booking that is theirs. Made through the site's own
     * route, as its bookings page does: the site checks the booking is the
     * caller's and takes it off the room's Outlook calendar.
     */
    'booking.cancel': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: GRANT,
      cli: { args: ['booking'], summary: 'cancel one of your bookings by its id' },
      params: (raw) => {
        const booking = stringParam(paramsObject(raw), 'booking').trim()
        if (!/^[\w-]{1,100}$/.test(booking)) {
          throw new CapabilityError('BAD_REQUEST', '`booking` is a booking id from availability')
        }
        return { booking }
      },
      run: async (_ctx, p: { booking: string }) =>
        site(async () => {
          await deps.api.cancelBooking(await deps.auth.session(), p.booking)
          return { cancelled: p.booking }
        }),
      text: (r: { cancelled: string }) => `cancelled booking ${r.cancelled}`,
    }),
  } satisfies CapabilityTable
}

/** The table's type, for the renderer's `capClient`. */
export type BookingCapabilities = ReturnType<typeof bookingCapabilities>

const PASTE = 'Paste the link from the email with booking.finish (holi booking finish <link>).'
/** The next step for the agent when the sign-in is gone. */
const SIGN_IN_AGAIN =
  "sign in again: run `holi booking login <the person's email>`, or ask the person to sign in under Mødelokale Booking in Holi's settings"
/** The next step for the agent when the slot is taken. */
const TAKEN = 'read `holi booking availability <day>` again and pick a free room or time'

/**
 * A room by id, mailbox, name or number. Names compare without spaces,
 * punctuation or case, so "garage 4" finds "Garage 4 – (MuteBox)".
 * @public exported for its test
 */
export function resolveRoom(rooms: readonly Room[], query: string): Room {
  const q = query.trim()
  const byKey = rooms.find((r) => r.id === q || r.email.toLowerCase() === q.toLowerCase())
  if (byKey !== undefined) return byKey
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = /^\d+$/.test(q) ? `garage${q}` : norm(q)
  const exact = rooms.filter((r) => norm(r.name) === wanted)
  if (exact.length === 1) return exact[0]!
  // A prefix, whose number is whole: "garage1" is not "garage10".
  const hits = rooms.filter((r) => {
    const name = norm(r.name)
    const cutsNumber = /\d$/.test(wanted) && /\d/.test(name[wanted.length] ?? '')
    return name.startsWith(wanted) && !cutsNumber
  })
  if (hits.length === 1) return hits[0]!
  const names = rooms.map((r) => r.name).join(', ')
  throw new CapabilityError(
    hits.length > 1 ? 'BAD_REQUEST' : 'NOT_FOUND',
    `${hits.length > 1 ? 'more than one room matches' : 'no room matches'} "${q}"; the rooms are ${names}`,
  )
}

/** A booking-site failure as a refusal the caller can act on. */
async function site<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (!(err instanceof BookingApiError)) throw err
    const codes: Record<BookingErrorKind, CapabilityError['code']> = {
      auth: 'UNAUTHORIZED',
      conflict: 'CONFLICT',
      rejected: 'BAD_REQUEST',
      'rate-limited': 'RATE_LIMITED',
      network: 'UNAVAILABLE',
    }
    const message =
      err.kind === 'conflict' ? `that room is already booked then (${err.message})` : err.message
    const next = err.kind === 'auth' ? SIGN_IN_AGAIN : err.kind === 'conflict' ? TAKEN : undefined
    throw new CapabilityError(codes[err.kind], message, next)
  }
}

function instant(p: Record<string, unknown>, key: string): Date {
  const raw = optionalStringParam(p, key)?.trim()
  if (raw === undefined) throw new CapabilityError('BAD_REQUEST', `\`${key}\` is required`)
  // An instant names its offset; a bare local time would mean main's zone.
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(raw)) {
    throw new CapabilityError(
      'BAD_REQUEST',
      `\`${key}\` must be an ISO instant with an offset, like 2026-11-05T10:00:00+01:00`,
    )
  }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime()))
    throw new CapabilityError('BAD_REQUEST', `\`${key}\` is not a date`)
  return d
}
