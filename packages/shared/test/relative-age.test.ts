import { describe, expect, it } from 'vitest'
import { relativeAge } from '../src/relative-age'

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

describe('relativeAge', () => {
  it('says now, minutes, hours and days', () => {
    expect(relativeAge(NOW - 5_000, NOW)).toBe('now')
    expect(relativeAge(NOW - 10 * 60_000, NOW)).toBe('10m')
    expect(relativeAge(NOW - 343 * 60_000, NOW)).toBe('5h')
    expect(relativeAge(NOW - 3 * 86_400_000, NOW)).toBe('3d')
  })

  it('keeps the minutes when precise', () => {
    expect(relativeAge(NOW - 343 * 60_000, NOW, { precise: true })).toBe('5h 43m')
    expect(relativeAge(NOW - 300 * 60_000, NOW, { precise: true })).toBe('5h')
  })

  it('is empty for no time', () => {
    expect(relativeAge(0, NOW)).toBe('')
  })
})
