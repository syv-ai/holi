const counterNames = ['callbacks', 'hostRects', 'coverageScans', 'overlayRects']

export function createTrialSampling({ condition }) {
  if (!condition || typeof condition !== 'object')
    throw new TypeError('foreground condition is required')
  let previous = null
  let invalidReason = null
  let totals = Object.fromEntries(counterNames.map((name) => [name, 0]))
  let observations = 0
  let finished = false
  const transitions = []

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
    const counters = snapshot?.stats
    if (
      !counters ||
      counterNames.some((name) => !Number.isInteger(counters[name]) || counters[name] < 0)
    )
      invalidReason ??= 'invalid placement counter snapshot'
    else if (previous) {
      for (const name of counterNames) {
        const delta = counters[name] - previous.stats[name]
        if (delta < 0) invalidReason ??= `placement counter ${name} reset during trial`
        else totals[name] += delta
      }
    }
    observations++
    previous = {
      focused: state?.focused,
      visible: state?.visible,
      minimized: state?.minimized,
      stats: counters ? { ...counters } : null,
    }
  }

  function finish(snapshot) {
    if (finished) throw new Error('trial sampling already finished')
    observe(snapshot)
    finished = true
    // First and terminal snapshots both contribute their absolute counters; subsequent
    // snapshots contribute deltas. This captures a short final interval exactly once.
    if (observations === 1 && previous?.stats) {
      for (const name of counterNames) totals[name] = previous.stats[name]
    }
    const valid = invalidReason === null && observations >= 2
    return {
      valid,
      reason: valid ? null : (invalidReason ?? 'insufficient observations'),
      counters: {
        totals: { ...totals },
        observations,
        terminal: previous?.stats ? { ...previous.stats } : null,
        provenance:
          'placement counters are cumulative deltas from trial reset through terminal snapshot',
      },
    }
  }
  return {
    observe,
    finish,
    transition(event) {
      if (!finished) {
        transitions.push(event)
        invalidReason ??= 'foreground condition changed during trial'
      }
    },
  }
}
