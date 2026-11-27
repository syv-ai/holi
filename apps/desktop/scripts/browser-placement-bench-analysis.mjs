export function oneCorePercent(rawMachinePercent, logicalCpuCount) {
  if (
    !Number.isFinite(rawMachinePercent) ||
    !Number.isInteger(logicalCpuCount) ||
    logicalCpuCount < 1
  ) {
    throw new TypeError('CPU percent and logical CPU count must be valid')
  }
  return rawMachinePercent * logicalCpuCount
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function dispersion(values) {
  const center = median(values)
  return {
    median: center,
    mad: center === null ? null : median(values.map((value) => Math.abs(value - center))),
  }
}

export function assertPlacementCounters(stats) {
  if (!stats || stats.callbacks !== stats.hostRects)
    throw new Error('placement callback and host rect counts must match exactly')
  for (const name of ['coverageScans', 'overlayRects']) {
    if (!Number.isInteger(stats[name]) || stats[name] < 0)
      throw new Error(`invalid ${name} counter`)
  }
  // Zero overlay reads are valid; a single scan can inspect several overlay elements.
}

export function cpuFor(appMetrics, predicate) {
  return appMetrics
    .filter(predicate)
    .reduce((sum, process) => sum + (process.cpu?.oneCorePercentCPUUsage ?? 0), 0)
}

export function pageProcessIds(pages) {
  return [...new Set(pages.map((page) => page.pid).filter((pid) => Number.isInteger(pid)))]
}
