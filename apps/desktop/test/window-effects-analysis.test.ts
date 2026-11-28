import { describe, expect, it } from 'vitest'
import { compareWindowEffects } from '../scripts/window-effects-analysis.mjs'

const MiB = 1024 * 1024
function pair(savingMiB = 100) {
  const state = {
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    display: { id: 1, scaleFactor: 2 },
    zoom: 1,
  }
  const outcome = (mode: string, physical: number) => ({
    valid: true,
    effect: mode,
    ready: { state },
    steady: {
      physicalFootprint: { median: (physical * MiB) as number | null },
      cpuPercent: { median: 1 },
      gpuPercent: { median: 2 as number | null },
      wsCpuPercent: { median: 3 },
    },
  })
  return { outcomes: { A: outcome('liquid-glass', 500), B: outcome('opaque', 500 - savingMiB) } }
}
const tolerances = { cpuPercent: 1, gpuPercent: 1, wsCpuPercent: 1 }

describe('window effects comparison decision', () => {
  it('requires both memory thresholds in four of five pairs', () => {
    const result = compareWindowEffects(
      [pair(), pair(), pair(), pair(), pair(20)],
      tolerances,
      'liquid-glass',
    )
    expect(result.crossesPrimaryGate).toBe(true)
    expect(result.pairedMedianSaving).toBe(100 * MiB)
    expect(result.pairedMedianFraction).toBe(0.2)
    expect(
      compareWindowEffects([pair(), pair(), pair(), pair(20), pair(20)], tolerances, 'liquid-glass')
        .crossesPrimaryGate,
    ).toBe(false)
    expect(
      compareWindowEffects(
        Array.from({ length: 5 }, () => pair(70)),
        tolerances,
        'liquid-glass',
      ).crossesPrimaryGate,
    ).toBe(false)
  })
  it('requires an absolute saving even when the relative improvement is large', () => {
    const small = () => {
      const value = pair()
      value.outcomes.A.steady.physicalFootprint.median = 200 * MiB
      value.outcomes.B.steady.physicalFootprint.median = 140 * MiB
      return value
    }
    expect(
      compareWindowEffects(Array.from({ length: 5 }, small), tolerances, 'liquid-glass')
        .crossesPrimaryGate,
    ).toBe(false)
  })
  it('rejects incomplete, invalid or differently rendered comparisons', () => {
    expect(compareWindowEffects([pair()], tolerances, 'liquid-glass').valid).toBe(false)
    const invalid = pair()
    invalid.outcomes.B.valid = false
    const mismatched = pair()
    mismatched.outcomes.B.ready = { state: { ...mismatched.outcomes.B.ready.state, zoom: 2 } }
    for (const value of [invalid, mismatched])
      expect(
        compareWindowEffects([pair(), pair(), pair(), pair(), value], tolerances, 'liquid-glass')
          .valid,
      ).toBe(false)
    expect(
      compareWindowEffects(
        Array.from({ length: 5 }, () => pair()),
        tolerances,
        'vibrancy-fallback',
      ).valid,
    ).toBe(false)
  })
  it('keeps matched fallback measurements diagnostic instead of proving liquid-glass benefit', () => {
    const fallback = () => {
      const value = pair()
      value.outcomes.A.effect = 'vibrancy-fallback'
      return value
    }
    const result = compareWindowEffects(
      Array.from({ length: 5 }, fallback),
      tolerances,
      'vibrancy-fallback',
    )
    expect(result.valid).toBe(false)
    expect(result.crossesPrimaryGate).toBe(false)
  })
  it('never turns missing counters into proof and rejects repeatable CPU regression', () => {
    const missing = pair()
    missing.outcomes.B.steady.gpuPercent.median = null
    expect(
      compareWindowEffects([pair(), pair(), pair(), pair(), missing], tolerances, 'liquid-glass')
        .valid,
    ).toBe(false)
    const noMemory = () => {
      const value = pair()
      value.outcomes.B.steady.physicalFootprint.median = null
      return value
    }
    const unavailable = compareWindowEffects(
      Array.from({ length: 5 }, noMemory),
      tolerances,
      'liquid-glass',
    )
    expect(unavailable.valid).toBe(false)
    expect(unavailable.pairedMedianSaving).toBeNull()
    const slow = () => {
      const value = pair()
      value.outcomes.B.steady.cpuPercent.median = 4
      return value
    }
    expect(
      compareWindowEffects(Array.from({ length: 5 }, slow), tolerances, 'liquid-glass')
        .crossesPrimaryGate,
    ).toBe(false)
  })
})
