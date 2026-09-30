import { describe, expect, it } from 'vitest'
import { APP_METHODS, RENDERER_METHODS } from '@holi/shared'
import { CAPABILITIES } from '../src/main/apps/capabilities'

describe('the capability registry', () => {
  it('answers every bridge method the renderer does not answer itself, at the app door', () => {
    // The runtime twin of the type check in capabilities.ts: a method the
    // bridge offers with no entry here is a promise an app waits on forever.
    const renderer: readonly string[] = RENDERER_METHODS
    for (const method of APP_METHODS.filter((m) => !renderer.includes(m))) {
      expect(CAPABILITIES[method]?.doors, method).toContain('app')
    }
  })

  it('does not hold what the renderer answers', () => {
    for (const method of RENDERER_METHODS) expect(CAPABILITIES[method]).toBeUndefined()
  })
})
