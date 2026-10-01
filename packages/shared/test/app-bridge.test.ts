import { describe, expect, it } from 'vitest'
import { APP_METHODS, isAppTopic, storeTopic } from '../src/app-bridge'

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
      'vault.recents',
      'docs.render',
      'docs.search',
      'vault.settings',
      'vault.members',
      'vault.history',
      'sync.status',
      'agent.sessions',
      'google.agenda',
      'google.search',
      'tasks.complete',
    ])
  })

  it('writes only its own store and completes tasks, and has no theme method', () => {
    // The store is the one general write, confined to the app's own `data/` in
    // main. `tasks.complete` is the one other: it applies the board's rule, so a
    // recurring task rolls forward. Nothing writes a note or a task's text. There is no `theme` getter because the theme is AMBIENT: the tokens are
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

describe('topics', () => {
  it('accepts the fixed topics and a store topic per collection', () => {
    expect(isAppTopic('docs')).toBe(true)
    expect(isAppTopic(storeTopic('items'))).toBe(true)
    expect(isAppTopic('store:')).toBe(false)
    expect(isAppTopic('store:../x')).toBe(false)
    expect(isAppTopic('mail')).toBe(false)
  })
})
