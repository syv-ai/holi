import { describe, expect, it } from 'vitest'
import { APP_METHODS } from '../src/app-bridge'

describe('APP_METHODS', () => {
  it('is exactly slice 1 and no more', () => {
    // Asserted against a literal on purpose: this is the test that goes red
    // when someone adds a method to the shim without adding a handler to the
    // renderer's dispatch, which would otherwise fail only at runtime, in the
    // one process that renders untrusted code.
    expect([...APP_METHODS]).toEqual(['docs.list', 'docs.read', 'tasks.list', 'open'])
  })

  it('carries no state, no write and no theme method', () => {
    // Slice 1's absences are asserted rather than assumed. `holi.data` and every
    // write are deferred (vault-apps.md §State) — an app is genuinely ephemeral,
    // and that thinness is the evidence the deferred decision is waiting on.
    // There is no `theme` getter because the theme is AMBIENT: the tokens are
    // injected as CSS custom properties on serve, so a getter would be a second
    // source for something an app already reads with `var(--primary)`.
    for (const method of APP_METHODS) {
      expect(method.startsWith('data.')).toBe(false)
      expect(method.startsWith('theme')).toBe(false)
      expect(method).not.toBe('docs.write')
      expect(method).not.toBe('tasks.write')
    }
  })
})
