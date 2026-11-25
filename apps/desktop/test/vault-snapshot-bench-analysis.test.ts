import { describe, expect, it } from 'vitest'
import { processObservables } from '../scripts/vault-snapshot-bench-metrics.mjs'
import {
  analyzePairs,
  freezeMeasurement,
  pairedInterval,
  trialSucceeded,
  validatePairs,
} from '../scripts/vault-snapshot-bench-analysis.mjs'

const MiB = 1024 * 1024
const durations = [178, 180, 181, 179, 182]

function result(mode: 'baseline' | 'candidate', elapsed: number, rate: number) {
  const gpuRate = 0.06
  const rows = (seconds: number) => [
    {
      pid: 100,
      type: 'Browser',
      name: 'browser',
      cpuPercent: ((rate - gpuRate) / 60) * 100,
      cumulativeCpuUsage: 10 + ((rate - gpuRate) * seconds) / 60,
      workingSetBytes: 100 * MiB,
    },
    {
      pid: 101,
      type: 'GPU',
      name: 'gpu-process',
      cpuPercent: (gpuRate / 60) * 100,
      cumulativeCpuUsage: 2 + (gpuRate * seconds) / 60,
      workingSetBytes: 20 * MiB,
    },
  ]
  return {
    mode,
    result: {
      mode,
      ok: true,
      error: null,
      cleanupErrors: [] as string[],
      cpuSeconds: (rate * elapsed) / 60,
      sampleElapsedSeconds: elapsed,
      protocolRevision: 4,
      mainBundleSha256: 'test-source',
      scanDurationsMs: [10, 11, 12],
      nativeUserChangesLatency: {
        complete: true,
        rawMs: [80, 90, 95, 99, 100],
        p95Ms: 100,
      },
      rendererSends: { count: mode === 'baseline' ? 6 : 0, bytes: mode === 'baseline' ? 1000 : 0 },
      allocation: Object.fromEntries(
        ['main', 'renderer'].map((process) => [
          process,
          {
            sampledBytes: 1024,
            elapsedSeconds: elapsed,
            gcCount: 0,
            gcDurationMs: 0,
          },
        ]),
      ),
      physicalGpu: {
        available: true,
        source: 'test',
        scope: 'host',
        samples: [
          { at: 1, utilizationPercent: 0 },
          { at: 2, utilizationPercent: 1 },
        ],
      },
      publicationLatencyMs: mode === 'baseline' ? [20, 21] : [10, 11],
      fullCorrectness: Object.fromEntries(
        [
          'initialSnapshot',
          'unchangedHeal',
          'restoredMtimeNote',
          'taskChanges',
          'fileCreateDeleteRename',
          'settingsChanges',
          'pluginEnablement',
          'explicitRefresh',
          'droppedWatcherRecovery',
          'vaultAba',
          'staleRemote',
        ].map((key) => [key, true]),
      ),
      samples: [
        { at: 20, processes: rows(0) },
        { at: 20 + elapsed / 2, processes: rows(elapsed / 2) },
        { at: 20 + elapsed, processes: rows(elapsed) },
      ],
    },
  }
}

function pairs(size: 'small' | 'large', count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    size,
    pair: index + 1,
    trials: [
      result('baseline', durations[index]!, size === 'large' ? 1 : 0.1),
      result('candidate', durations[index]! + 0.25, size === 'large' ? 0.3 : 0.1),
    ],
  }))
}
const study = () => [...pairs('small'), ...pairs('large')]

describe('snapshot benchmark analysis', () => {
  it('rejects incomplete GPU and invalid CPU process observations', () => {
    const samples = [
      { at: 1, processes: [{ pid: 1, type: 'GPU', workingSetBytes: 10, cumulativeCpuUsage: 1 }] },
      { at: 2, processes: [{ pid: 2, type: 'GPU', workingSetBytes: 12, cumulativeCpuUsage: 2 }] },
    ]
    expect(processObservables({ samples }, (row) => row.type === 'GPU')).toBeNull()
    expect(
      processObservables({
        samples: [
          {
            at: 1,
            processes: [{ pid: 1, type: 'CPU', workingSetBytes: 10, cumulativeCpuUsage: 1 }],
          },
          {
            at: 2,
            processes: [{ pid: 1, type: 'CPU', workingSetBytes: 12, cumulativeCpuUsage: -1 }],
          },
        ],
      }),
    ).toBeNull()
  })

  it('computes paired Student-t intervals with df=4', () => {
    expect(pairedInterval([1, 2, 3, 4, 5])).toEqual({
      n: 5,
      mean: 3,
      lower95: 3 - 2.776445 * Math.sqrt(2.5 / 5),
      upper95: 3 + 2.776445 * Math.sqrt(2.5 / 5),
      complete: true,
    })
    expect(pairedInterval([1, 2])).toMatchObject({ complete: false, mean: null })
  })

  it('requires five unique pairs per size and exactly one of each mode', () => {
    expect(validatePairs(study()).valid).toBe(true)
    expect(validatePairs([...pairs('small', 4), ...pairs('large')]).valid).toBe(false)
    const malformed = pairs('small')
    malformed[0]!.trials = [result('candidate', 180, 1), result('candidate', 180, 2)]
    expect(validatePairs([...malformed, ...pairs('large')]).problems).toContain(
      'small pair 1: requires exactly one baseline and candidate',
    )
  })

  it('uses large benefit alone and actual per-trial elapsed time for mean and both CI bounds', () => {
    const data = study()
    const savings = [0.5, 0.6, 0.7, 0.8, 0.9]
    for (const pair of data.filter((pair) => pair.size === 'large')) {
      const candidate = pair.trials[1]!.result
      candidate.cpuSeconds = ((1 - savings[pair.pair - 1]!) * candidate.sampleElapsedSeconds) / 60
    }
    const analysis = analyzePairs(data)
    expect(analysis.classification).toBe('gate-pass')
    expect(analysis.sizes.small.benefitGates.absoluteCpuSavings).toBe('fail')
    const expected = pairedInterval(savings)
    const actual = analysis.sizes.large.cpuSecondsSavedPerMinute
    for (const key of ['mean', 'lower95', 'upper95'] as const)
      expect(actual[key]).toBeCloseTo(expected[key]!, 12)
    expect(analysis.sizes.large.pairs[0]).toMatchObject({
      baseline: { cpuSecondsPerMinute: 1, sampleElapsedSeconds: 178 },
      candidate: { cpuSecondsPerMinute: 0.5, sampleElapsedSeconds: 178.25 },
      cpuSecondsSavedPerMinute: 0.5,
    })
    expect(analysis.units.cpu).toContain('CPU-seconds/minute')
    expect(analysis.sourceVersion.sha256['vault-snapshot-bench-analysis.mjs']).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(analysis.protocolRevision).toBe(4)
  })

  it.each([115, 1025])(
    'does not fail latency when only one joint margin is exceeded (%s ms)',
    (value) => {
      const data = study()
      for (const pair of data) {
        const baseline = value === 115 ? 100 : 1000
        pair.trials[0]!.result.nativeUserChangesLatency.rawMs = Array(5).fill(baseline)
        pair.trials[1]!.result.nativeUserChangesLatency.rawMs = Array(5).fill(value)
      }
      expect(analyzePairs(data).classification).toBe('gate-pass')
    },
  )

  it('keeps a joint regression inconclusive when one CI clears its margin and the other overlaps', () => {
    const data = study()
    for (const pair of data) {
      pair.trials[1]!.result.nativeUserChangesLatency.rawMs = Array(5).fill(105 + pair.pair * 5)
    }
    const analysis = analyzePairs(data)
    expect(analysis.sizes.large.latencyRegression.relative.lower95).toBeGreaterThan(0.1)
    expect(analysis.sizes.large.latencyRegression.absolute.lower95).toBeLessThan(20)
    expect(analysis.sizes.large.guardrailGates.latency).toBe('inconclusive')
    expect(analysis.classification).toBe('inconclusive')
  })

  it('uses changed-update p95, not idle scan latency or stale recorded p95', () => {
    const data = study()
    for (const pair of data) {
      pair.trials[1]!.result.nativeUserChangesLatency.rawMs = [80, 90, 100, 110, 130]
      pair.trials[1]!.result.scanDurationsMs = [1, 1, 1]
    }
    const analysis = analyzePairs(data)
    expect(analysis.classification).toBe('gate-fail')
    expect(analysis.sizes.small.latencyRegression.absolute.mean).toBe(30)
    expect(analysis.sizes.small.latencyRegression.relative.mean).toBeCloseTo(0.3)
    expect(analysis.failureCauses.gates).toContain('small.latency')
  })

  it('keeps missing latency or unknown process samples inconclusive', () => {
    for (const missing of ['latency', 'process']) {
      const data = study()
      if (missing === 'latency')
        data[0]!.trials[0]!.result.nativeUserChangesLatency.complete = false
      else data[0]!.trials[0]!.result.samples[0]!.processes = []
      const analysis = analyzePairs(data)
      expect(analysis.classification).toBe(missing === 'latency' ? 'inconclusive' : 'incomplete')
      expect(analysis.failureCauses.gates).toEqual([])
    }
  })

  it('requires both absolute and relative RSS margins for memory failure', () => {
    const data = study()
    for (const pair of data)
      for (const sample of pair.trials[1]!.result.samples)
        sample.processes[0]!.workingSetBytes += 7 * MiB
    const analysis = analyzePairs(data)
    expect(analysis.classification).toBe('gate-pass')
    expect(analysis.sizes.large.memoryRegression.steady.relative.mean).toBeGreaterThan(0.05)
    for (const pair of data)
      for (const sample of pair.trials[1]!.result.samples)
        sample.processes[0]!.workingSetBytes += 4 * MiB
    expect(analyzePairs(data).classification).toBe('gate-fail')
  })

  it('detects GPU CPU regression from PID deltas without any process-count change', () => {
    const data = study()
    for (const pair of data) {
      const result = pair.trials[1]!.result
      for (const sample of result.samples) {
        sample.processes[1]!.cumulativeCpuUsage = 2 + (0.2 * (sample.at - 20)) / 60
      }
    }
    const analysis = analyzePairs(data)
    expect(analysis.classification).toBe('gate-fail')
    expect(analysis.sizes.large.guardrailGates.gpuCpu).toBe('fail')
    expect(analysis.sizes.large.guardrailGates.helperProcessCount).toBe('pass')
    expect(analysis.sizes.large.pairs[0].candidate.gpu.cpuSecondsPerMinute).toBeCloseTo(0.2)
    expect(analysis.sizes.large.pairs[0].candidate.gpu.rssPeakBytes).toBe(20 * MiB)
    expect(analysis.sizes.large.pairs[0].candidate.gpu.pidRows).toHaveLength(3)
  })

  it('detects GPU RSS material regression and helper-process count increases', () => {
    const gpu = study()
    for (const pair of gpu)
      for (const sample of pair.trials[1]!.result.samples)
        sample.processes[1]!.workingSetBytes += 11 * MiB
    expect(analyzePairs(gpu).sizes.small.guardrailGates.gpuRssPeak).toBe('fail')
    const helpers = study()
    for (const pair of helpers)
      for (const sample of pair.trials[1]!.result.samples)
        sample.processes.push({ ...sample.processes[1]!, pid: 102, type: 'Utility' })
    expect(analyzePairs(helpers).sizes.small.guardrailGates.helperProcessCount).toBe('fail')
  })

  it('fails confidently insufficient large benefit at either unchanged threshold', () => {
    for (const [baselineRate, candidateRate] of [
      [1, 0.9],
      [0.3, 0.15],
    ]) {
      const data = study()
      for (const pair of data.filter((pair) => pair.size === 'large')) {
        pair.trials[0]!.result.cpuSeconds =
          (baselineRate! * pair.trials[0]!.result.sampleElapsedSeconds) / 60
        pair.trials[1]!.result.cpuSeconds =
          (candidateRate! * pair.trials[1]!.result.sampleElapsedSeconds) / 60
      }
      expect(analyzePairs(data).classification).toBe('gate-fail')
    }
  })

  it('does not turn uncertain or incomplete benefit evidence into no benefit', () => {
    const data = study()
    for (const pair of data.filter((pair) => pair.size === 'large')) {
      const candidate = pair.trials[1]!.result
      candidate.cpuSeconds = ((pair.pair % 2 ? 1 : 0.1) * candidate.sampleElapsedSeconds) / 60
    }
    expect(analyzePairs(data).classification).toBe('inconclusive')
    const partial = analyzePairs([...pairs('small', 1), ...pairs('large', 1)])
    expect(partial.classification).toBe('incomplete')
    expect(partial.interpretation).toContain('not evidence of no benefit')
    expect(
      analyzePairs([...pairs('small', 1), ...pairs('large', 1)], { pilot: true }).classification,
    ).toBe('pilot-not-gate-evidence')
  })

  it('freezes every nested timed counter independently from diagnostic mutation', () => {
    const original = {
      rendererSends: { count: 1, bytes: 123 },
      snapshotNotifications: 1,
      scanDurationsMs: [10],
      snapshot: { docs: [{ text: 'fixture' }] },
      adapter: { scans: 1, pluginCallbacks: [{ kind: 'snapshot', elapsedMs: 1 }] },
      renderer: { commits: 1 },
      samples: [{ at: 180, processes: [{ cpuPercent: 1 }] }],
    }
    const capture = freezeMeasurement(original)
    original.rendererSends.count = 7
    original.snapshotNotifications = 7
    original.scanDurationsMs.push(20)
    original.adapter.pluginCallbacks[0]!.elapsedMs = 9
    original.snapshot.docs[0]!.text = 'changed'
    original.renderer.commits = 7
    original.samples[0]!.processes[0]!.cpuPercent = 99
    expect(capture).toMatchObject({
      rendererSends: { count: 1 },
      snapshotNotifications: 1,
      scanDurationsMs: [10],
      snapshot: { docs: [{ text: 'fixture' }] },
      adapter: { pluginCallbacks: [{ elapsedMs: 1 }] },
      renderer: { commits: 1 },
      samples: [{ processes: [{ cpuPercent: 1 }] }],
    })
    expect(() => {
      capture.rendererSends.count++
    }).toThrow()
  })

  it('refuses mismatched source bundles or protocol revisions instead of granting a pass', () => {
    for (const mismatch of ['bundle', 'protocol']) {
      const data = study()
      if (mismatch === 'bundle') data[0]!.trials[1]!.result.mainBundleSha256 = 'different-source'
      else data[0]!.trials[1]!.result.protocolRevision = 2
      const analysis = analyzePairs(data)
      expect(analysis.classification).toBe('incomplete')
      expect(analysis.failureCauses.trials[0].error).toContain('source bundle or protocol revision')
    }
  })

  it('never reports cleanup failure as a successful trial or passing study', () => {
    expect(trialSucceeded({ valid: true, cleanupErrors: [] })).toBe(true)
    expect(trialSucceeded({ valid: true, cleanupErrors: ['vault.close failed'] })).toBe(false)
    const data = study()
    data[0]!.trials[0]!.result.ok = trialSucceeded({
      valid: true,
      cleanupErrors: ['plugins.stopAll failed'],
    })
    data[0]!.trials[0]!.result.cleanupErrors = ['plugins.stopAll failed']
    const analysis = analyzePairs(data)
    expect(analysis.classification).toBe('incomplete')
    expect(analysis.failureCauses.trials[0].cleanupErrors).toEqual(['plugins.stopAll failed'])
  })
})
