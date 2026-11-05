import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { BookingApiError, type AuthTokens, type BookingApi } from '../main/api'
import { createBookingAuth } from '../main/auth'
import type { SessionStore } from '../main/session-store'

const tokens = (over: Partial<AuthTokens> = {}): AuthTokens => ({
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 10_000_000,
  userId: 'user-1',
  email: 'me@example.test',
  ...over,
})

function memoryStore(
  initial: AuthTokens | null = null,
): SessionStore & { held: AuthTokens | null } {
  const s = {
    held: initial,
    read: async () => s.held,
    write: async (t: AuthTokens) => void (s.held = t),
    clear: async () => void (s.held = null),
  }
  return s
}

function fakeApi(over: Partial<BookingApi> = {}): BookingApi {
  const no = () => Promise.reject(new Error('not called'))
  return {
    sendLoginEmail: vi.fn(async () => {}),
    followLoginLink: no,
    exchangeCode: no,
    verifyCode: no,
    refresh: no,
    signOut: async () => {},
    rooms: no,
    schedule: no,
    createBooking: no,
    cancelBooking: no,
    myBookings: no,
    ...over,
  }
}

describe('booking sign-in', () => {
  it('sends a challenge only the verifier it kept can answer', async () => {
    let challenge = ''
    let verifier = ''
    const api = fakeApi({
      sendLoginEmail: async (_email, c) => void (challenge = c),
      followLoginLink: async () => ({ code: 'abc' }),
      exchangeCode: async (_code, v) => {
        verifier = v
        return tokens()
      },
    })
    const store = memoryStore()
    const auth = createBookingAuth({ api, store, now: () => 1000 })
    await auth.start('me@example.test')
    expect(auth.pending()).toEqual({ email: 'me@example.test', sentAt: 1000 })
    await auth.finish('https://booking.example.test/auth/v1/verify?token=x')
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
    expect(store.held).toMatchObject({ accessToken: 'access' })
    expect(auth.pending()).toBeNull()
  })

  it('refuses a link to a login it did not start, without spending it', async () => {
    const followLoginLink = vi.fn(async () => ({ code: 'abc' }))
    const auth = createBookingAuth({
      api: fakeApi({ followLoginLink }),
      store: memoryStore(),
    })
    await expect(auth.finish('https://booking.example.test/callback?code=abc')).rejects.toThrow(
      /did not start/,
    )
    expect(followLoginLink).not.toHaveBeenCalled()
  })

  it('finishes with a typed code for the pending email', async () => {
    const verifyCode = vi.fn(async () => tokens({ email: '' }))
    const store = memoryStore()
    const auth = createBookingAuth({ api: fakeApi({ verifyCode }), store })
    await auth.start('me@example.test')
    await auth.finish(' 123456 ')
    expect(verifyCode).toHaveBeenCalledWith('me@example.test', '123456')
    // The site's answer had no email; the one we asked with fills it in.
    expect(store.held?.email).toBe('me@example.test')
  })

  it('refreshes a token about to expire, once for racing callers', async () => {
    let t = 0
    const refresh = vi.fn(async () => tokens({ accessToken: 'new', expiresAt: 9_999_999 }))
    const store = memoryStore(tokens({ expiresAt: 1_000_000 }))
    const auth = createBookingAuth({ api: fakeApi({ refresh }), store, now: () => t })
    expect((await auth.session()).accessToken).toBe('access')
    expect(refresh).not.toHaveBeenCalled()
    // Inside the site's own 90-second margin: Holi must have renewed by then.
    t = 1_000_000 - 89_000
    const [a, b] = await Promise.all([auth.session(), auth.session()])
    expect(a.accessToken).toBe('new')
    expect(b.accessToken).toBe('new')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('signs out on a refused refresh, and stays signed in through a network failure', async () => {
    const store = memoryStore(tokens({ expiresAt: 0 }))
    const offline = createBookingAuth({
      api: fakeApi({ refresh: async () => Promise.reject(new BookingApiError('network', 'down')) }),
      store,
      now: () => 1,
    })
    await expect(offline.session()).rejects.toThrow('down')
    expect(store.held).not.toBeNull()

    const refused = createBookingAuth({
      api: fakeApi({ refresh: async () => Promise.reject(new BookingApiError('auth', 'revoked')) }),
      store,
      now: () => 1,
    })
    await expect(refused.session()).rejects.toThrow('revoked')
    expect(store.held).toBeNull()
    await expect(refused.session()).rejects.toMatchObject({ kind: 'auth' })
  })

  it('does not bring a session back that was signed out while it refreshed', async () => {
    let answer: (t: AuthTokens) => void = () => {}
    const refresh = () => new Promise<AuthTokens>((r) => (answer = r))
    const store = memoryStore(tokens({ expiresAt: 0 }))
    const auth = createBookingAuth({ api: fakeApi({ refresh }), store, now: () => 1 })
    const inFlight = auth.session()
    await auth.signOut()
    answer(tokens({ accessToken: 'new', expiresAt: 999_999 }))
    await expect(inFlight).rejects.toMatchObject({ kind: 'auth' })
    expect(store.held).toBeNull()
  })

  it('takes a session another refresh rotated in, rather than signing out', async () => {
    const store = memoryStore(tokens({ expiresAt: 0 }))
    const auth = createBookingAuth({
      api: fakeApi({
        // The token was spent by a refresh that wrote the file meanwhile.
        refresh: async () => {
          store.held = tokens({ accessToken: 'rotated', refreshToken: 'r2', expiresAt: 999_999 })
          throw new BookingApiError('rejected', 'Invalid Refresh Token: Already Used')
        },
      }),
      store,
      now: () => 1,
    })
    expect((await auth.session()).accessToken).toBe('rotated')
    expect(store.held?.refreshToken).toBe('r2')
  })

  it('keeps a sign-in that lands while a refused refresh is cleaned up', async () => {
    let refuse: () => void = () => {}
    let asked: () => void = () => {}
    const refreshAsked = new Promise<void>((r) => (asked = r))
    const refresh = () =>
      new Promise<AuthTokens>((_, reject) => {
        refuse = () => reject(new BookingApiError('rejected', 'Invalid Refresh Token'))
        asked()
      })
    const store = memoryStore(tokens({ expiresAt: 0 }))
    const fresh = tokens({ accessToken: 'fresh', refreshToken: 'r9', expiresAt: 999_999 })
    const auth = createBookingAuth({
      api: fakeApi({
        refresh,
        followLoginLink: async () => ({ code: 'abc' }),
        exchangeCode: async () => fresh,
      }),
      store,
      now: () => 1,
    })
    await auth.start('me@example.test')
    const inFlight = auth.session()
    await refreshAsked
    // The store answers the refresh's second look before the new sign-in is written.
    const read = store.read
    store.read = async () => {
      const held = await read()
      await auth.finish('https://booking.example.test/callback?code=abc')
      return held
    }
    refuse()
    await expect(inFlight).rejects.toMatchObject({ kind: 'auth' })
    expect(store.held?.accessToken).toBe('fresh')
  })

  it('reads a refused refresh as a sign-in to make again', async () => {
    const store = memoryStore(tokens({ expiresAt: 0 }))
    const auth = createBookingAuth({
      api: fakeApi({
        refresh: async () =>
          Promise.reject(new BookingApiError('rejected', 'Invalid Refresh Token')),
      }),
      store,
      now: () => 1,
    })
    await expect(auth.session()).rejects.toMatchObject({ kind: 'auth' })
    expect(store.held).toBeNull()
  })

  it('forgets the session on sign-out even when the site does not answer', async () => {
    const store = memoryStore(tokens())
    const auth = createBookingAuth({
      api: fakeApi({ signOut: async () => Promise.reject(new Error('offline')) }),
      store,
    })
    await auth.signOut()
    expect(store.held).toBeNull()
    expect(await auth.current()).toBeNull()
  })
})
