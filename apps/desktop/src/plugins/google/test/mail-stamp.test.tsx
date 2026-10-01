/**
 * Assertions are about shape, not a locale's wording: both stamps format
 * through `toLocaleString`, so "Aug 14" would pin CI's locale.
 */
import { describe, expect, test } from 'vitest'
import { listStamp, messageStamp } from '../renderer/mail-stamp'

/** A wall-clock time appears in the output. */
const HAS_TIME = /\d{1,2}:\d{2}/

const NOW = new Date('2026-08-14T18:00:00Z')

describe('listStamp', () => {
  test('names today by name, and still gives the time', () => {
    const stamp = listStamp('2026-08-14T12:47:00Z', NOW)
    expect(stamp).toMatch(/^Today /)
    expect(stamp).toMatch(HAS_TIME)
  })

  test('an earlier day this year gives day and time, and no year', () => {
    const stamp = listStamp('2026-03-02T09:15:00Z', NOW)
    expect(stamp).not.toMatch(/Today/)
    expect(stamp).toMatch(HAS_TIME)
    expect(stamp).not.toMatch(/2026/)
  })

  test('a previous year says so', () => {
    const stamp = listStamp('2025-11-30T09:15:00Z', NOW)
    expect(stamp).toContain('2025')
    expect(stamp).toMatch(HAS_TIME)
  })

  test('an empty date is empty, not a stamp of the epoch', () => {
    expect(listStamp('', NOW)).toBe('')
  })

  test('an unparseable date is empty, never "Invalid Date"', () => {
    // A header this app did not write can hold anything.
    expect(listStamp('not a date', NOW)).toBe('')
  })
})

describe('messageStamp', () => {
  test('is fully qualified — day, month, year and time', () => {
    const stamp = messageStamp('2026-08-14T12:47:00Z')
    expect(stamp).toContain('2026')
    expect(stamp).toMatch(HAS_TIME)
    // Never "Today": it is read against the thread's other messages.
    expect(stamp).not.toMatch(/Today/)
  })

  test('empty and unparseable both give nothing', () => {
    expect(messageStamp('')).toBe('')
    expect(messageStamp('not a date')).toBe('')
  })
})
