import { describe, expect, it } from 'vitest'
import { buildReconcilePrompt } from '../src/renderer/src/lib/reconcile-prompt'

describe('buildReconcilePrompt', () => {
  it('names every conflicted path and how to finish the merge', () => {
    const p = buildReconcilePrompt(['notes/a.md', 'b/c.md'])
    expect(p).toContain('notes/a.md')
    expect(p).toContain('b/c.md')
    expect(p).toContain('<<<<<<<')
    expect(p).toContain('git add')
    expect(p).toContain('git commit')
  })
})
