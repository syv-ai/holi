import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { processObservables } from './vault-snapshot-bench-metrics.mjs'

export const T_CRITICAL_DF4 = 2.776445

export function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export function pairedInterval(values) {
  if (values.length !== 5 || values.some((value) => !Number.isFinite(value)))
    return { n: values.length, mean: null, lower95: null, upper95: null, complete: false }
  const average = mean(values)
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / 4
  const half = T_CRITICAL_DF4 * Math.sqrt(variance / 5)
  return { n: 5, mean: average, lower95: average - half, upper95: average + half, complete: true }
}

export function validatePairs(results, pilot = false) {
  const expected = pilot ? 1 : 5
  const problems = []
  for (const size of ['small', 'large']) {
    const pairs = results.filter((pair) => pair.size === size)
    if (pairs.length !== expected)
      problems.push(`${size}: expected ${expected} pairs, got ${pairs.length}`)
    const numbers = new Set()
    for (const pair of pairs) {
      if (
        !Number.isInteger(pair.pair) ||
        pair.pair < 1 ||
        pair.pair > expected ||
        numbers.has(pair.pair)
      )
        problems.push(`${size}: duplicate or invalid pair number ${pair.pair}`)
      numbers.add(pair.pair)
      const modes = pair.trials?.map((trial) => trial.mode).sort()
      if (JSON.stringify(modes) !== JSON.stringify(['baseline', 'candidate']))
        problems.push(`${size} pair ${pair.pair}: requires exactly one baseline and candidate`)
    }
    if (
      !pilot &&
      numbers.size === 5 &&
      [...numbers].sort().some((number, index) => number !== index + 1)
    )
      problems.push(`${size}: pair numbering must be 1 through 5`)
  }
  if (results.some((pair) => !['small', 'large'].includes(pair.size))) problems.push('unknown size')
  return { valid: problems.length === 0, problems }
}

// Capture once at the idle/diagnostic seam, including nested adapter callbacks.
export function freezeMeasurement(value) {
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze)
      Object.freeze(item)
    }
    return item
  }
  return freeze(structuredClone(value))
}

/** @param {{error?: unknown, cleanupErrors: readonly unknown[], valid: boolean}} outcome */
export function trialSucceeded({ error, cleanupErrors, valid }) {
  return error === undefined && cleanupErrors.length === 0 && valid === true
}

export function sourceVersion() {
  const directory = fileURLToPath(new URL('.', import.meta.url))
  const files = [
    'vault-snapshot-bench-main.ts',
    'vault-snapshot-bench-analysis.mjs',
    'vault-snapshot-bench-capture.ts',
    'vault-snapshot-bench-metrics.mjs',
    'vault-snapshot-bench-adapter.ts',
    'vault-snapshot-bench-rpc.ts',
    'vault-snapshot-bench-renderer.tsx',
    'run-vault-snapshot-bench.mjs',
  ]
  return {
    identity:
      'gitHead is the checkout commit; sha256 identifies the exact measured working source, including uncommitted corrections',
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim(),
    sha256: Object.fromEntries(
      files.map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(directory, file)))
          .digest('hex'),
      ]),
    ),
  }
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const interval = (values) => pairedInterval(values.filter(finite))
const measured = (pair, mode) => pair.trials?.find((trial) => trial.mode === mode)?.result
const change = (candidate, baseline) =>
  finite(candidate) && finite(baseline) ? candidate - baseline : null
// A measured zero baseline has no relative increase when the candidate is also
// zero. A positive candidate at zero baseline exceeds any relative margin.
const relative = (candidate, baseline) =>
  !finite(candidate) || !finite(baseline)
    ? null
    : baseline > 0
      ? candidate / baseline - 1
      : candidate === 0
        ? 0
        : null

function cpuPerMinute(result) {
  return finite(result?.cpuSeconds) &&
    result.cpuSeconds >= 0 &&
    finite(result.sampleElapsedSeconds) &&
    result.sampleElapsedSeconds > 0
    ? (result.cpuSeconds * 60) / result.sampleElapsedSeconds
    : null
}

function changedLatency(result) {
  const metric = result?.nativeUserChangesLatency
  if (
    metric?.complete !== true ||
    metric.rawMs?.length !== 5 ||
    metric.rawMs.some((value) => !finite(value) || value < 0 || value > 5000)
  )
    return null
  // Derive the per-trial p95 from the raw five writes, never from idle scan time.
  return Math.max(...metric.rawMs)
}

function benefitGate(ci, threshold) {
  if (!ci.complete) return 'inconclusive'
  if (ci.lower95 >= threshold) return 'pass'
  if (ci.upper95 < threshold) return 'fail'
  return 'inconclusive'
}

// Material regression is a joint criterion, not two independent vetoes.
function regressionGate(absolute, relative, absoluteMargin, relativeMargin) {
  if (!absolute.complete || !relative.complete) return 'inconclusive'
  if (absolute.lower95 >= absoluteMargin && relative.lower95 >= relativeMargin) return 'fail'
  if (absolute.upper95 < absoluteMargin || relative.upper95 < relativeMargin) return 'pass'
  return 'inconclusive'
}

function regression(baseline, candidate, absoluteMargin, relativeMargin) {
  const absoluteValues = baseline.map((b, i) => change(candidate[i], b))
  const relativeValues = baseline.map((b, i) => relative(candidate[i], b))
  const absolute = interval(absoluteValues),
    relativeCI = interval(relativeValues)
  // Zero baseline with positive candidate: establish relative threshold without
  // manufacturing infinity/NaN in the recorded paired interval.
  const zeroBaseline =
    baseline.length === 5 &&
    baseline.every((b, i) => b === 0 && finite(candidate[i]) && candidate[i] > 0)
  const status =
    zeroBaseline && absolute.complete
      ? absolute.lower95 >= absoluteMargin
        ? 'fail'
        : absolute.upper95 < absoluteMargin
          ? 'pass'
          : 'inconclusive'
      : regressionGate(absolute, relativeCI, absoluteMargin, relativeMargin)
  return {
    absolute,
    relative: relativeCI,
    absoluteValues,
    relativeValues,
    margins: { absolute: absoluteMargin, relative: relativeMargin },
    status,
  }
}

/**
 * Protocol 4 requires allocation main/renderer sampledBytes, elapsedSeconds (>0),
 * gcCount and gcDurationMs; physicalGpu availability/source/scope/samples (host
 * utilization is context, never owned attribution); publicationLatencyMs from
 * completion barriers; and fullCorrectness in full trials. Every correctness
 * value must be true and include the pilot assertion keys. Missing evidence is
 * inconclusive, not zero. Allocation is sampled/estimated, not an exact total.
 */
export function analyzePairs(results, { pilot = false } = {}) {
  const validation = validatePairs(results, pilot)
  const sizes = /** @type {Record<string, any>} */ ({})
  for (const size of ['small', 'large']) {
    const pairs = results.filter((pair) => pair.size === size).sort((a, b) => a.pair - b.pair)
    const raw = pairs.map((pair) => {
      // Failed trials are never silently converted to passing metrics.
      const baseline = measured(pair, 'baseline'),
        candidate = measured(pair, 'candidate')
      const sourceValid =
        baseline?.protocolRevision === 4 &&
        candidate?.protocolRevision === 4 &&
        typeof baseline?.mainBundleSha256 === 'string' &&
        baseline.mainBundleSha256.length > 0 &&
        baseline.mainBundleSha256 === candidate?.mainBundleSha256
      const trialValid = baseline?.ok === true && candidate?.ok === true && sourceValid
      const completeAllocation = (value) =>
        ['main', 'renderer'].every((process) => {
          const row = value?.allocation?.[process]
          return (
            row &&
            finite(row.sampledBytes) &&
            row.sampledBytes >= 0 &&
            finite(row.elapsedSeconds) &&
            row.elapsedSeconds > 0 &&
            Number.isInteger(row.gcCount) &&
            row.gcCount >= 0 &&
            Number.isInteger(row.gcCount) &&
            row.gcCount >= 0 &&
            Number.isInteger(row.gcDurationMs) &&
            row.gcDurationMs >= 0
          )
        })
      const completeGpu = (value) => {
        const gpu = value?.physicalGpu
        return (
          gpu &&
          gpu.available === true &&
          typeof gpu.source === 'string' &&
          gpu.source.trim().length > 0 &&
          ['host', 'owned'].includes(gpu.scope) &&
          Array.isArray(gpu.samples) &&
          gpu.samples.length >= 2 &&
          gpu.samples.every(
            (sample) =>
              finite(sample?.at) &&
              sample.at >= 0 &&
              finite(sample?.utilizationPercent) &&
              sample.utilizationPercent >= 0 &&
              sample.utilizationPercent <= 100,
          ) &&
          gpu.samples.every((sample, index) => index === 0 || sample.at > gpu.samples[index - 1].at)
        )
      }
      const correctnessKeys = [
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
      ]
      const completeCorrectness = (value) =>
        value?.fullCorrectness &&
        correctnessKeys.every((key) => value.fullCorrectness[key] === true) &&
        Object.values(value.fullCorrectness).every((item) => item === true)
      const completePublication = (value) =>
        Array.isArray(value?.publicationLatencyMs) &&
        value.publicationLatencyMs.length > 0 &&
        value.publicationLatencyMs.every((item) => finite(item) && item >= 0)
      const completeEvidence = (value) =>
        completeAllocation(value) &&
        completeGpu(value) &&
        completePublication(value) &&
        processObservables(value) !== null &&
        processObservables(value, (row) => /gpu/i.test(`${row.type} ${row.name ?? ''}`)) !== null &&
        processObservables(value, (row) => !['Browser', 'Tab'].includes(row.type)) !== null &&
        (pilot || completeCorrectness(value))
      const evidenceValid = completeEvidence(baseline) && completeEvidence(candidate)
      const valid = trialValid && evidenceValid
      const metrics = (result) => {
        const processes = processObservables(result)
        const gpu = processObservables(result, (row) =>
          /gpu/i.test(`${row.type} ${row.name ?? ''}`),
        )
        const helpers = processObservables(result, (row) => !['Browser', 'Tab'].includes(row.type))
        return {
          cpuSeconds: result?.cpuSeconds ?? null,
          sampleElapsedSeconds: result?.sampleElapsedSeconds ?? null,
          cpuSecondsPerMinute: valid ? cpuPerMinute(result) : null,
          changedUpdateP95Ms: valid ? changedLatency(result) : null,
          changedUpdateRawMs: result?.nativeUserChangesLatency?.rawMs ?? null,
          allocation: completeAllocation(result) ? result.allocation : null,
          allocationRates: completeAllocation(result)
            ? Object.fromEntries(
                ['main', 'renderer'].map((process) => {
                  const row = result.allocation[process]
                  const minutes = row.elapsedSeconds / 60
                  return [
                    process,
                    {
                      sampledBytesPerMinute: row.sampledBytes / minutes,
                      gcCountPerMinute: row.gcCount / minutes,
                      gcDurationMsPerMinute: row.gcDurationMs / minutes,
                    },
                  ]
                }),
              )
            : null,
          physicalGpu: completeGpu(result) ? result.physicalGpu : null,
          publicationLatencyMs: completePublication(result) ? result.publicationLatencyMs : null,
          fullCorrectness: result?.fullCorrectness ?? null,
          rendererSends: result?.rendererSends ?? null,
          rendererStats: result?.rendererStats ?? null,
          snapshotCounts: result?.snapshotCounts ?? null,
          snapshotNotifications: result?.snapshotNotifications ?? null,
          adapter: result?.adapter ?? null,
          payloadBytes:
            valid && finite(result?.rendererSends?.bytes) ? result.rendererSends.bytes : null,
          processes: valid ? processes : null,
          gpu: valid ? gpu : null,
          helpers: valid ? helpers : null,
          idleScanDiagnosticMs: result?.scanDurationsMs ?? null,
          source: {
            protocolRevision: result?.protocolRevision ?? null,
            mainBundleSha256: result?.mainBundleSha256 ?? null,
          },
        }
      }
      const b = metrics(baseline),
        c = metrics(candidate)
      return {
        pair: pair.pair,
        order: pair.trials.map((trial) => trial.mode),
        baseline: b,
        candidate: c,
        valid: valid && evidenceValid,
        failureCauses: [
          ...(!evidenceValid
            ? [
                {
                  error:
                    'missing or invalid protocol 4 allocation, GPU, publication, or full correctness evidence',
                },
              ]
            : []),
          ...(!sourceValid
            ? [{ error: 'missing/mismatched paired source bundle or protocol revision 4' }]
            : []),
          ...pair.trials
            .filter((trial) => trial.result?.ok !== true)
            .map((trial) => ({
              mode: trial.mode,
              error: trial.result?.error ?? 'missing/failed result',
              cleanupErrors: trial.result?.cleanupErrors ?? [],
            })),
        ],
        cpuSecondsSavedPerMinute: change(b.cpuSecondsPerMinute, c.cpuSecondsPerMinute),
        cpuReduction:
          b.cpuSecondsPerMinute > 0 && finite(c.cpuSecondsPerMinute)
            ? 1 - c.cpuSecondsPerMinute / b.cpuSecondsPerMinute
            : null,
        payloadAvoidedFraction:
          b.payloadBytes > 0 && finite(c.payloadBytes) ? 1 - c.payloadBytes / b.payloadBytes : null,
        ipcByteProxy: 'rendererSends.bytes is a serialized-payload proxy, not measured wire bytes',
      }
    })
    const b = raw.map((pair) => pair.baseline),
      c = raw.map((pair) => pair.candidate)
    const reg = (get, abs, rel) => regression(b.map(get), c.map(get), abs, rel)
    const cpu = interval(raw.map((pair) => pair.cpuSecondsSavedPerMinute))
    const cpuRelative = interval(raw.map((pair) => pair.cpuReduction))
    const payload = interval(raw.map((pair) => pair.payloadAvoidedFraction))
    const publicationSavings = interval(
      raw.map((pair) => {
        const p95 = (values) =>
          [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
        const baseline = pair.baseline.publicationLatencyMs
        const candidate = pair.candidate.publicationLatencyMs
        return baseline && candidate ? p95(baseline) - p95(candidate) : null
      }),
    )
    const publicationRelative = interval(
      raw.map((pair) => {
        const b = pair.baseline.publicationLatencyMs
        const c = pair.candidate.publicationLatencyMs
        if (!b || !c) return null
        const p95 = (values) =>
          [...values].sort((x, y) => x - y)[Math.ceil(values.length * 0.95) - 1]
        return p95(b) > 0 ? (p95(b) - p95(c)) / p95(b) : null
      }),
    )
    const latency = reg((m) => m.changedUpdateP95Ms, 20, 0.1)
    const memory = {
      steady: reg((m) => m.processes?.rssSteadyBytes, 10 * 1024 * 1024, 0.05),
      peak: reg((m) => m.processes?.rssPeakBytes, 10 * 1024 * 1024, 0.05),
    }
    const gpu = {
      cpu: reg((m) => m.gpu?.cpuSecondsPerMinute, 0.03, 0.1),
      steady: reg((m) => m.gpu?.rssSteadyBytes, 10 * 1024 * 1024, 0.05),
      peak: reg((m) => m.gpu?.rssPeakBytes, 10 * 1024 * 1024, 0.05),
    }
    const helperDeltas = raw.map((pair) =>
      change(pair.candidate.helpers?.processCountPeak, pair.baseline.helpers?.processCountPeak),
    )
    const helperCount =
      helperDeltas.length !== 5 || helperDeltas.some((delta) => !finite(delta))
        ? 'inconclusive'
        : helperDeltas.some((delta) => delta > 0)
          ? 'fail'
          : 'pass'
    sizes[size] = {
      pairs: raw,
      cpuSecondsSavedPerMinute: cpu,
      relativeCpuReduction: cpuRelative,
      payloadAvoidedFraction: payload,
      latencyRegression: latency,
      memoryRegression: memory,
      gpuRegression: gpu,
      helperCountDeltas: helperDeltas,
      publicationLatencySavingsMs: publicationSavings,
      publicationLatencyRelativeSavings: publicationRelative,
      allocationComparison: Object.fromEntries(
        ['main', 'renderer'].map((process) => {
          const metrics = ['sampledBytesPerMinute', 'gcCountPerMinute', 'gcDurationMsPerMinute']
          return [
            process,
            Object.fromEntries(
              metrics.map((metric) => {
                const differences = raw.map((pair) =>
                  change(
                    pair.candidate.allocationRates?.[process]?.[metric],
                    pair.baseline.allocationRates?.[process]?.[metric],
                  ),
                )
                return [
                  metric,
                  {
                    baseline: raw.map(
                      (pair) => pair.baseline.allocationRates?.[process]?.[metric] ?? null,
                    ),
                    candidate: raw.map(
                      (pair) => pair.candidate.allocationRates?.[process]?.[metric] ?? null,
                    ),
                    difference: interval(differences),
                  },
                ]
              }),
            ),
          ]
        }),
      ),
      benefitGates: {
        absoluteCpuSavings: benefitGate(cpu, 0.3),
        largePublicationLatencySavings:
          size === 'large'
            ? benefitGate(publicationSavings, 5) === 'pass' &&
              benefitGate(publicationRelative, 0.1) === 'pass'
              ? 'pass'
              : benefitGate(publicationSavings, 5) === 'fail' ||
                  benefitGate(publicationRelative, 0.1) === 'fail'
                ? 'fail'
                : 'inconclusive'
            : 'not-primary',
        relativeCpuSavings: benefitGate(cpuRelative, 0.2),
      },
      guardrailGates: {
        payloadAvoidance: benefitGate(payload, 0.9),
        latency: latency.status,
        memorySteady: memory.steady.status,
        memoryPeak: memory.peak.status,
        gpuCpu: gpu.cpu.status,
        gpuRssSteady: gpu.steady.status,
        gpuRssPeak: gpu.peak.status,
        helperProcessCount: helperCount,
      },
    }
  }
  const allComplete =
    !pilot &&
    validation.valid &&
    Object.values(sizes).every(
      (entry) => entry.pairs.length === 5 && entry.pairs.every((pair) => pair.valid),
    )
  const required = {
    ...Object.fromEntries(
      Object.entries(sizes.large.benefitGates).map(([name, status]) => [`large.${name}`, status]),
    ),
    ...Object.fromEntries(
      Object.entries(sizes).flatMap(([size, entry]) =>
        Object.entries(entry.guardrailGates).map(([name, status]) => [`${size}.${name}`, status]),
      ),
    ),
  }
  const failures = Object.entries(required)
    .filter(([, status]) => status === 'fail')
    .map(([name]) => name)
  const uncertain = Object.entries(required)
    .filter(([, status]) => status === 'inconclusive')
    .map(([name]) => name)
  const failedTrials = Object.values(sizes).flatMap((size) =>
    size.pairs.flatMap((pair) => pair.failureCauses),
  )
  return {
    issue: 544,
    protocolRevision: 4,
    sourceVersion: sourceVersion(),
    pilot,
    primaryBenefitWorkload: 'large',
    guardrailWorkloads: ['small', 'large'],
    units: {
      cpu: 'CPU-seconds/minute (each raw delta normalized by its actual sampleElapsedSeconds before paired CI)',
      latency: 'post-idle changed-update per-trial p95 milliseconds',
      memory: 'RSS bytes',
      relative: 'fraction',
    },
    regressionRule:
      'material only when BOTH relative and absolute margins are met; fail if both lower95 bounds meet margins, pass if either upper95 is below its margin, otherwise inconclusive; unknown never passes',
    complete: allComplete,
    expectedTrials: pilot ? 4 : 20,
    actualTrials: results.reduce((sum, pair) => sum + (pair.trials?.length ?? 0), 0),
    pairValidation: validation,
    classification: pilot
      ? 'pilot-not-gate-evidence'
      : !allComplete
        ? 'incomplete'
        : failures.length || failedTrials.length
          ? 'gate-fail'
          : uncertain.length
            ? 'inconclusive'
            : 'gate-pass',
    failureCauses: { gates: failures, trials: failedTrials, validation: validation.problems },
    inconclusiveGates: uncertain,
    requiredGates: required,
    interpretation:
      'Inconclusive or insufficient evidence is not evidence of no benefit. Small CPU benefit is a control, never a primary benefit veto. GPU results concern process CPU/RSS, not hardware GPU activity.',
    sizes,
  }
}

export async function writeAnalysis(evidence, results, options) {
  const analysis = analyzePairs(results, options)
  await writeFile(join(evidence, 'analysis.json'), JSON.stringify(analysis, null, 2))
  return analysis
}
