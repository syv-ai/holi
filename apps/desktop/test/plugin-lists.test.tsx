import { describe, expect, it } from 'vitest'
import { MAIN_PLUGINS } from '../src/plugins/main'
import { RENDERER_PLUGINS } from '../src/plugins/renderer'

describe('the plugin lists', () => {
  it('name the same plugins, with the same info, in both processes', () => {
    expect(RENDERER_PLUGINS.map((p) => p.info)).toEqual(MAIN_PLUGINS.map((p) => p.info))
  })
})
