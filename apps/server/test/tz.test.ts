import { describe, expect, it } from 'vitest'
import { localToUtc, utcToLocal } from '../src/reminders/tz'

describe('timezone edge (HOLI_TZ)', () => {
  it('converts Copenhagen summer (CEST, +02:00) wall-clock to UTC', () => {
    expect(localToUtc('2026-07-15T09:00', 'Europe/Copenhagen').toISOString()).toBe(
      '2026-07-15T07:00:00.000Z',
    )
  })
  it('converts Copenhagen winter (CET, +01:00) wall-clock to UTC', () => {
    expect(localToUtc('2026-01-15T09:00', 'Europe/Copenhagen').toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    )
  })
  it('round-trips through utcToLocal', () => {
    const utc = localToUtc('2026-03-29T12:30', 'Europe/Copenhagen') // DST-transition day
    expect(utcToLocal(utc, 'Europe/Copenhagen')).toBe('2026-03-29T12:30')
  })
  it('rejects garbage', () => {
    expect(() => localToUtc('not-a-date', 'Europe/Copenhagen')).toThrow()
  })
})
