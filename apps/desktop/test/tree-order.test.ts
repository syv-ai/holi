import { describe, expect, it } from 'vitest'
import { orderChildren, placeAmong } from '../src/renderer/src/lib/tree-order'

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

describe('placeAmong', () => {
  it('moves a sibling before another', () => {
    expect(placeAmong(['a', 'b', 'c'], ['c'], 'a', 'before')).toEqual(['c', 'a', 'b'])
  })
  it('moves a sibling after another', () => {
    expect(placeAmong(['a', 'b', 'c'], ['a'], 'b', 'after')).toEqual(['b', 'a', 'c'])
  })
  it('places arrivals from elsewhere, several at once, keeping their order', () => {
    expect(placeAmong(['a', 'b'], ['x', 'y'], 'b', 'before')).toEqual(['a', 'x', 'y', 'b'])
  })
  it('appends when the target is not among the siblings', () => {
    expect(placeAmong(['a', 'b'], ['x'], 'zz', 'after')).toEqual(['a', 'b', 'x'])
  })
})
