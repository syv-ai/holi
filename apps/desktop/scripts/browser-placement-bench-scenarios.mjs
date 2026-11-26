const definitions = [
  {
    name: 'stationary-one-pane',
    expectedViews: 1,
    configure: 'window.bench.reset();window.bench.setVisible(true);window.bench.setOverlay(false)',
  },
  {
    name: 'stationary-two-pane',
    expectedViews: 2,
    configure: 'window.bench.reset();window.bench.setTwoPane(true)',
  },
  {
    name: 'hidden-control',
    expectedViews: 0,
    configure: 'window.bench.reset();window.bench.setVisible(false)',
  },
  {
    name: 'native-resize',
    expectedViews: 1,
    configure: 'window.bench.reset();window.bench.startWorkload("native-resize")',
  },
  {
    name: 'ancestor-scroll',
    expectedViews: 1,
    configure: 'window.bench.reset();window.bench.startWorkload("ancestor-scroll")',
  },
  {
    name: 'split-resize',
    expectedViews: 2,
    configure:
      'window.bench.reset();window.bench.setTwoPane(true);window.bench.startWorkload("split-resize")',
  },
  {
    name: 'transform-animation',
    expectedViews: 1,
    configure: 'window.bench.reset();window.bench.setTransform(true);window.bench.setAnimate(true)',
  },
  {
    name: 'portal-overlap-entry-movement-exit',
    expectedViews: 0,
    prepareViews: 1,
    prepare: 'window.bench.reset()',
    configure: 'window.bench.setOverlap(true);window.bench.setOverlay(true)',
  },
  {
    name: 'portal-nonoverlap',
    expectedViews: 1,
    prepareViews: 1,
    prepare: 'window.bench.reset()',
    configure: 'window.bench.setOverlay(true);window.bench.setOverlap(false)',
  },
  {
    name: 'imperative-web-animation',
    expectedViews: 1,
    prepareViews: 1,
    prepare: 'window.bench.reset()',
    configure: 'window.bench.setImperative(true)',
    finish: 'window.bench.setImperative(false)',
  },
  {
    name: 'hide-return',
    expectedViews: 1,
    prepareViews: 0,
    prepare: 'window.bench.reset();window.bench.setVisible(false)',
    configure: 'window.bench.setVisible(true)',
  },
]

export const scenarios = definitions.map((scenario) => ({ ...scenario, setupSeconds: 15 }))
export const scenarioNames = scenarios.map(({ name }) => name)

export function selectScenario(name) {
  const selected = scenarios.find((item) => item.name === name)
  if (!selected) throw new Error(`unknown browser placement scenario: ${name}`)
  return selected
}

export function selectScenarios(name = '') {
  return name ? [selectScenario(name)] : scenarios
}

export function benchmarkTimeoutMs({ seconds, warmup, repetitions, scenario = '' }) {
  return (
    selectScenarios(scenario).reduce((sum, item) => sum + seconds + warmup + item.setupSeconds, 0) *
      repetitions *
      1000 +
    120000
  )
}
