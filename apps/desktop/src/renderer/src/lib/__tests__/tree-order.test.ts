import { describe, expect, it } from 'vitest'
import { orderChildren } from '@/lib/tree-order'

const byName = (a: string, b: string) => a.localeCompare(b)

describe('orderChildren', () => {
  it('falls back to the default order with nothing placed', () => {
    expect(orderChildren(['c', 'a', 'b'], undefined, byName)).toEqual(['a', 'b', 'c'])
  })
  it('puts placed children first in their order, the rest after by default', () => {
    expect(orderChildren(['a', 'b', 'c', 'd'], ['c', 'a'], byName)).toEqual(['c', 'a', 'b', 'd'])
  })
  it('ignores placed paths that are gone', () => {
    expect(orderChildren(['a', 'b'], ['gone', 'b'], byName)).toEqual(['b', 'a'])
  })
})
