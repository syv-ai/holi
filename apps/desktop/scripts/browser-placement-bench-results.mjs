const counters = ['callbacks', 'hostRects', 'coverageScans', 'overlayRects']

export function validateTrials(baseline, scenarios, repetitions, countsOnly) {
  if (!Array.isArray(baseline.trials)) throw new Error('baseline is missing trial receipts')
  const selected = new Set(scenarios)
  const expected = new Set(
    scenarios.flatMap((scenario) =>
      Array.from({ length: repetitions }, (_, index) => `${scenario}\0rep-${index + 1}`),
    ),
  )
  const found = new Map()
  for (const trial of baseline.trials) {
    if (!selected.has(trial.scenario)) throw new Error('unexpected scenario receipt')
    const key = `${trial.scenario}\0${trial.trial}`
    if (!expected.has(key)) throw new Error('unexpected trial receipt')
    if (found.has(key)) throw new Error(`duplicate trial receipt: ${trial.scenario}/${trial.trial}`)
    if (trial.valid !== true)
      throw new Error(
        `invalid trial receipt: ${trial.scenario}/${trial.trial}: ${trial.reason ?? 'unknown reason'}`,
      )
    if (
      countsOnly &&
      (!trial.counters ||
        counters.some(
          (name) =>
            !Number.isSafeInteger(trial.counters.totals?.[name]) || trial.counters.totals[name] < 0,
        ))
    )
      throw new Error(`missing terminal counter totals: ${trial.scenario}/${trial.trial}`)
    if (!countsOnly && trial.counters !== null)
      throw new Error(
        `resource trial unexpectedly contains counters: ${trial.scenario}/${trial.trial}`,
      )
    found.set(key, trial)
  }
  for (const key of expected)
    if (!found.has(key)) throw new Error(`missing trial receipt: ${key.replace('\0', '/')}`)
  return found
}

export function terminalCounters(trials, scenario, repetitions) {
  return Object.fromEntries(
    Array.from({ length: repetitions }, (_, index) => {
      const name = `rep-${index + 1}`
      const trial = trials.get(`${scenario}\0${name}`)
      return [
        name,
        Object.fromEntries(counters.map((counter) => [counter, trial.counters.totals[counter]])),
      ]
    }),
  )
}
