import { describe, expect, it } from 'vitest'
import { createTrialSampling } from '../scripts/browser-placement-bench-sampling.mjs'
import { selectScenario } from '../scripts/browser-placement-bench-scenarios.mjs'

const condition = { focused: true, visible: true, minimized: false }
const snapshot = (count: number, state = condition) => ({
  condition: state,
  stats: {
    callbacks: count,
    hostRects: count,
    coverageScans: count,
    overlayRects: count,
  },
})

describe('browser placement benchmark sampling', () => {
  it('accepts matching foreground observations and includes terminal counters', () => {
    const trial = createTrialSampling({ condition })
    trial.observe(snapshot(2))
    const result = trial.finish(snapshot(5))
    expect(result.valid).toBe(true)
    expect(result.counters.totals.callbacks).toBe(5)
    expect(result.counters.terminal.callbacks).toBe(5)
  })

  it('rejects absent, mismatched, and recovered intersample foreground conditions', () => {
    const absent = createTrialSampling({ condition })
    absent.observe({ stats: snapshot(0).stats })
    expect(absent.finish(snapshot(0)).valid).toBe(false)
    const mismatch = createTrialSampling({ condition })
    mismatch.observe(snapshot(0, { ...condition, focused: false }))
    expect(mismatch.finish(snapshot(0)).valid).toBe(false)
    const recovered = createTrialSampling({ condition })
    recovered.observe(snapshot(0))
    recovered.observe(snapshot(1, { ...condition, visible: false }))
    expect(recovered.finish(snapshot(2)).valid).toBe(false)
  })

  it('keeps successive trials independent and refuses unknown scenarios', () => {
    const first = createTrialSampling({ condition })
    first.observe(snapshot(0))
    first.finish(snapshot(3))
    const next = createTrialSampling({ condition })
    next.observe(snapshot(0))
    expect(next.finish(snapshot(1)).counters.totals.callbacks).toBe(1)
    expect(() => selectScenario('not-a-scenario')).toThrow()
  })
})
