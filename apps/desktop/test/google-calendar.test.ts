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
import { enabledCalendarIds, listAgenda, listCalendars, resolveCalendars } from '../src/main/google/calendar'

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
const COLORS = 'https://www.googleapis.com/calendar/v3/colors'
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

/**
 * Which calendars an agenda draws from, and which are someone else's.
 *
 * The problem being solved: a Workspace account is subscribed to colleagues'
 * calendars, rooms and birthdays, and Holi showed every one of them as though
 * they were the user's own day. "What am I doing today" is not answerable from
 * a list that also contains what four other people are doing.
 */
describe('resolveCalendars', () => {
  const MIXED = {
    [CAL_LIST]: {
      items: [
        { id: 'primary', summary: 'Ada', primary: true, accessRole: 'owner', backgroundColor: '#039be5' },
        { id: 'holidays', summary: 'syv.ai holidays', accessRole: 'owner', backgroundColor: '#0b8043' },
        { id: 'jane', summary: 'Jane Doe', accessRole: 'reader', backgroundColor: '#d50000' },
        { id: 'room3', summary: 'Meeting Room 3', accessRole: 'freeBusyReader' },
      ],
    },
  }

  it('enables what you own and leaves what you merely watch switched off', async () => {
    const { api } = googleApi(MIXED)

    const calendars = await resolveCalendars(api, {})

    expect(calendars.map((c) => [c.id, c.enabled])).toEqual([
      ['primary', true],
      ['holidays', true],
      ['jane', false],
      ['room3', false],
    ])
  })

  it('says which are yours, so an event can be attributed', async () => {
    const { api } = googleApi(MIXED)

    const calendars = await resolveCalendars(api, {})

    expect(calendars.filter((c) => c.mine).map((c) => c.id)).toEqual(['primary', 'holidays'])
  })

  it('carries Google’s own colour for each calendar', async () => {
    const { api } = googleApi(MIXED)

    const calendars = await resolveCalendars(api, {})

    // Google's colour, not one Holi invents — the point of colour coding is
    // that a calendar looks the same here as it does in Google Calendar.
    expect(calendars.find((c) => c.id === 'jane')?.color).toBe('#d50000')
    expect(calendars.find((c) => c.id === 'room3')?.color).toBeNull()
  })

  it('lets an explicit choice override the default, both ways', async () => {
    const { api } = googleApi(MIXED)

    const calendars = await resolveCalendars(api, { jane: true, holidays: false })

    expect(calendars.find((c) => c.id === 'jane')?.enabled).toBe(true)
    expect(calendars.find((c) => c.id === 'holidays')?.enabled).toBe(false)
  })

  it('leaves a calendar added later to the default rule, not to a stale list', async () => {
    // Overrides are stored per calendar rather than as "the enabled set", so a
    // calendar that appears after the user last touched this still follows the
    // rule instead of silently arriving switched off.
    const { api } = googleApi(MIXED)

    const calendars = await resolveCalendars(api, { jane: true })

    expect(calendars.find((c) => c.id === 'holidays')?.enabled).toBe(true)
  })

  it('prefers the name the user gave a subscribed calendar', async () => {
    const { api } = googleApi({
      [CAL_LIST]: {
        items: [
          { id: 'jane', summary: 'Jane Doe', summaryOverride: 'Jane (design)', accessRole: 'reader' },
        ],
      },
    })

    // Google Calendar shows the override. Showing the owner's name for a
    // calendar the user deliberately renamed is a small, constant papercut.
    expect((await resolveCalendars(api, {}))[0]!.name).toBe('Jane (design)')
  })

  it('respects a calendar you own but unticked in Google', async () => {
    const { api } = googleApi({
      [CAL_LIST]: {
        items: [{ id: 'archive', summary: 'Archive 2024', accessRole: 'owner', selected: false }],
      },
    })

    // `listCalendars` already drops it; the point here is that "yours" does not
    // override an explicit untick in Google's own UI.
    expect(await resolveCalendars(api, {})).toEqual([])
  })
})

describe('enabledCalendarIds', () => {
  it('is the ids the agenda should ask for, and nothing else', () => {
    const ids = enabledCalendarIds([
      { id: 'primary', name: 'Me', mine: true, color: null, enabled: true },
      { id: 'jane', name: 'Jane', mine: false, color: null, enabled: false },
      { id: 'team', name: 'Team', mine: false, color: null, enabled: true },
    ])

    expect(ids).toEqual(['primary', 'team'])
  })
})

describe('listAgenda', () => {
  it('expands recurring events rather than returning the series rule', async () => {
    const { api, seen } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
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
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: { items: [] },
    })

    await listAgenda(api, WINDOW)

    const params = new URL(seen.find((u) => u.includes('/events'))!).searchParams
    expect(params.get('timeMin')).toBe(WINDOW.timeMin)
    expect(params.get('timeMax')).toBe(WINDOW.timeMax)
  })

  it('drops cancelled instances and events the user declined', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
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

  it('asks only the calendars it was given, so a watched colleague stays off the agenda', async () => {
    const { api, seen } = googleApi({
      [CAL_LIST]: {
        items: [
          { id: 'primary', summary: 'Me', accessRole: 'owner' },
          { id: 'jane', summary: 'Jane', accessRole: 'reader' },
        ],
      },
      [eventsUrl('primary')]: { items: [timed('mine', 'Mine', '2026-08-04T09:00:00Z')] },
      [eventsUrl('jane')]: { items: [timed('hers', 'Hers', '2026-08-04T10:00:00Z')] },
    })

    const events = await listAgenda(api, WINDOW)

    expect(events.map((e) => e.id)).toEqual(['mine'])
    // Not merely filtered afterwards — her calendar is never fetched at all.
    expect(seen.some((u) => u.includes(encodeURIComponent('jane')))).toBe(false)
  })

  it('marks each event with whose calendar it came from, and its colour', async () => {
    const { api } = googleApi({
      [CAL_LIST]: {
        items: [
          { id: 'primary', summary: 'Me', accessRole: 'owner', backgroundColor: '#039be5' },
          { id: 'jane', summary: 'Jane Doe', accessRole: 'reader', backgroundColor: '#d50000' },
        ],
      },
      [eventsUrl('primary')]: { items: [timed('mine', 'Mine', '2026-08-04T09:00:00Z')] },
      [eventsUrl('jane')]: { items: [timed('hers', 'Hers', '2026-08-04T10:00:00Z')] },
    })

    // Jane switched on explicitly — the case where telling them apart matters.
    const events = await listAgenda(api, WINDOW, { overrides: { jane: true } })

    expect(events.map((e) => [e.title, e.mine, e.calendarName, e.color])).toEqual([
      ['Mine', true, 'Me', '#039be5'],
      ['Hers', false, 'Jane Doe', '#d50000'],
    ])
  })

  it('merges calendars and sorts by start, all-day first on the same day', async () => {
    const { api } = googleApi({
      [CAL_LIST]: {
        items: [
          { id: 'primary', summary: 'Me', accessRole: 'owner' },
          { id: 'team', summary: 'Team', accessRole: 'owner' },
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
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
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
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: [
        { items: [timed('a', 'A', '2026-08-04T09:00:00Z')], nextPageToken: 'p2' },
        { items: [timed('b', 'B', '2026-08-04T15:00:00Z')] },
      ],
    })

    expect((await listAgenda(api, WINDOW)).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('renders an untitled event rather than an empty row', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [{ id: 'e1', htmlLink: 'h', start: { dateTime: '2026-08-04T09:00:00Z' }, end: {} }],
      },
    })

    expect((await listAgenda(api, WINDOW))[0]!.title).toBe('(no title)')
  })

  /**
   * Triage — the fields that separate "a thing I must answer" from "a thing
   * that is merely on the calendar". Google sends all of them and the agenda
   * used to throw every one away.
   */

  it('surfaces an invitation the user has not answered', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('ask', 'Design review', '2026-08-04T09:00:00Z', {
            attendees: [
              { self: true, responseStatus: 'needsAction', email: 'me@syv.ai' },
              { responseStatus: 'accepted', email: 'jane@syv.ai' },
            ],
          }),
        ],
      },
    })

    // The single most valuable field here: an unanswered invitation is the one
    // agenda row that is a task rather than a fact.
    expect((await listAgenda(api, WINDOW))[0]!.myResponse).toBe('needsAction')
  })

  it('leaves myResponse null for an event with no attendees', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: { items: [timed('solo', 'Write plan', '2026-08-04T09:00:00Z')] },
    })

    // A solo block is not an unanswered invitation, and must not be badged as one.
    const [event] = await listAgenda(api, WINDOW)
    expect(event!.myResponse).toBeNull()
    expect(event!.attendeeCount).toBe(0)
  })

  it('drops workingLocation events, which Google creates every day', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('office', 'Office', '2026-08-04T00:00:00Z', { eventType: 'workingLocation' }),
          timed('real', 'Stand-up', '2026-08-04T09:00:00Z'),
        ],
      },
    })

    // Google writes one of these per working day. They are a setting, not an
    // event, and they double the length of a week's agenda.
    expect((await listAgenda(api, WINDOW)).map((e) => e.id)).toEqual(['real'])
  })

  it('marks out-of-office and focus-time so they do not read as meetings', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('ooo', 'Out of office', '2026-08-04T09:00:00Z', { eventType: 'outOfOffice' }),
          timed('focus', 'Focus', '2026-08-04T10:00:00Z', { eventType: 'focusTime' }),
          timed('meet', 'Sync', '2026-08-04T11:00:00Z'),
        ],
      },
    })

    expect((await listAgenda(api, WINDOW)).map((e) => e.kind)).toEqual([
      'outOfOffice',
      'focusTime',
      'default',
    ])
  })

  it('marks a transparent event as not blocking time', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('free', 'FYI: release', '2026-08-04T09:00:00Z', { transparency: 'transparent' }),
          timed('busy', 'Interview', '2026-08-04T10:00:00Z'),
        ],
      },
    })

    expect((await listAgenda(api, WINDOW)).map((e) => e.busy)).toEqual([false, true])
  })

  it('prefers a conferenceData entry point over hangoutLink, so Zoom and Teams work', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('z', 'Client call', '2026-08-04T09:00:00Z', {
            conferenceData: {
              entryPoints: [
                { entryPointType: 'phone', uri: 'tel:+4512345678' },
                { entryPointType: 'video', uri: 'https://syv.zoom.us/j/123' },
              ],
            },
          }),
        ],
      },
    })

    // `hangoutLink` is Meet-only; half of a consultancy's calls are not Meet.
    // The video entry point is the one a "Join" button can use.
    expect((await listAgenda(api, WINDOW))[0]!.conferenceUrl).toBe('https://syv.zoom.us/j/123')
  })

  it('falls back to hangoutLink when there is no conferenceData', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('m', 'Sync', '2026-08-04T09:00:00Z', { hangoutLink: 'https://meet.google.com/abc' }),
        ],
      },
    })

    expect((await listAgenda(api, WINDOW))[0]!.conferenceUrl).toBe('https://meet.google.com/abc')
  })

  it('lets a per-event colour override the calendar colour', async () => {
    const { api } = googleApi({
      [CAL_LIST]: {
        items: [{ id: 'primary', summary: 'Me', accessRole: 'owner', backgroundColor: '#039be5' }],
      },
      [COLORS]: { event: { '5': { background: '#fbd75b' } } },
      [eventsUrl('primary')]: {
        items: [
          timed('tinted', 'Deadline', '2026-08-04T09:00:00Z', { colorId: '5' }),
          timed('plain', 'Sync', '2026-08-04T10:00:00Z'),
        ],
      },
    })

    // Colour-coding an individual event is how people mark the one that matters
    // in a day of identical blue blocks; ignoring colorId erases that.
    expect((await listAgenda(api, WINDOW)).map((e) => e.color)).toEqual(['#fbd75b', '#039be5'])
  })

  it('counts attendees and names the organizer', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('big', 'All hands', '2026-08-04T09:00:00Z', {
            organizer: { displayName: 'Jane Doe', email: 'jane@syv.ai' },
            attendees: [
              { self: true, responseStatus: 'accepted', email: 'me@syv.ai' },
              { responseStatus: 'accepted', email: 'jane@syv.ai' },
              { responseStatus: 'needsAction', email: 'sam@syv.ai' },
            ],
          }),
        ],
      },
    })

    const [event] = await listAgenda(api, WINDOW)
    expect(event!.attendeeCount).toBe(3)
    expect(event!.organizer).toBe('Jane Doe')
  })

  it('does not count a meeting room as an attendee', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('room', 'Workshop', '2026-08-04T09:00:00Z', {
            attendees: [
              { self: true, responseStatus: 'accepted', email: 'me@syv.ai' },
              { resource: true, email: 'room3@syv.ai', displayName: 'Meeting Room 3' },
            ],
          }),
        ],
      },
    })

    // "2 people" for a one-person meeting in a booked room is a lie the count
    // tells constantly on a Workspace account.
    expect((await listAgenda(api, WINDOW))[0]!.attendeeCount).toBe(1)
  })

  it('marks an instance of a recurring series', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('weekly', 'Stand-up', '2026-08-04T09:00:00Z', { recurringEventId: 'series-1' }),
          timed('once', 'Interview', '2026-08-04T10:00:00Z'),
        ],
      },
    })

    expect((await listAgenda(api, WINDOW)).map((e) => e.recurring)).toEqual([true, false])
  })

  it('carries the description through', async () => {
    const { api } = googleApi({
      [CAL_LIST]: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] },
      [eventsUrl('primary')]: {
        items: [
          timed('d', 'Board call', '2026-08-04T09:00:00Z', {
            description: 'Dial-in 555-0100, agenda in the deck',
          }),
        ],
      },
    })

    // Where the dial-in and the agenda live. It is also what makes a task made
    // from an event useful rather than a bare title.
    expect((await listAgenda(api, WINDOW))[0]!.description).toBe(
      'Dial-in 555-0100, agenda in the deck',
    )
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
