/**
 * The join between a mail thread and a calendar event.
 *
 * A Teams invite in the inbox and the event on the agenda are the same meeting.
 * Holi could already join it from the agenda, and the reader — where a person
 * actually reads "are you free at 14:00?" — had no way to. What makes that
 * possible without a second implementation of conferencing-link extraction is
 * the `.ics`'s own `UID`: it identifies the event, and the *calendar* is then
 * asked for the link.
 *
 * Almost every test here is a case that produces plausible-but-wrong output:
 * a UID broken in half by ICS line folding, the wrong VEVENT's UID out of a
 * recurring series, or a Join button pointing at last week's occurrence.
 */
import { describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { icsUid, resolveThreadMeeting } from '../src/main/google/invite'

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

const CAL_LIST = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'

/** A minimal Teams-shaped invite. `\r\n` on purpose: ICS is a CRLF format and
 *  the folding rule is defined in terms of it. */
function ics(lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}

describe('icsUid', () => {
  it('reads the UID', () => {
    expect(icsUid(ics(['UID:040000008200E00074C5B7101A82E008']))).toBe('040000008200E00074C5B7101A82E008')
  })

  /**
   * The one that matters. RFC 5545 folds any line past 75 octets onto the next
   * with a leading space — and an Outlook UID is ~100 characters, so it is
   * folded essentially always. Unfolding is not optional: a UID read as its
   * first 70 characters matches no event, and the Join button simply never
   * appears, with nothing to indicate why.
   */
  it('unfolds a UID that ICS split across lines', () => {
    const folded = [
      'UID:040000008200E00074C5B7101A82E00807000000A0F1B2C3D4E5F60708090A0B0C0D0E',
      ' 0F101112131415161718191A1B1C1D1E1F',
    ].join('\r\n')

    expect(icsUid(ics([folded]))).toBe(
      '040000008200E00074C5B7101A82E00807000000A0F1B2C3D4E5F60708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
    )
  })

  it('unfolds a tab continuation, and a file that uses bare newlines', () => {
    expect(icsUid('BEGIN:VEVENT\nUID:abc\n\tdef\nEND:VEVENT')).toBe('abcdef')
  })

  it('reads a UID carrying parameters', () => {
    expect(icsUid(ics(['UID;VALUE=TEXT:abc-123']))).toBe('abc-123')
  })

  it('ignores a UID-shaped property that is not one', () => {
    expect(icsUid(ics(['X-ALT-UID:not-this', 'UID:this-one']))).toBe('this-one')
  })

  it('is null for text that is not an invite', () => {
    expect(icsUid('Dear Ada, are you free at 14:00?')).toBeNull()
    expect(icsUid('')).toBeNull()
  })
})

/**
 * A fake Google spanning both APIs, routed by URL: Gmail for the thread and its
 * attachment, Calendar for the lookup by UID.
 */
function google(routes: {
  thread: unknown
  attachment?: string
  calendars?: unknown[]
  events?: unknown[]
}) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const path = new URL(url).pathname
    const body = path.includes('/attachments/')
      ? { data: b64url(routes.attachment ?? '') }
      : path.includes('/gmail/')
        ? routes.thread
        : path.endsWith('/calendarList')
          ? { items: routes.calendars ?? [{ id: 'primary', summary: 'Ada', accessRole: 'owner' }] }
          : { items: routes.events ?? [] }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as unknown as typeof globalThis.fetch

  return { api: new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }), seen }
}

/** A thread whose only message carries the invite as a real attachment. */
function threadWithIcs(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    messages: [
      {
        id: 'm1',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('are you free at 14:00?') } },
            {
              mimeType: 'text/calendar',
              filename: 'invite.ics',
              body: { attachmentId: 'a1', size: 800 },
            },
          ],
        },
        ...overrides,
      },
    ],
  }
}

const EVENT = {
  id: 'e1',
  summary: 'Sprint review',
  htmlLink: 'https://calendar.google.com/event?eid=e1',
  start: { dateTime: '2026-08-19T12:00:00Z' },
  end: { dateTime: '2026-08-19T13:00:00Z' },
  conferenceData: {
    entryPoints: [{ entryPointType: 'video', uri: 'https://teams.microsoft.com/l/meetup-join/19%3aX/0' }],
  },
}

describe('resolveThreadMeeting', () => {
  it('finds the event the thread is about, and what joining it opens', async () => {
    const { api } = google({
      thread: threadWithIcs(),
      attachment: ics(['UID:abc-123']),
      events: [EVENT],
    })

    const meeting = await resolveThreadMeeting(api, 't1')

    expect(meeting).toMatchObject({
      eventId: 'e1',
      title: 'Sprint review',
      conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/19%3aX/0',
    })
  })

  it('asks the calendar by the invite’s own UID, for one instance from now on', async () => {
    const { api, seen } = google({
      thread: threadWithIcs(),
      attachment: ics(['UID:abc-123']),
      events: [EVENT],
    })

    await resolveThreadMeeting(api, 't1')

    const lookup = new URL(seen.find((u) => u.includes('/events'))!)
    expect(lookup.searchParams.get('iCalUID')).toBe('abc-123')
    // Instances, not the series rule — otherwise a weekly meeting resolves to
    // the occurrence its series began at, and Join opens a dead link.
    expect(lookup.searchParams.get('singleEvents')).toBe('true')
    expect(lookup.searchParams.get('orderBy')).toBe('startTime')
    // The NEXT occurrence: `timeMin` is what makes a recurring invite read from
    // its first mail resolve to the meeting that is actually coming up.
    expect(lookup.searchParams.get('timeMin')).not.toBeNull()
  })

  /**
   * A Google Calendar invite carries `text/calendar` inline, with the data in
   * the part rather than behind an attachment id. Downloading is then not just
   * unnecessary, it is impossible — there is no id to download.
   */
  it('reads an inline calendar part without a second request', async () => {
    const inline = {
      id: 't1',
      messages: [
        {
          id: 'm1',
          payload: {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('invitation') } },
              { mimeType: 'text/calendar', body: { data: b64url(ics(['UID:inline-9'])) } },
            ],
          },
        },
      ],
    }
    const { api, seen } = google({ thread: inline, events: [EVENT] })

    const meeting = await resolveThreadMeeting(api, 't1')

    expect(meeting?.eventId).toBe('e1')
    expect(seen.filter((u) => u.includes('/attachments/'))).toEqual([])
  })

  it('is null for a thread with no invite in it, without asking the calendar', async () => {
    const plain = {
      id: 't1',
      messages: [{ id: 'm1', payload: { mimeType: 'text/plain', body: { data: b64url('hi') } } }],
    }
    const { api, seen } = google({ thread: plain })

    expect(await resolveThreadMeeting(api, 't1')).toBeNull()
    expect(seen.filter((u) => u.includes('googleapis.com/calendar'))).toEqual([])
  })

  /**
   * The honest failure. An invite for a meeting that has already happened, or
   * one the user declined so it is off their calendar, resolves to nothing —
   * and "nothing" must not become a Join button pointing somewhere plausible.
   */
  it('is null when the calendar does not have the event', async () => {
    const { api } = google({
      thread: threadWithIcs(),
      attachment: ics(['UID:abc-123']),
      events: [],
    })

    expect(await resolveThreadMeeting(api, 't1')).toBeNull()
  })

  it('still answers for a meeting with no conferencing link at all', async () => {
    const { api } = google({
      thread: threadWithIcs(),
      attachment: ics(['UID:abc-123']),
      events: [{ ...EVENT, conferenceData: undefined }],
    })

    const meeting = await resolveThreadMeeting(api, 't1')

    // The event is still worth naming — the reader can open it in Google
    // Calendar. A null `conferenceUrl` is "there is nothing to join", which is
    // different from "there is no such meeting".
    expect(meeting).toMatchObject({ eventId: 'e1', conferenceUrl: null })
    expect(meeting?.htmlLink).toBe('https://calendar.google.com/event?eid=e1')
  })
})
