import { describe, expect, it } from 'vitest'
import { busyIntervals, fromLocal, localDay, toLocal, type SiteSlot } from '../main/schedule'

const OSLO = 'Europe/Oslo'
const ME = { userId: 'user-1', email: 'me@example.test' }

describe('the site’s wall clock', () => {
  it('turns an instant into Oslo time and back, in winter and summer', () => {
    expect(toLocal(new Date('2026-11-05T09:00:00Z'), OSLO)).toBe('2026-11-05T10:00:00')
    expect(toLocal(new Date('2026-07-01T09:00:00Z'), OSLO)).toBe('2026-07-01T11:00:00')
    expect(fromLocal('2026-11-05T10:00:00', OSLO).toISOString()).toBe('2026-11-05T09:00:00.000Z')
    expect(fromLocal('2026-07-01T11:00', OSLO).toISOString()).toBe('2026-07-01T09:00:00.000Z')
  })

  it('holds across the night the clocks go back', () => {
    // 25 October 2026: 03:00 summer time becomes 02:00 winter time.
    expect(fromLocal('2026-10-25T01:00:00', OSLO).toISOString()).toBe('2026-10-24T23:00:00.000Z')
    expect(fromLocal('2026-10-25T09:00:00', OSLO).toISOString()).toBe('2026-10-25T08:00:00.000Z')
  })

  it('names the site’s day, which can differ from UTC’s', () => {
    expect(localDay(new Date('2026-11-04T23:30:00Z'), OSLO)).toBe('2026-11-05')
  })
})

describe('busy times', () => {
  it('folds a run of busy slots that share a booking into one interval', () => {
    const slots: SiteSlot[] = [
      { start: '2026-11-05T09:00:00', end: '2026-11-05T09:30:00', status: 'free' },
      { start: '2026-11-05T09:30:00', end: '2026-11-05T10:00:00', status: 'busy' },
      {
        start: '2026-11-05T10:00:00',
        end: '2026-11-05T10:30:00',
        status: 'busy',
        booking: { id: 'b1', title: 'Standup', organizer_email: 'ME@example.test' },
      },
      {
        start: '2026-11-05T10:30:00',
        end: '2026-11-05T11:00:00',
        status: 'busy',
        booking: { id: 'b1', title: 'Standup', organizer_email: 'ME@example.test' },
      },
      { start: '2026-11-05T11:00:00', end: '2026-11-05T11:30:00', status: 'free' },
    ]
    expect(busyIntervals(slots, OSLO, ME)).toEqual([
      {
        start: '2026-11-05T08:30:00.000Z',
        end: '2026-11-05T09:00:00.000Z',
        bookingId: null,
        title: null,
        organizer: null,
        mine: false,
      },
      {
        start: '2026-11-05T09:00:00.000Z',
        end: '2026-11-05T10:00:00.000Z',
        bookingId: 'b1',
        title: 'Standup',
        organizer: 'ME@example.test',
        mine: true,
      },
    ])
  })

  it('keeps two bookings back to back apart', () => {
    const slots: SiteSlot[] = [
      {
        start: '2026-11-05T09:00:00',
        end: '2026-11-05T09:30:00',
        status: 'busy',
        booking: { id: 'a', user_id: 'user-2' },
      },
      {
        start: '2026-11-05T09:30:00',
        end: '2026-11-05T10:00:00',
        status: 'busy',
        booking: { id: 'b', user_id: 'user-1' },
      },
    ]
    const busy = busyIntervals(slots, OSLO, ME)
    expect(busy.map((b) => [b.bookingId, b.mine])).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  it('keeps two events with no booking id apart, and one event whole', () => {
    const event = (start: string, end: string, title: string): SiteSlot => ({
      start: `2026-11-05T${start}:00`,
      end: `2026-11-05T${end}:00`,
      status: 'busy',
      booking: { title },
    })
    const slots = [
      event('09:00', '09:30', 'Board'),
      event('09:30', '10:00', 'Board'),
      event('10:00', '10:30', 'Lunch talk'),
    ]
    expect(busyIntervals(slots, OSLO, ME).map((b) => [b.title, b.end])).toEqual([
      ['Board', '2026-11-05T09:00:00.000Z'],
      ['Lunch talk', '2026-11-05T09:30:00.000Z'],
    ])
  })

  it('calls nothing yours when it does not know who you are', () => {
    const slots: SiteSlot[] = [
      {
        start: '2026-11-05T09:00:00',
        end: '2026-11-05T09:30:00',
        status: 'busy',
        booking: { id: 'outlook', organizer_email: null, user_id: null },
      },
    ]
    expect(busyIntervals(slots, OSLO, { userId: '', email: '' })[0]!.mine).toBe(false)
  })
})
