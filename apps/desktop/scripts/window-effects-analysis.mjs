function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Evaluate the declared five-pair gate; missing evidence never establishes a benefit. */
export function compareWindowEffects(pairs, tolerances, pilotEffect) {
  const outcomes = pairs.map(({ outcomes }) => {
    const { A, B } = outcomes
    const a = A.steady.physicalFootprint.median
    const b = B.steady.physicalFootprint.median
    const saving = Number.isFinite(a) && Number.isFinite(b) ? a - b : null
    const fraction = saving !== null && a > 0 ? saving / a : null
    const dimensions = (state) => JSON.stringify([state.bounds, state.display, state.zoom])
    const valid =
      A.valid &&
      B.valid &&
      A.effect === pilotEffect &&
      pilotEffect === 'liquid-glass' &&
      B.effect === 'opaque' &&
      a > 0 &&
      b > 0 &&
      dimensions(A.ready.state) === dimensions(B.ready.state)
    const metrics = ['cpuPercent', 'gpuPercent', 'wsCpuPercent']
    const available = metrics.every(
      (key) =>
        Number.isFinite(tolerances[key]) &&
        tolerances[key] >= 0 &&
        Number.isFinite(A.steady[key].median) &&
        Number.isFinite(B.steady[key].median),
    )
    const regression =
      available &&
      metrics.some((key) => B.steady[key].median - A.steady[key].median > tolerances[key])
    return { saving, fraction, valid, available, regression }
  })
  const valid = outcomes.length === 5 && outcomes.every((x) => x.valid && x.available)
  const pairedMedianSaving = median(outcomes.map((x) => x.saving))
  const pairedMedianFraction = median(outcomes.map((x) => x.fraction))
  const crossesPrimaryGate =
    valid &&
    pairedMedianSaving >= 64 * 1024 * 1024 &&
    pairedMedianFraction >= 0.15 &&
    outcomes.filter((x) => x.saving >= 64 * 1024 * 1024 && x.fraction >= 0.15).length >= 4 &&
    !outcomes.some((x) => x.regression)
  return {
    valid,
    pairedMedianSaving,
    pairedMedianFraction,
    crossesPrimaryGate,
    pairs: outcomes,
    status: valid
      ? 'comparison complete; production decision requires methodology/accessibility review and counter limitations'
      : 'inconclusive; invalid or missing measurements',
  }
}
