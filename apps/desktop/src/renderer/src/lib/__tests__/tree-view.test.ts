import { describe, expect, it } from 'vitest'

import { canMoveInto } from '@/lib/tree-view'

describe('canMoveInto', () => {
  it('refuses a no-op and a folder into itself or below itself', () => {
    expect(canMoveInto(['a/x.md'], 'a')).toBe(false)
    expect(canMoveInto(['a'], 'a')).toBe(false)
    expect(canMoveInto(['a'], 'a/b')).toBe(false)
  })
  it('allows a real move, and a sibling that only shares a prefix', () => {
    expect(canMoveInto(['a/x.md'], 'a/b')).toBe(true)
    expect(canMoveInto(['a/x.md'], '')).toBe(true)
    expect(canMoveInto(['a'], 'ab')).toBe(true)
  })
})
