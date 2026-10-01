import { describe, expect, it } from 'vitest'
import { MAIN_PLUGINS } from './main'
import { RENDERER_PLUGINS } from './renderer'

describe('the plugin lists', () => {
  it('name the same plugins, with the same info, in both processes', () => {
    expect(RENDERER_PLUGINS.map((p) => p.info)).toEqual(MAIN_PLUGINS.map((p) => p.info))
  })
})
