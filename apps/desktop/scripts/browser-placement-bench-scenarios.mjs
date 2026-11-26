export const scenarios = [
  { name: 'stationary-one-pane', expectedViews: 1, selection: 'baseline', budget: 'standard' },
  { name: 'stationary-two-pane', expectedViews: 2, selection: 'baseline', budget: 'standard' },
  { name: 'hidden-control', expectedViews: 0, selection: 'baseline', budget: 'standard' },
  { name: 'native-resize', expectedViews: 1, selection: 'baseline', budget: 'standard' },
  { name: 'ancestor-scroll', expectedViews: 1, selection: 'baseline', budget: 'standard' },
  { name: 'split-resize', expectedViews: 2, selection: 'baseline', budget: 'standard' },
  { name: 'transform-animation', expectedViews: 1, selection: 'baseline', budget: 'standard' },
  {
    name: 'portal-overlap-entry-movement-exit',
    expectedViews: 0,
    selection: 'baseline',
    budget: 'standard',
  },
  { name: 'portal-nonoverlap', expectedViews: 1, selection: 'baseline', budget: 'standard' },
  { name: 'imperative-web-animation', expectedViews: 1, selection: 'baseline', budget: 'standard' },
  { name: 'hide-return', expectedViews: 1, selection: 'baseline', budget: 'standard' },
]

export const scenarioNames = scenarios.map(({ name }) => name)

export function selectScenario(name) {
  const scenario = scenarios.find((item) => item.name === name)
  if (!scenario) throw new Error(`unknown browser placement scenario: ${name}`)
  return scenario
}
