import { describe, expect, it } from 'vitest'
import { BookingApiError, createBookingApi, sessionCookie, type AuthTokens } from '../main/api'
import { fakeFetch, json, SITE } from './helpers'

const session = {
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in: 3600,
  user: { id: 'user-1', email: 'me@example.test' },
}

const SESSION: AuthTokens = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: Date.parse('2030-01-01T00:00:00Z'),
  userId: 'user-1',
  email: 'me@example.test',
}

describe('the session cookie', () => {
  it('is the site client’s own: its name, `base64-` and the session JSON', () => {
    const cookie = sessionCookie(SESSION, 'booking.example.test')
    const [name, value] = cookie.split('=') as [string, string]
    expect(name).toBe('sb-booking-auth-token')
    expect(value.startsWith('base64-')).toBe(true)
    const session = JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8'))
    expect(session).toMatchObject({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: Date.parse('2030-01-01T00:00:00Z') / 1000,
      user: { id: 'user-1', email: 'me@example.test' },
    })
  })

  it('splits a long session into numbered cookies, as the site’s client does', () => {
    const cookie = sessionCookie({ ...SESSION, accessToken: 'a'.repeat(5000) }, 'booking.x.test')
    const parts = cookie.split('; ').map((p) => p.split('=')[0])
    expect(parts).toEqual([
      'sb-booking-auth-token.0',
      'sb-booking-auth-token.1',
      'sb-booking-auth-token.2',
    ])
  })
})

describe('booking site client', () => {
  it('asks for a PKCE login email that lands on the callback, and never signs anyone up', async () => {
    const f = fakeFetch(() => json({}))
    await createBookingApi(SITE, f.fetch).sendLoginEmail('me@example.test', 'challenge')
    const [req] = f.seen
    expect(req!.url).toBe(
      `${SITE.base}/auth/v1/otp?redirect_to=${encodeURIComponent(SITE.callback)}`,
    )
    expect(req!.headers.apikey).toBe('anon-key')
    expect(req!.body).toMatchObject({
      email: 'me@example.test',
      create_user: false,
      code_challenge: 'challenge',
      code_challenge_method: 's256',
    })
  })

  it('follows a login link one hop, to the code the callback would get', async () => {
    const f = fakeFetch(
      () => new Response(null, { status: 303, headers: { location: `${SITE.callback}?code=abc` } }),
    )
    const api = createBookingApi(SITE, f.fetch)
    const landed = await api.followLoginLink(
      `${SITE.base}/auth/v1/verify?token=pkce_x&type=magiclink&redirect_to=${SITE.callback}`,
    )
    expect(landed).toEqual({ code: 'abc' })
    expect(f.seen).toHaveLength(1)
  })

  it('takes a link that already landed without fetching it', async () => {
    const f = fakeFetch(() => json({}))
    const landed = await createBookingApi(SITE, f.fetch).followLoginLink(
      `${SITE.callback}?code=xyz`,
    )
    expect(landed).toEqual({ code: 'xyz' })
    expect(f.seen).toHaveLength(0)
  })

  it('refuses a link to any other host, or over http', async () => {
    const api = createBookingApi(SITE, fakeFetch(() => json({})).fetch)
    await expect(api.followLoginLink('https://evil.test/auth/v1/verify?token=x')).rejects.toThrow(
      /must point at booking\.example\.test/,
    )
    await expect(
      api.followLoginLink('http://booking.example.test/auth/v1/verify?token=x'),
    ).rejects.toThrow(/must point at/)
  })

  it('takes no tokens from a link, only a code its verifier answers', async () => {
    const tokens = 'access_token=theirs&refresh_token=theirs'
    const f = fakeFetch(
      () =>
        new Response(null, { status: 303, headers: { location: `${SITE.callback}#${tokens}` } }),
    )
    const api = createBookingApi(SITE, f.fetch)
    await expect(api.followLoginLink(`${SITE.base}/auth/v1/verify?token=t`)).rejects.toThrow(
      /did not sign in/,
    )
    await expect(
      api.followLoginLink(`${SITE.base}/auth/v1/verify?token=t#${tokens}`),
    ).rejects.toThrow(/did not sign in/)
  })

  it('says why a used link failed', async () => {
    const f = fakeFetch(
      () =>
        new Response(null, {
          status: 303,
          headers: {
            location: `${SITE.callback}#error=access_denied&error_description=Email+link+is+invalid+or+has+expired`,
          },
        }),
    )
    await expect(
      createBookingApi(SITE, f.fetch).followLoginLink(`${SITE.base}/auth/v1/verify?token=t`),
    ).rejects.toThrow('Email link is invalid or has expired')
  })

  it('exchanges the code with the verifier for a session', async () => {
    const f = fakeFetch(() => json(session))
    const tokens = await createBookingApi(SITE, f.fetch).exchangeCode('abc', 'verifier')
    expect(f.seen[0]!.url).toBe(`${SITE.base}/auth/v1/token?grant_type=pkce`)
    expect(f.seen[0]!.body).toEqual({ auth_code: 'abc', code_verifier: 'verifier' })
    expect(tokens).toMatchObject({
      accessToken: 'access',
      userId: 'user-1',
      email: 'me@example.test',
    })
  })

  it('reads a room’s schedule from the site’s own route, signed in by its cookie', async () => {
    const f = fakeFetch(() =>
      json({
        time_slots: [{ start: '2026-11-05T09:00:00', end: '2026-11-05T09:30:00', status: 'busy' }],
      }),
    )
    const day = await createBookingApi(SITE, f.fetch).schedule(SESSION, 'room 1', '2026-11-05')
    expect(f.seen[0]!.url).toBe(`${SITE.base}/api/rooms/room%201/schedule?date=2026-11-05`)
    expect(f.seen[0]!.headers.Cookie).toBe(sessionCookie(SESSION, 'booking.example.test'))
    expect(day).toEqual([
      { start: '2026-11-05T09:00:00', end: '2026-11-05T09:30:00', status: 'busy' },
    ])
  })

  it('reads a rooms answer that is not a list as the site failing, never as no rooms', async () => {
    for (const answer of [json({}), new Response('', { status: 200 })]) {
      await expect(
        createBookingApi(SITE, fakeFetch(() => answer).fetch).rooms(),
      ).rejects.toMatchObject({ kind: 'network' })
    }
  })

  it('reads an answer with no slots as the site failing, never as a free day', async () => {
    for (const answer of [json({}), new Response('', { status: 200 })]) {
      await expect(
        createBookingApi(SITE, fakeFetch(() => answer).fetch).schedule(SESSION, 'r1', '2026-11-05'),
      ).rejects.toMatchObject({ kind: 'network' })
    }
  })

  it('books through the site’s route, in the site’s wall-clock time', async () => {
    const f = fakeFetch(() => json({ ok: true }, 201))
    await createBookingApi(SITE, f.fetch).createBooking(SESSION, {
      roomId: 'r1',
      title: 'Client call',
      start: new Date('2026-11-05T09:00:00Z'),
      end: new Date('2026-11-05T10:00:00Z'),
    })
    expect(f.seen[0]!.url).toBe(`${SITE.base}/api/bookings`)
    expect(f.seen[0]!.method).toBe('POST')
    // 09:00 UTC is 10:00 in Oslo in November.
    expect(f.seen[0]!.body).toEqual({
      room_id: 'r1',
      title: 'Client call',
      description: null,
      start_time: '2026-11-05T10:00:00',
      end_time: '2026-11-05T11:00:00',
    })
  })

  it('reads the person’s bookings at their exact times, leaving out cancelled ones', async () => {
    const f = fakeFetch(() =>
      json({
        bookings: [
          {
            id: 'b1',
            status: 'confirmed',
            start_time: '2026-11-05T12:30:00+00:00',
            end_time: '2026-11-05T13:15:00+00:00',
          },
          {
            id: 'b2',
            status: 'cancelled',
            start_time: '2026-11-05T08:30:00+00:00',
            end_time: '2026-11-05T08:45:00+00:00',
          },
        ],
      }),
    )
    const mine = await createBookingApi(SITE, f.fetch).myBookings(SESSION, '2026-11-05')
    expect(f.seen[0]!.url).toBe(
      `${SITE.base}/api/bookings?date_start=2026-11-05&date_end=2026-11-06`,
    )
    expect(mine).toEqual([
      { id: 'b1', start: '2026-11-05T12:30:00.000Z', end: '2026-11-05T13:15:00.000Z' },
    ])
  })

  it('cancels through the site’s route, as its bookings page does', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }))
    await createBookingApi(SITE, f.fetch).cancelBooking(SESSION, 'b 1')
    expect(f.seen[0]!.url).toBe(`${SITE.base}/api/bookings/b%201`)
    expect(f.seen[0]!.method).toBe('DELETE')
  })

  it('reads the site sending a caller to its login page as a sign-in to make again', async () => {
    const f = fakeFetch(() => new Response(null, { status: 307, headers: { location: '/login' } }))
    await expect(
      createBookingApi(SITE, f.fetch).schedule(SESSION, 'r1', '2026-11-05'),
    ).rejects.toMatchObject({ kind: 'auth' })
  })

  it('reads a page that is not JSON as the site not answering, not a crash', async () => {
    const f = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 200 }))
    await expect(
      createBookingApi(SITE, f.fetch).schedule(SESSION, 'r1', '2026-11-05'),
    ).rejects.toMatchObject({ kind: 'network' })
  })

  it('takes any 2xx as the booking made, whatever its body', async () => {
    const f = fakeFetch(() => new Response('<html>Created</html>', { status: 201 }))
    await expect(
      createBookingApi(SITE, f.fetch).createBooking(SESSION, {
        roomId: 'r1',
        title: 'x',
        start: new Date(),
        end: new Date(),
      }),
    ).resolves.toBeUndefined()
  })

  it('passes on why the site refused a booking', async () => {
    const f = fakeFetch(() => json({ error: 'Room is not available' }, 409))
    await expect(
      createBookingApi(SITE, f.fetch).createBooking(SESSION, {
        roomId: 'r1',
        title: 'x',
        start: new Date(),
        end: new Date(),
      }),
    ).rejects.toMatchObject({ kind: 'conflict', message: 'Room is not available' })
  })

  it('names the site asking to wait a rate limit, not a failure', async () => {
    const f = fakeFetch(() => json({ error: 'Too many requests' }, 429))
    await expect(
      createBookingApi(SITE, f.fetch).schedule(SESSION, 'r1', '2026-11-05'),
    ).rejects.toMatchObject({ kind: 'rate-limited' })
  })

  it('names a session the site refuses an auth failure', async () => {
    const f = fakeFetch(() => json({ error: 'Unauthorized' }, 401))
    await expect(
      createBookingApi(SITE, f.fetch).schedule(SESSION, 'r1', '2026-11-05'),
    ).rejects.toMatchObject({ kind: 'auth', message: 'Unauthorized' })
  })

  it('names a site that does not answer a network failure', async () => {
    const api = createBookingApi(SITE, (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch)
    const err = await api.rooms().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BookingApiError)
    expect(err).toMatchObject({ kind: 'network' })
  })
})
