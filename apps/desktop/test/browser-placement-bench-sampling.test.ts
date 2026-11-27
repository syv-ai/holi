import { describe, expect, it } from 'vitest'
import { createTrialSampling } from '../scripts/browser-placement-bench-sampling.mjs'
import { selectScenario } from '../scripts/browser-placement-bench-scenarios.mjs'

const condition = { focused: true, visible: true, minimized: false }
const snapshot = (count: number, state = condition) => ({
  condition: state,
  visibilityEpoch: 0,
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

  it('rejects blur transitions and visibility epochs even after foreground recovery', () => {
    const blurred = createTrialSampling({ condition })
    blurred.observe(snapshot(0))
    blurred.transition('blur')
    expect(blurred.finish(snapshot(1)).valid).toBe(false)
    const hidden = createTrialSampling({ condition })
    hidden.observe({ ...snapshot(0), visibilityEpoch: 0 })
    expect(hidden.finish({ ...snapshot(1), visibilityEpoch: 2 }).valid).toBe(false)
  })

  it('rejects invalid counters and keeps successive trials independent', () => {
    const invalid = createTrialSampling({ condition })
    invalid.observe({ condition, stats: { callbacks: -1 } })
    expect(invalid.finish(snapshot(0)).valid).toBe(false)
    const first = createTrialSampling({ condition })
    first.observe(snapshot(0))
    first.finish(snapshot(3))
    const next = createTrialSampling({ condition })
    next.observe(snapshot(0))
    expect(next.finish(snapshot(1)).counters.totals.callbacks).toBe(1)
    const short = createTrialSampling({ condition })
    const shortResult = short.finish(snapshot(4))
    expect(shortResult.counters.totals.callbacks).toBe(4)
    expect(shortResult.counters.terminal.callbacks).toBe(4)
    expect(() => short.finish(snapshot(5))).toThrow()
    const resource = createTrialSampling({ condition, counters: false })
    resource.observe({ condition, visibilityEpoch: 0 })
    expect(resource.finish({ condition, visibilityEpoch: 0 }).counters).toBeNull()
    expect(() => selectScenario('not-a-scenario')).toThrow()
  })
})
