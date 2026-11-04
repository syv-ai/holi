import { describe, expect, it } from 'vitest'
import { estimateMinutes, formatEstimate, isEstimate } from '../src/estimate'

describe('estimate', () => {
  it('reads a number and a unit', () => {
    expect(estimateMinutes('30m')).toBe(30)
    expect(estimateMinutes('2h')).toBe(120)
    expect(estimateMinutes('1.5d')).toBe(720)
    expect(estimateMinutes('1w')).toBe(2400)
  })

  it('is nothing without a unit, with a space, or at zero', () => {
    for (const bad of ['2', '2 d', '0d', 'd', '-1h', '2days']) {
      expect(isEstimate(bad)).toBe(false)
      expect(estimateMinutes(bad)).toBeNull()
    }
    expect(estimateMinutes(undefined)).toBeNull()
  })

  it('formats minutes in the largest unit that fits', () => {
    expect(formatEstimate(45)).toBe('45m')
    expect(formatEstimate(90)).toBe('1.5h')
    expect(formatEstimate(960)).toBe('2d')
    expect(formatEstimate(4800)).toBe('2w')
  })
})
