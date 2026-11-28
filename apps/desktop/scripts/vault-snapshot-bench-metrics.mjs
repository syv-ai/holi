const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length

/** Validate complete, selected process coverage and derive CPU/RSS observations. */
export function processObservables(result, select = () => true) {
  const samples = result?.samples
  if (!Array.isArray(samples) || samples.length < 2) return null
  const selected = []
  let priorAt = -Infinity
  for (const sample of samples) {
    if (!finite(sample?.at) || sample.at <= priorAt || !Array.isArray(sample.processes)) return null
    priorAt = sample.at
    const ids = new Set()
    const rows = []
    for (const row of sample.processes) {
      if (
        !Number.isInteger(row?.pid) ||
        ids.has(row.pid) ||
        !row.type ||
        !finite(row.workingSetBytes) ||
        row.workingSetBytes < 0 ||
        (row.cumulativeCpuUsage !== undefined &&
          (!finite(row.cumulativeCpuUsage) || row.cumulativeCpuUsage < 0)) ||
        (row.cpuPercent !== undefined && (!finite(row.cpuPercent) || row.cpuPercent < 0))
      )
        return null
      ids.add(row.pid)
      if (select(row)) rows.push(row)
    }
    if (!rows.length) return null
    selected.push(rows)
  }
  let cpuSeconds = 0
  for (let i = 1; i < samples.length; i++) {
    // The measured app is expected to be stable after warmup. A process that
    // disappears between samples may have unobserved CPU and invalidates totals.
    const beforeIds = new Set(selected[i - 1].map((row) => row.pid))
    const afterIds = new Set(selected[i].map((row) => row.pid))
    if (beforeIds.size !== afterIds.size || [...beforeIds].some((pid) => !afterIds.has(pid)))
      return null
    const dt = samples[i].at - samples[i - 1].at
    const before = new Map(selected[i - 1].map((row) => [row.pid, row]))
    for (const row of selected[i]) {
      const old = before.get(row.pid)
      if (old && finite(old.cumulativeCpuUsage) && finite(row.cumulativeCpuUsage)) {
        const delta = row.cumulativeCpuUsage - old.cumulativeCpuUsage
        if (delta < 0) return null
        cpuSeconds += delta
      } else if (finite(row.cpuPercent)) cpuSeconds += (row.cpuPercent / 100) * dt
      else return null
    }
  }
  const memory = selected.map((rows) => rows.reduce((sum, row) => sum + row.workingSetBytes, 0))
  const elapsed = samples.at(-1).at - samples[0].at
  return {
    cpuSeconds,
    sampleElapsedSeconds: elapsed,
    cpuSecondsPerMinute: (cpuSeconds * 60) / elapsed,
    rssSteadyBytes: mean(memory),
    rssPeakBytes: Math.max(...memory),
    processCountPeak: Math.max(...selected.map((rows) => rows.length)),
    pidRows: samples.map((sample, index) => ({ at: sample.at, processes: selected[index] })),
  }
}
