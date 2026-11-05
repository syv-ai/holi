import { describe, expect, it, vi } from 'vitest'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'
import { BookingApiError, type BookingApi } from '../main/api'
import type { BookingAuth } from '../main/auth'
import { BOOKING_NAMESPACES, bookingCapabilities, resolveRoom } from '../main/capabilities'
import type { MailLookup } from '../main/login-mail'
import type { SiteSlot } from '../main/schedule'
import { ROOMS, SITE } from './helpers'

const NOW = Date.parse('2026-11-05T08:00:00Z')
const ctx = { remote: 'o/r', root: '/v', bundle: null } as unknown as CapabilityContext
const appCtx = { ...ctx, bundle: 'Booking.local.app' } as CapabilityContext

/** A busy half hour on the site's clock (Oslo). */
const busy = (start: string, booking?: SiteSlot['booking']): SiteSlot => {
  const [h, m] = start.split(':').map(Number) as [number, number]
  const end = h * 60 + m + 30
  const hm = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
  return {
    start: `2026-11-05T${start}:00`,
    end: `2026-11-05T${hm}:00`,
    status: 'busy',
    ...(booking === undefined ? {} : { booking }),
  }
}

const SESSION = {
  accessToken: 't',
  refreshToken: 'r',
  expiresAt: NOW + 3_600_000,
  userId: 'user-1',
  email: 'me@example.test',
}

function setup(
  opts: {
    schedules?: Record<string, SiteSlot[]>
    /** The person's own bookings at their exact times. */
    exact?: { id: string; start: string; end: string }[]
    mail?: MailLookup
    signedIn?: boolean
    polls?: number
    /** The login's budget and poll interval, when not one poll per `polls`. */
    wait?: { timeoutMs: number; intervalMs: number }
  } = {},
) {
  // A clock the login's sleeps (and the test's slow Gmail) move forward.
  const clock = { t: NOW }
  const createBooking = vi.fn<BookingApi['createBooking']>(async () => {})
  const schedule = vi.fn<BookingApi['schedule']>(
    async (_s, roomId) => opts.schedules?.[roomId] ?? [],
  )
  const cancelBooking = vi.fn<BookingApi['cancelBooking']>(async () => {})
  const myBookings = vi.fn<BookingApi['myBookings']>(async () => opts.exact ?? [])
  const api = {
    rooms: async () => ROOMS,
    schedule,
    createBooking,
    cancelBooking,
    myBookings,
  } as unknown as BookingApi
  const finish = vi.fn(async (_input: string) => ({ email: 'me@example.test' }))
  let signedIn = opts.signedIn ?? true
  let pending: { email: string; sentAt: number } | null = null
  const auth: BookingAuth = {
    current: async () => (signedIn ? { email: 'me@example.test', userId: 'user-1' } : null),
    pending: () => pending,
    start: async (email) => (pending = { email, sentAt: NOW }),
    finish: async (input) => {
      const done = await finish(input)
      signedIn = true
      pending = null
      return done
    },
    session: async () => SESSION,
    signOut: async () => {},
  }
  const registry = createCapabilityRegistry()
  registry.register(
    BOOKING_NAMESPACES,
    bookingCapabilities({
      site: SITE,
      api,
      auth,
      mailFor: () => opts.mail ?? { search: async () => [], messages: async () => [] },
      loginWait: {
        ...(opts.wait ?? { timeoutMs: (opts.polls ?? 1) - 1, intervalMs: 1 }),
        sleep: async (ms) => void (clock.t += ms),
      },
      now: () => clock.t,
    }),
  )
  const run = (name: string, params: unknown) => registry.run(name, 'cli', ctx, params)
  return { registry, run, createBooking, cancelBooking, schedule, finish, auth, clock }
}

describe('booking capabilities', () => {
  it('opens every entry to the app door only behind the booking grant', async () => {
    const { registry } = setup()
    const names = Object.keys(
      bookingCapabilities({ site: SITE } as Parameters<typeof bookingCapabilities>[0]),
    )
    expect(names).toContain('booking.cancel')
    // Params each entry accepts, so the door is what refuses.
    const params: Record<string, unknown> = {
      'booking.login': { email: 'me@example.test' },
      'booking.finish': { link: `${SITE.base}/auth/v1/verify?token=t` },
      'booking.book': {
        room: '1',
        start: '2026-11-05T12:00:00Z',
        end: '2026-11-05T13:00:00Z',
        title: 'x',
      },
      'booking.cancel': { booking: 'b1' },
    }
    for (const name of names) {
      const p = params[name] ?? {}
      await expect(registry.run(name, 'app', appCtx, p), name).rejects.toThrow('no such method')
      const admit = vi.fn(async () => {})
      await registry.run(name, 'app', appCtx, p, admit).catch(() => {})
      expect(admit, name).toHaveBeenCalledWith(appCtx, 'booking')
    }
  })

  it('gives the person’s own bookings their exact times, not the schedule’s half hours', async () => {
    const mine = { id: 'b1', title: 'Meeting', user_id: 'user-1' }
    const { run } = setup({
      // 13:30–14:15 fills the 13:30 and 14:00 slots.
      schedules: { 'room-4': [busy('13:30', mine), busy('14:00', mine)] },
      exact: [{ id: 'b1', start: '2026-11-05T12:30:00.000Z', end: '2026-11-05T13:15:00.000Z' }],
    })
    const result = await run('booking.availability', { day: '2026-11-05' })
    expect(result.text).toContain('Garage 4 – (MuteBox)\tbusy 13:30–14:15 (yours, id b1)')
  })

  it('reads every room’s busy times from the site’s schedule', async () => {
    const { run } = setup({
      schedules: {
        'room-1': [busy('09:00'), busy('09:30')],
        'room-3': [busy('10:00', { id: 'b1', title: 'Standup', user_id: 'user-1' })],
      },
    })
    const result = await run('booking.availability', { day: '2026-11-05' })
    expect(result.text).toBe(
      [
        '2026-11-05',
        'Garage1\tbusy 09:00–10:00',
        'Garage2\tfree all day',
        'Garage3\tbusy 10:00–10:30 (yours, id b1)',
        'Garage 4 – (MuteBox)\tfree all day',
        'Garage 5 (MuteBox)\tfree all day',
        'Garage 6 – (MuteBox Meet)\tfree all day',
      ].join('\n'),
    )
  })

  it('books a free slot through the site, on the site’s clock', async () => {
    const { run, createBooking } = setup({ schedules: { 'room-1': [busy('11:00')] } })
    const result = await run('booking.book', {
      room: 'garage 2',
      // A pasted argument may carry spaces around it.
      start: ' 2026-11-05T10:00:00Z ',
      end: '2026-11-05T11:00:00+00:00',
      title: '  Client call ',
    })
    expect(createBooking).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ roomId: 'room-2', title: 'Client call' }),
    )
    expect(result.text).toBe('booked Garage2, 11:00–12:00 on 2026-11-05: Client call')
  })

  it('refuses a slot the schedule shows taken, by anyone, as a conflict', async () => {
    const { run, createBooking } = setup({ schedules: { 'room-2': [busy('11:30')] } })
    await expect(
      run('booking.book', {
        room: '2',
        start: '2026-11-05T10:00:00Z',
        end: '2026-11-05T11:00:00Z',
        title: 'x',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Garage2 is busy from 11:30 to 12:00',
      next: expect.stringContaining('holi booking availability'),
    })
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('tells the agent how to sign in again when the sign-in is gone', async () => {
    const { run, auth } = setup()
    auth.session = async () => Promise.reject(new BookingApiError('auth', 'not signed in'))
    await expect(run('booking.availability', {})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      next: expect.stringContaining('holi booking login'),
    })
  })

  it('cancels one of the person’s bookings by its id, through the site', async () => {
    const { run, cancelBooking } = setup()
    const result = await run('booking.cancel', { booking: 'b1' })
    expect(cancelBooking).toHaveBeenCalledWith(SESSION, 'b1')
    expect(result.text).toBe('cancelled booking b1')
  })

  it('takes only a booking id to cancel, and passes on the site refusing', async () => {
    const { run, cancelBooking } = setup()
    await expect(run('booking.cancel', { booking: '../rooms' })).rejects.toThrow(/booking id/)
    expect(cancelBooking).not.toHaveBeenCalled()
    cancelBooking.mockRejectedValueOnce(new BookingApiError('rejected', 'Not your booking'))
    await expect(run('booking.cancel', { booking: 'b2' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Not your booking',
    })
  })

  it('books within one of the site’s days', async () => {
    const { run } = setup()
    await expect(
      run('booking.book', {
        room: '1',
        start: '2026-11-05T22:00:00Z',
        end: '2026-11-05T23:30:00Z',
        title: 'x',
      }),
    ).rejects.toThrow(/same day/)
  })

  it('wants instants with an offset, in order, in the future', async () => {
    const { run } = setup()
    const book = (start: string, end: string) =>
      run('booking.book', { room: '1', start, end, title: 'x' })
    await expect(book('2026-11-05T10:00', '2026-11-05T11:00')).rejects.toThrow(/with an offset/)
    await expect(book('2026-11-05T11:00Z', '2026-11-05T10:00Z')).rejects.toThrow(/end after/)
    await expect(book('2026-11-05T06:00Z', '2026-11-05T07:00Z')).rejects.toThrow(/has passed/)
    await expect(book('2026-11-05T10:00Z', '2026-11-06T10:00Z')).rejects.toThrow(/12 hours/)
  })

  it('watches Gmail for its time, counting the time Gmail takes to answer', async () => {
    let slow = (_ms: number) => {}
    const mail: MailLookup = {
      search: async () => (slow(2_000), []),
      messages: async () => [],
    }
    const { run, clock } = setup({
      mail,
      signedIn: false,
      wait: { timeoutMs: 90_000, intervalMs: 4_000 },
    })
    slow = (ms) => void (clock.t += ms)
    const result = await run('booking.login', { email: 'me@example.test' })
    expect(result.value).toMatchObject({ signedIn: false })
    // The deadline, plus at most the poll under way and the sleep before the
    // stop: well inside the two minutes the agent's command gets.
    expect(clock.t - NOW).toBeLessThanOrEqual(96_000)
  })

  it('signs in from Gmail when the email arrives', async () => {
    const link = `${SITE.base}/auth/v1/verify?token=pkce_x`
    const mail: MailLookup = {
      search: async () => [{ id: 't', date: new Date(NOW).toISOString() }],
      messages: async () => [{ date: new Date(NOW).toISOString(), body: link, html: null }],
    }
    const { run, finish } = setup({ mail, signedIn: false })
    const result = await run('booking.login', { email: 'me@example.test' })
    expect(finish).toHaveBeenCalledWith(link)
    expect(result.value).toMatchObject({ signedIn: true, email: 'me@example.test', message: null })
  })

  it('says why the site refused a link when no other comes', async () => {
    const link = `${SITE.base}/auth/v1/verify?token=pkce_x`
    const mail: MailLookup = {
      search: async () => [{ id: 't', date: new Date(NOW).toISOString() }],
      messages: async () => [{ date: new Date(NOW).toISOString(), body: link, html: null }],
    }
    const { run, finish } = setup({ mail, signedIn: false, polls: 2 })
    finish.mockRejectedValue(new BookingApiError('auth', 'Email link is invalid or has expired'))
    const result = await run('booking.login', { email: 'me@example.test' })
    expect(result.value).toMatchObject({ signedIn: false })
    expect((result.value as { message: string }).message).toContain('invalid or has expired')
  })

  it('passes over an older login’s link and signs in with this one’s', async () => {
    const at = new Date(NOW).toISOString()
    const older = `${SITE.base}/auth/v1/verify?token=pkce_old`
    const newer = `${SITE.base}/auth/v1/verify?token=pkce_new`
    let polls = 0
    const mail: MailLookup = {
      search: async () => [{ id: 't', date: at }],
      // This login's email arrives on the third look; the older one is there from the start.
      messages: async () => [
        { date: at, body: older, html: null },
        ...(++polls >= 3 ? [{ date: at, body: newer, html: null }] : []),
      ],
    }
    const { run, finish } = setup({ mail, signedIn: false, polls: 5 })
    finish.mockImplementation(async (input) => {
      if (input === older) throw new BookingApiError('auth', 'Email link is invalid or has expired')
      return { email: 'me@example.test' }
    })
    const result = await run('booking.login', { email: 'me@example.test' })
    expect(finish.mock.calls.map(([input]) => input)).toEqual([older, newer])
    expect(result.value).toMatchObject({ signedIn: true, message: null })
  })

  it('asks for the pasted link when Gmail cannot be read', async () => {
    const mail: MailLookup = {
      search: async () => Promise.reject(new Error('no such method: google.search')),
      messages: async () => [],
    }
    const { run, finish } = setup({ mail, signedIn: false })
    const result = await run('booking.login', { email: 'me@example.test' })
    expect(finish).not.toHaveBeenCalled()
    expect(result.value).toMatchObject({ signedIn: false })
    expect((result.value as { message: string }).message).toMatch(
      /Gmail could not be read here \(no such method: google.search\)/,
    )
  })

  it('stops watching Gmail once the sign-in finished another way', async () => {
    const search = vi.fn(async () => [])
    const mail: MailLookup = { search, messages: async () => [] }
    const { registry, auth } = setup({ mail, signedIn: false, polls: 10 })
    // The person pastes the link while the first poll is out.
    search.mockImplementationOnce(async () => {
      await auth.finish('https://booking.example.test/callback?code=c')
      return []
    })
    const result = await registry.run('booking.login', 'cli', ctx, { email: 'me@example.test' })
    expect(result.value).toMatchObject({ signedIn: true, message: null })
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('refuses an address that is not one', async () => {
    const { run } = setup()
    await expect(run('booking.login', { email: 'me' })).rejects.toThrow(/not an email/)
  })
})

describe('naming a room', () => {
  it('finds a room by number, name, mailbox or id', () => {
    expect(resolveRoom(ROOMS, '4').name).toBe('Garage 4 – (MuteBox)')
    expect(resolveRoom(ROOMS, 'garage 6').name).toBe('Garage 6 – (MuteBox Meet)')
    expect(resolveRoom(ROOMS, 'Garage 5 (MuteBox)').id).toBe('room-5')
    expect(resolveRoom(ROOMS, 'garage1@EXAMPLE.test').id).toBe('room-1')
    expect(resolveRoom(ROOMS, 'room-3').id).toBe('room-3')
  })

  it('does not take Garage 1 for Garage 10, and names the rooms when nothing matches', () => {
    const more = [...ROOMS, { ...ROOMS[0]!, id: 'room-10', name: 'Garage10', email: 'g10@x' }]
    expect(resolveRoom(more, '1').id).toBe('room-1')
    expect(() => resolveRoom(ROOMS, 'kitchen')).toThrow(
      /no room matches "kitchen"; the rooms are Garage1/,
    )
    expect(() => resolveRoom(ROOMS, 'garage')).toThrow(/more than one room matches/)
  })
})
