import { describe, expect, it } from 'vitest'
import { parseBenchmarkOptions } from '../scripts/browser-placement-bench-config.mjs'
import { validateTrials, terminalCounters } from '../scripts/browser-placement-bench-results.mjs'
import { createTrialSampling } from '../scripts/browser-placement-bench-sampling.mjs'

const stats = (n: number) => ({ callbacks: n, hostRects: n, coverageScans: n, overlayRects: n })
const condition = { focused: true, visible: true, minimized: false }
const receipt = (n: number) => {
  const sampling = createTrialSampling({ condition })
  sampling.observe({ condition, visibilityEpoch: 0, stats: stats(2) })
  const result = sampling.finish({ condition, visibilityEpoch: 0, stats: stats(n) })
  return { scenario: 'short', trial: 'rep-1', ...result }
}

describe('browser placement benchmark configuration and receipts', () => {
  it('accepts foreground baseline options and refuses unsupported invocation', () => {
    expect(
      parseBenchmarkOptions(
        [
          '--focus',
          'foreground',
          '--seconds',
          '5',
          '--warmup',
          '0',
          '--repetitions',
          '1',
          '--scenario',
          'short',
        ],
        'darwin',
      ),
    ).toMatchObject({
      focus: 'foreground',
      variant: 'baseline',
      seconds: 5,
      warmup: 0,
      repetitions: 1,
      scenario: 'short',
    })
    expect(() => parseBenchmarkOptions([], 'darwin')).toThrow()
    expect(() => parseBenchmarkOptions(['--focus', 'foreground'], 'win32')).toThrow()
    expect(() =>
      parseBenchmarkOptions(['--focus', 'foreground', '--variant', 'hybrid'], 'darwin'),
    ).toThrow()
    expect(() =>
      parseBenchmarkOptions(['--focus', 'foreground', '--scenario', 'unknown'], 'darwin'),
    ).toThrow()
  })

  it('requires complete unique valid receipts and reports terminal rather than periodic counters', () => {
    const valid = receipt(5)
    valid.counters!.totals.callbacks = 5
    const trials = validateTrials({ trials: [valid] }, ['short'], 1, true)
    expect(terminalCounters(trials, 'short', 1)['rep-1'].callbacks).toBe(5)
    for (const list of [[], [valid, valid], [{ ...valid, valid: false }]])
      expect(() => validateTrials({ trials: list }, ['short'], 1, true)).toThrow()
    const malformed = { ...valid, counters: { totals: { ...stats(5), callbacks: -1 } } }
    expect(() => validateTrials({ trials: [malformed] }, ['short'], 1, true)).toThrow()
  })
})
