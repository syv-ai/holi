import { describe, expect, it } from 'vitest'
import { nextDue, nextDueCatchup } from '../src/recurrence'
import type { Recurrence, RecurrenceFrequency } from '../src/types'

const rule = (frequency: RecurrenceFrequency, interval: number): Recurrence => ({
  frequency,
  interval,
})

describe('nextDue', () => {
  it('advances daily by the interval', () => {
    expect(nextDue('2026-04-13', rule('daily', 1))).toBe('2026-04-14')
    expect(nextDue('2026-04-13', rule('daily', 3))).toBe('2026-04-16')
  })

  it('advances weekly (no weekday set) by whole weeks', () => {
    expect(nextDue('2026-04-13', rule('weekly', 1))).toBe('2026-04-20')
  })

  it('clamps monthly to the end of shorter months, honoring leap years', () => {
    expect(nextDue('2026-01-31', rule('monthly', 1))).toBe('2026-02-28')
    expect(nextDue('2028-01-31', rule('monthly', 1))).toBe('2028-02-29')
    expect(nextDue('2026-12-15', rule('monthly', 1))).toBe('2027-01-15')
  })

  it('advances yearly, clamping Feb 29', () => {
    expect(nextDue('2028-02-29', rule('yearly', 1))).toBe('2029-02-28')
    expect(nextDue('2026-04-13', rule('yearly', 2))).toBe('2028-04-13')
  })

  it('treats interval below 1 as 1', () => {
    expect(nextDue('2026-04-13', { frequency: 'daily', interval: 0 })).toBe('2026-04-14')
  })

  it('stops at endDate (exclusive past it, inclusive on it)', () => {
    expect(nextDue('2026-04-13', { ...rule('daily', 1), endDate: '2026-04-13' })).toBeNull()
    expect(nextDue('2026-04-13', { ...rule('daily', 1), endDate: '2026-04-14' })).toBe(
      '2026-04-14',
    )
  })

  it('returns null on an unparseable due date', () => {
    expect(nextDue('not-a-date', rule('daily', 1))).toBeNull()
  })
})

describe('nextDue — weekly with weekday sets', () => {
  const mwf: Recurrence = { frequency: 'weekly', interval: 1, weekdays: ['mon', 'wed', 'fri'] }

  it('hits the next selected weekday within the same week', () => {
    // 2026-04-13 is a Monday → next of Mon/Wed/Fri is Wednesday
    expect(nextDue('2026-04-13', mwf)).toBe('2026-04-15')
  })

  it('wraps to the first selected weekday of the next week', () => {
    // 2026-04-17 is a Friday → wraps to Monday
    expect(nextDue('2026-04-17', mwf)).toBe('2026-04-20')
  })

  it('interval > 1 jumps to the target ISO week before scanning weekdays', () => {
    // Friday + biweekly Mondays → Monday of the week after next
    expect(
      nextDue('2026-04-17', { frequency: 'weekly', interval: 2, weekdays: ['mon'] }),
    ).toBe('2026-04-27')
  })
})

describe('nextDueCatchup (completing a stale recurring task)', () => {
  it('advances an overdue daily task to the first occurrence on/after today', () => {
    expect(nextDueCatchup('2026-04-10', rule('daily', 1), '2026-04-14')).toBe('2026-04-14')
    // Steps: 04-10 → 04-13 → 04-16 (first date ≥ today)
    expect(nextDueCatchup('2026-04-10', rule('daily', 3), '2026-04-14')).toBe('2026-04-16')
  })

  it('steps once when the task is already current', () => {
    expect(nextDueCatchup('2026-04-14', rule('daily', 1), '2026-04-14')).toBe('2026-04-15')
  })

  it('respects endDate', () => {
    expect(
      nextDueCatchup('2026-04-10', { ...rule('daily', 1), endDate: '2026-04-12' }, '2026-04-14'),
    ).toBeNull()
  })

  it('handles decades-stale tasks via the closed-form leap (daily/monthly/yearly)', () => {
    expect(nextDueCatchup('2010-01-01', rule('daily', 1), '2026-04-27')).toBe('2026-04-27')
    expect(nextDueCatchup('1976-04-01', rule('monthly', 1), '2026-04-27')).toBe('2026-05-01')
    expect(nextDueCatchup('1980-06-15', rule('yearly', 1), '2026-04-27')).toBe('2026-06-15')
  })

  it('monthly anchored on Jan 31 must not leap past today despite day clamping', () => {
    const next = nextDueCatchup('2026-01-31', rule('monthly', 1), '2027-03-01')
    expect(next).not.toBeNull()
    expect(next! >= '2027-03-01').toBe(true)
  })

  it('handles decades-stale weekly-with-weekdays rules', () => {
    const r: Recurrence = { frequency: 'weekly', interval: 1, weekdays: ['mon', 'wed', 'fri'] }
    const next = nextDueCatchup('2010-01-04', r, '2026-04-27') // today is a Monday
    expect(next).not.toBeNull()
    expect(next! >= '2026-04-27').toBe(true)
  })
})
