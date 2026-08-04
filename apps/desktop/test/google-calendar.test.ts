/**
 * The agenda, over a faked Google.
 *
 * The tests worth having here guard the things that are silently wrong rather
 * than loudly broken: a recurring meeting showing on the day its series began,
 * a declined event on your agenda, and events from calendars the user
 * deliberately unchecked in Google's own UI.
 */
import { describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { listAgenda, listCalendars } from '../src/main/google/calendar'

/**
 * A fake Google that answers by URL. Each entry may be a single page or a list
 * of pages, so pagination is exercised without a second mechanism.
 */
function googleApi(routes: Record<string, unknown | unknown[]>) {
  const seen: string[] = []
  const pageCounts: Record<string, number> = {}

  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    if (key === undefined) {
      return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) }
    }
    const route = routes[key]!
    const body = Array.isArray(route) ? route[pageCounts[key] ?? 0] : route
    pageCounts[key] = (pageCounts[key] ?? 0) + 1
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as unknown as typeof globalThis.fetch

  return {
    api: new GoogleApi({ accessToken: async () => 'at-1', fetch: fetchImpl }),
    seen,
    fetchImpl,
  }
}

const CAL_LIST = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'
const eventsUrl = (id: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`

const WINDOW = { timeMin: '2026-08-04T00:00:00Z', timeMax: '2026-08-05T00:00:00Z' }

function timed(id: string, summary: string, start: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary,
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    start: { dateTime: start },
    end: { dateTime: start },
    ...extra,
  }
}

describe('listCalendars', () => {
  it('honours the user’s own selection, dropping unchecked and deleted calendars', async () => {
    const { api } = googleApi({
      [CAL_LIST]: {
        items: [
          { id: 'primary', summary: 'Me', primary: true },
          { id: 'rooms', summary: 'Meeting rooms', selected: false },
          { id: 'old', summary: 'Old', deleted: true },
          { id: 'team', summary: 'Team', selected: true },
        ],
      },
    })

    expect((await listCalendars(api)).map((c) => c.id)).toEqual(['primary', 'team'])
  })
})

describe('listAgenda', () => {
  it('expands recurring events rather than returning the series rule', async () => {
    const { api, seen } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me' }] },
      [eventsUrl('primary')]: { items: [timed('e1', 'Stand-up', '2026-08-04T09:00:00Z')] },
    })

    await listAgenda(api, WINDOW)

    // Without singleEvents the response is the rule, and a weekly stand-up
    // renders on the day the series began instead of today.
    const eventsCall = seen.find((u) => u.includes('/events'))!
    expect(new URL(eventsCall).searchParams.get('singleEvents')).toBe('true')
    expect(new URL(eventsCall).searchParams.get('orderBy')).toBe('startTime')
  })

  it('passes the caller’s window through untouched', async () => {
    const { api, seen } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me' }] },
      [eventsUrl('primary')]: { items: [] },
    })

    await listAgenda(api, WINDOW)

    const params = new URL(seen.find((u) => u.includes('/events'))!).searchParams
    expect(params.get('timeMin')).toBe(WINDOW.timeMin)
    expect(params.get('timeMax')).toBe(WINDOW.timeMax)
  })

  it('drops cancelled instances and events the user declined', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('keep', 'Keep', '2026-08-04T09:00:00Z'),
          timed('gone', 'Cancelled', '2026-08-04T10:00:00Z', { status: 'cancelled' }),
          timed('nope', 'Declined', '2026-08-04T11:00:00Z', {
            attendees: [{ self: true, responseStatus: 'declined' }],
          }),
          timed('yes', 'Accepted', '2026-08-04T12:00:00Z', {
            attendees: [{ self: true, responseStatus: 'accepted' }],
          }),
        ],
      },
    })

    expect((await listAgenda(api, WINDOW)).map((e) => e.id)).toEqual(['keep', 'yes'])
  })

  it('merges calendars and sorts by start, all-day first on the same day', async () => {
    const { api } = googleApi({
      [CAL_LIST]: {
        items: [
          { id: 'primary', summary: 'Me' },
          { id: 'team', summary: 'Team' },
        ],
      },
      [eventsUrl('primary')]: {
        items: [
          timed('noon', 'Noon', '2026-08-04T12:00:00Z'),
          {
            id: 'offsite',
            summary: 'Offsite',
            htmlLink: 'h',
            start: { date: '2026-08-04' },
            end: { date: '2026-08-05' },
          },
        ],
      },
      [eventsUrl('team')]: { items: [timed('nine', 'Nine', '2026-08-04T09:00:00Z')] },
    })

    const agenda = await listAgenda(api, WINDOW)

    expect(agenda.map((e) => e.id)).toEqual(['offsite', 'nine', 'noon'])
    expect(agenda[0]).toMatchObject({ allDay: true, calendarName: 'Me' })
    expect(agenda[1]).toMatchObject({ allDay: false, calendarName: 'Team' })
  })

  it('carries Google’s own permalink through — the link written into a task', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me' }] },
      [eventsUrl('primary')]: {
        items: [timed('e1', 'Review', '2026-08-04T09:00:00Z', { hangoutLink: 'https://meet.google.com/x' })],
      },
    })

    const [event] = await listAgenda(api, WINDOW)

    expect(event).toMatchObject({
      htmlLink: 'https://calendar.google.com/event?eid=e1',
      meetLink: 'https://meet.google.com/x',
    })
  })

  it('follows pagination, so an afternoon is not silently missing', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me' }] },
      [eventsUrl('primary')]: [
        { items: [timed('a', 'A', '2026-08-04T09:00:00Z')], nextPageToken: 'p2' },
        { items: [timed('b', 'B', '2026-08-04T15:00:00Z')] },
      ],
    })

    expect((await listAgenda(api, WINDOW)).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('renders an untitled event rather than an empty row', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me' }] },
      [eventsUrl('primary')]: {
        items: [{ id: 'e1', htmlLink: 'h', start: { dateTime: '2026-08-04T09:00:00Z' }, end: {} }],
      },
    })

    expect((await listAgenda(api, WINDOW))[0]!.title).toBe('(no title)')
  })
})

describe('refusals are classified, not passed through raw', () => {
  it('reads a 401 as reconnect', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{}',
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch
    const api = new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl })

    await expect(api.get('https://x')).rejects.toMatchObject({ code: 'reconnect' })
  })

  it('separates a rate limit from a missing scope — both arrive as 403', async () => {
    const body = (reason: string) => JSON.stringify({ error: { errors: [{ reason }] } })

    for (const [reason, code] of [
      ['rateLimitExceeded', 'rate-limit'],
      ['insufficientPermissions', 'scope'],
    ] as const) {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => body(reason),
        json: async () => JSON.parse(body(reason)),
      })) as unknown as typeof globalThis.fetch
      const api = new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl })

      await expect(api.get('https://x')).rejects.toMatchObject({ code })
    }
  })

  it('reports a dead grant as reconnect before any request is made', async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    const api = new GoogleApi({
      accessToken: async () => {
        throw new Error('connect Google again')
      },
      fetch: fetchImpl,
    })

    await expect(api.get('https://x')).rejects.toMatchObject({ code: 'reconnect' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
