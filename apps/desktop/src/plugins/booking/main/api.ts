/**
 * The booking site's HTTP surface, and nothing else: Supabase's auth endpoints
 * (`/auth/v1`), the data API (`/rest/v1`, PostgREST) and the site's own
 * schedule and booking routes (`/api/...`). No state, no storage, no
 * Electron; `fetch` is injected so the tests never reach the site.
 *
 * Every failure is a `BookingApiError` with a kind the capabilities map to a
 * refusal: `auth` is a sign-in to make again, `conflict` a slot someone else
 * holds, `rejected` a request the site refused, `network` the site not
 * answering.
 */
import { toLocal, type ExactBooking, type SiteSlot } from './schedule'
import type { BookingSite } from './site'

export type BookingErrorKind = 'auth' | 'conflict' | 'rejected' | 'rate-limited' | 'network'

export class BookingApiError extends Error {
  constructor(
    readonly kind: BookingErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'BookingApiError'
  }
}

/** What the auth server hands back for a sign-in or a refresh. */
export interface AuthTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
  userId: string
  email: string
}

export interface Room {
  id: string
  name: string
  /** The room's own mailbox, such as `Garage4@birdsatfive.dk`. Stable where
   *  the display name is not, so the app places rooms by it. */
  email: string
  capacity: number | null
}

interface NewBooking {
  roomId: string
  title: string
  description?: string
  start: Date
  end: Date
}

type Fetch = typeof fetch

export interface BookingApi {
  /** Email a login link. `codeChallenge` makes it a PKCE link, so only the
   *  holder of the matching verifier (Holi) can turn it into a session. */
  sendLoginEmail(email: string, codeChallenge: string): Promise<void>
  /** Follow the emailed link to the auth server, without following it on to
   *  the site, and return the PKCE code the site's callback would have
   *  received. Only a code is taken: tokens in a link would sign in without
   *  the verifier, as whoever made the link. */
  followLoginLink(link: string): Promise<{ code: string }>
  exchangeCode(code: string, verifier: string): Promise<AuthTokens>
  /** A typed one-time code from the email, for a template that sends one. */
  verifyCode(email: string, code: string): Promise<AuthTokens>
  refresh(refreshToken: string): Promise<AuthTokens>
  signOut(accessToken: string): Promise<void>
  rooms(): Promise<Room[]>
  /** One room's day (`YYYY-MM-DD`, the site's local day) as the site's own
   *  booking page reads it: half-hour slots on the site's wall clock, every
   *  company's bookings and the room's Outlook events among the busy ones. */
  schedule(session: AuthTokens, roomId: string, day: string): Promise<SiteSlot[]>
  /** The person's own bookings around `day`, at their exact times, from the
   *  list the site's bookings page reads; cancelled ones left out. */
  myBookings(session: AuthTokens, day: string): Promise<ExactBooking[]>
  /** Book through the site's own route, which also puts the booking in the
   *  room's Outlook calendar. Times go on the site's wall clock. */
  createBooking(session: AuthTokens, booking: NewBooking): Promise<void>
  /** Cancel a booking through the site's own route, as its bookings page
   *  does; the site checks it is the caller's and takes it off Outlook. */
  cancelBooking(session: AuthTokens, bookingId: string): Promise<void>
}

const ROOM_COLUMNS = 'id,display_name,email_address,capacity'

export function createBookingApi(site: BookingSite, fetchImpl: Fetch = fetch): BookingApi {
  const host = new URL(site.base).host

  /** `fetch`, never following a redirect, a body sent as JSON, and a site
   *  that does not answer as a network failure. */
  async function send(
    url: string,
    init: { method?: string; headers: Record<string, string>; body?: unknown },
  ): Promise<Response> {
    const json = init.body !== undefined
    try {
      return await fetchImpl(url, {
        method: init.method ?? (json ? 'POST' : 'GET'),
        redirect: 'manual',
        headers: json ? { ...init.headers, 'Content-Type': 'application/json' } : init.headers,
        ...(json ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch (err) {
      throw new BookingApiError(
        'network',
        `the booking site did not answer: ${(err as Error).message}`,
      )
    }
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown; token?: string },
  ): Promise<Response> {
    const res = await send(`${site.base}${path}`, {
      ...init,
      headers: { apikey: site.anonKey, Authorization: `Bearer ${init.token ?? site.anonKey}` },
    })
    if (res.ok) return res
    throw await failure(res)
  }

  async function json(path: string, init: Parameters<typeof request>[1]): Promise<unknown> {
    return readJson(await request(path, init))
  }

  async function tokens(path: string, body: unknown): Promise<AuthTokens> {
    return readTokens(await json(path, { method: 'POST', body }))
  }

  /**
   * One of the site's own routes (`/api/...`), which read the session from the
   * cookie the site's pages carry, as those pages send it. A redirect is the
   * site's middleware sending a signed-out caller to its login page.
   */
  async function siteRequest(
    path: string,
    session: AuthTokens,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const res = await send(`${site.base}${path}`, {
      ...init,
      headers: { Accept: 'application/json', Cookie: sessionCookie(session, host) },
    })
    if (res.status >= 300 && res.status < 400) {
      throw new BookingApiError('auth', 'the booking site asked to sign in again')
    }
    if (!res.ok) throw await failure(res)
    return res
  }

  return {
    async sendLoginEmail(email, codeChallenge) {
      const redirect = encodeURIComponent(site.callback)
      await request(`/auth/v1/otp?redirect_to=${redirect}`, {
        method: 'POST',
        // `create_user: false`: Holi signs people in, it never signs them up.
        body: {
          email,
          create_user: false,
          data: {},
          code_challenge: codeChallenge,
          code_challenge_method: 's256',
        },
      })
    },

    async followLoginLink(link) {
      const url = loginUrl(link, host)
      // A link that already landed on the callback carries its code.
      const direct = fromCallback(url.toString())
      if (direct !== null) return direct
      const res = await send(url.toString(), { headers: { apikey: site.anonKey } })
      const location = res.headers.get('location')
      if (res.status < 300 || res.status >= 400 || location === null) {
        throw new BookingApiError(
          'auth',
          'that login link did not sign in; it may be used or expired',
        )
      }
      const landed = fromCallback(new URL(location, site.base).toString())
      if (landed === null) {
        // No code: GoTrue sends an expired or used link to the callback with an
        // error, and a link from a login without PKCE carries tokens instead.
        const reason = new URL(location, site.base)
        const why =
          reason.searchParams.get('error_description') ??
          new URLSearchParams(reason.hash.slice(1)).get('error_description')
        throw new BookingApiError('auth', why ?? 'that login link did not sign in')
      }
      return landed
    },

    exchangeCode: (code, verifier) =>
      tokens('/auth/v1/token?grant_type=pkce', { auth_code: code, code_verifier: verifier }),

    verifyCode: (email, code) => tokens('/auth/v1/verify', { type: 'email', email, token: code }),

    refresh: (refreshToken) =>
      tokens('/auth/v1/token?grant_type=refresh_token', { refresh_token: refreshToken }),

    async signOut(accessToken) {
      await request('/auth/v1/logout?scope=local', { method: 'POST', token: accessToken })
    },

    async rooms() {
      const rows = await json(
        `/rest/v1/rooms?select=${ROOM_COLUMNS}&is_active=eq.true&order=display_name`,
        {},
      )
      // An answer that is not a list is the site failing, not a site with no
      // rooms: read as one, `book` would say the room does not exist.
      if (!Array.isArray(rows))
        throw new BookingApiError('network', 'the booking site sent no rooms')
      return (rows as Record<string, unknown>[]).map(readRoom)
    },

    async schedule(session, roomId, day) {
      const body = (await readJson(
        await siteRequest(
          `/api/rooms/${encodeURIComponent(roomId)}/schedule?date=${encodeURIComponent(day)}`,
          session,
        ),
      )) as { time_slots?: unknown } | null
      // The site always lists the day's slots, free ones too. An answer
      // without them is not an empty day: read as one, every room would show
      // free and a booking would skip its clash check.
      if (!Array.isArray(body?.time_slots)) {
        throw new BookingApiError('network', 'the booking site sent no schedule')
      }
      return body.time_slots as SiteSlot[]
    },

    async myBookings(session, day) {
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      const body = (await readJson(
        await siteRequest(`/api/bookings?date_start=${day}&date_end=${next}`, session),
      )) as { bookings?: unknown } | null
      if (!Array.isArray(body?.bookings)) {
        throw new BookingApiError('network', 'the booking site sent no bookings')
      }
      return (body.bookings as Record<string, unknown>[]).flatMap((b) =>
        b.status !== 'cancelled' &&
        typeof b.id === 'string' &&
        typeof b.start_time === 'string' &&
        typeof b.end_time === 'string'
          ? [
              {
                id: b.id,
                start: new Date(b.start_time).toISOString(),
                end: new Date(b.end_time).toISOString(),
              },
            ]
          : [],
      )
    },

    async createBooking(session, b) {
      // Any 2xx is the booking made; its body is not read, so an answer that
      // is not JSON never reports a booking that was made as a failure.
      await siteRequest('/api/bookings', session, {
        body: {
          room_id: b.roomId,
          title: b.title,
          description: b.description ?? null,
          start_time: toLocal(b.start, site.timeZone),
          end_time: toLocal(b.end, site.timeZone),
        },
      })
    },

    async cancelBooking(session, bookingId) {
      // As with a booking, any 2xx is done and the body is not read.
      await siteRequest(`/api/bookings/${encodeURIComponent(bookingId)}`, session, {
        method: 'DELETE',
      })
    },
  }
}

/**
 * The emailed link, only if it points at the booking site. A link from a mail
 * is untrusted input: Holi follows exactly one kind, to exactly one host.
 */
function loginUrl(link: string, host: string): URL {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new BookingApiError('rejected', 'that is not a link')
  }
  if (url.protocol !== 'https:' || url.host !== host) {
    throw new BookingApiError('rejected', `a login link must point at ${host}`)
  }
  return url
}

/** The PKCE `code` the site's callback would have read, or null. */
function fromCallback(location: string): { code: string } | null {
  const code = new URL(location).searchParams.get('code')
  return code !== null && code !== '' ? { code } : null
}

/** The longest a cookie value gets before the site's client splits it. */
const COOKIE_CHUNK = 3180

/**
 * The session as the site's pages carry it: Supabase's SSR cookie,
 * `sb-<first label of the host>-auth-token`, holding `base64-` and the session
 * JSON, split into `.0`, `.1`… when long. The site's routes read nothing else.
 * Holi refreshes a token minutes before it expires, well before the site's
 * own client would, so the site never needs to (auth.ts says why it matters).
 * @public exported for its test
 */
export function sessionCookie(t: AuthTokens, host: string): string {
  const name = `sb-${host.split('.')[0]}-auth-token`
  const session = {
    access_token: t.accessToken,
    token_type: 'bearer',
    expires_in: Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)),
    expires_at: Math.floor(t.expiresAt / 1000),
    refresh_token: t.refreshToken,
    user: { id: t.userId, email: t.email, aud: 'authenticated', role: 'authenticated' },
  }
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
  if (value.length <= COOKIE_CHUNK) return `${name}=${value}`
  const parts: string[] = []
  for (let i = 0; i * COOKIE_CHUNK < value.length; i++) {
    parts.push(`${name}.${i}=${value.slice(i * COOKIE_CHUNK, (i + 1) * COOKIE_CHUNK)}`)
  }
  return parts.join('; ')
}

/** A body as JSON, null when empty. A page that is not JSON (an error page
 *  in front of the site, say) is the site not answering as it should. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BookingApiError('network', 'the booking site did not answer with data')
  }
}

async function failure(res: Response): Promise<BookingApiError> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const message = String(
    body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? `HTTP ${res.status}`,
  )
  if (res.status === 409) return new BookingApiError('conflict', message)
  if (res.status === 401) return new BookingApiError('auth', message)
  if (res.status === 429)
    return new BookingApiError('rate-limited', 'the booking site asks to wait a moment')
  return new BookingApiError(res.status >= 500 ? 'network' : 'rejected', message)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function readRoom(row: Record<string, unknown>): Room {
  return {
    id: str(row.id),
    name: str(row.display_name),
    email: str(row.email_address),
    capacity: typeof row.capacity === 'number' ? row.capacity : null,
  }
}

function readTokens(value: unknown): AuthTokens {
  const v = (value ?? {}) as Record<string, unknown>
  const user = (v.user ?? {}) as Record<string, unknown>
  if (typeof v.access_token !== 'string' || typeof v.refresh_token !== 'string') {
    throw new BookingApiError('auth', 'the booking site did not return a session')
  }
  const expiresAt =
    typeof v.expires_at === 'number'
      ? v.expires_at * 1000
      : Date.now() + (typeof v.expires_in === 'number' ? v.expires_in : 3600) * 1000
  return {
    accessToken: v.access_token,
    refreshToken: v.refresh_token,
    expiresAt,
    userId: str(user.id),
    email: str(user.email),
  }
}
