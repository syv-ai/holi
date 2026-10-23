import { expect, it } from 'vitest'
import { RENDERER_PLUGINS } from './renderer'

// The registry keeps the first surface of a kind it is given, so two plugins
// naming one kind would leave the plugin list's order to choose between them.
it('gives each surface kind to one plugin, so no order in the list decides who has it', () => {
  const kinds = RENDERER_PLUGINS.flatMap((p) => (p.surfaces ?? []).map((s) => s.kind))
  expect(new Set(kinds).size).toBe(kinds.length)
})
