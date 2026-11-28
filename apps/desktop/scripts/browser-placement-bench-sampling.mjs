const counterNames = ['callbacks', 'hostRects', 'coverageScans', 'overlayRects']

export function createTrialSampling({ condition, counters = true }) {
  if (
    !condition ||
    condition.focused !== true ||
    condition.visible !== true ||
    condition.minimized !== false
  )
    throw new TypeError('foreground condition is required')
  condition = { ...condition }
  let previous = null
  let invalidReason = null
  let totals = Object.fromEntries(counterNames.map((name) => [name, 0]))
  let observations = 0
  let finished = false

  function observe(snapshot) {
    if (finished) throw new Error('trial sampling already finished')
    const state = snapshot?.condition
    if (
      !state ||
      state.focused !== condition.focused ||
      state.visible !== condition.visible ||
      state.minimized !== condition.minimized
    )
      invalidReason ??= 'foreground condition mismatch'
    if (!state?.focused || !state?.visible || state?.minimized)
      invalidReason ??= 'window is not foreground and visible'
    if (
      previous &&
      (previous.focused !== state?.focused ||
        previous.visible !== state?.visible ||
        previous.minimized !== state?.minimized)
    )
      invalidReason ??= 'foreground condition changed during trial'
    const epoch = snapshot?.visibilityEpoch
    if (!Number.isSafeInteger(epoch) || epoch < 0)
      invalidReason ??= 'missing document visibility epoch'
    else if (previous && epoch !== previous.visibilityEpoch)
      invalidReason ??= 'document visibility changed during trial'
    const stats = counters ? snapshot?.stats : null
    if (
      counters &&
      (!stats || counterNames.some((name) => !Number.isInteger(stats[name]) || stats[name] < 0))
    )
      invalidReason ??= 'invalid placement counter snapshot'
    else if (counters && !previous) totals = { ...stats }
    else if (
      counters &&
      previous?.stats &&
      counterNames.every(
        (name) => Number.isInteger(previous.stats[name]) && previous.stats[name] >= 0,
      )
    ) {
      for (const name of counterNames) {
        const delta = stats[name] - previous.stats[name]
        if (delta < 0) invalidReason ??= `placement counter ${name} reset during trial`
        else totals[name] += delta
      }
    }
    observations++
    previous = {
      visibilityEpoch: epoch,
      focused: state?.focused,
      visible: state?.visible,
      minimized: state?.minimized,
      stats: stats ? { ...stats } : null,
    }
  }

  function finish(snapshot) {
    if (finished) throw new Error('trial sampling already finished')
    observe(snapshot)
    finished = true
    const valid = invalidReason === null && observations >= 2
    return {
      valid,
      reason: valid ? null : (invalidReason ?? 'insufficient observations'),
      counters: counters
        ? {
            totals: { ...totals },
            observations,
            terminal: previous?.stats ? { ...previous.stats } : null,
            provenance:
              'placement counters are cumulative deltas from trial reset through terminal snapshot',
          }
        : null,
    }
  }
  return {
    observe,
    finish,
    transition(event) {
      if (!finished) {
        invalidReason ??= 'foreground condition changed during trial'
      }
    },
  }
}
