import { describe, expect, it } from 'vitest'
import { APP_METHODS } from '../src/app-bridge'

describe('APP_METHODS', () => {
  it('is exactly the shipped set and no more', () => {
    // Asserted against a literal on purpose: widening what an untrusted frame
    // can ask for should be a deliberate, reviewed edit here, not a side effect.
    expect([...APP_METHODS]).toEqual([
      'docs.list',
      'docs.read',
      'tasks.list',
      'open',
      'store.get',
      'store.put',
      'store.delete',
      'store.list',
    ])
  })

  it('writes only its own store, and has no theme method', () => {
    // The store is the one write, confined to the app's own `data/` in main.
    // Nothing writes a note or a task. There is no `theme` getter because the theme is AMBIENT: the tokens are
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
