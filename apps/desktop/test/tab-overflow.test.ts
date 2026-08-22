/**
 * Which tabs are off which edge of a scrolling strip.
 *
 * The strip no longer clips a *window* of tabs (`tab-window.ts`, deleted): every
 * pill is laid out and a viewport moves over them. What replaced the decision
 * "which tabs survive the clip" is this one — "which tabs are currently out of
 * reach, and on which side" — because a single count cannot say which way your
 * tab went. Pure, and checked on numbers, for the reason the whole `lib/` split
 * exists: jsdom computes no layout, so a rendered strip measures 0×0.
 */
import { describe, expect, test } from 'vitest'
import { offscreenTabs, type PillSpan } from '../src/renderer/src/lib/tab-overflow'

/** Five 60px pills, laid out end to end with no gap: 0, 60, 120, 180, 240. */
const pills: PillSpan[] = Array.from({ length: 5 }, (_, i) => ({ left: i * 60, width: 60 }))

describe('offscreenTabs', () => {
  test('nothing is offscreen when the viewport holds everything', () => {
    expect(offscreenTabs(pills, 0, 300)).toEqual({ left: [], right: [] })
  })

  test('what does not fit is off the RIGHT while the strip is at rest', () => {
    // 120px shows pills 0 and 1 exactly; 2, 3 and 4 are past the edge.
    expect(offscreenTabs(pills, 0, 120)).toEqual({ left: [], right: [2, 3, 4] })
  })

  test('scrolling moves tabs onto the LEFT list, which is the whole point', () => {
    // A single count cannot say which way your tab went.
    expect(offscreenTabs(pills, 120, 120)).toEqual({ left: [0, 1], right: [4] })
  })

  test('a partly visible pill counts as offscreen — you cannot read half a name', () => {
    // Viewport [30, 150): pill 0 is clipped on the left, pill 2 on the right,
    // and only pill 1 (60–120) is whole.
    expect(offscreenTabs(pills, 30, 120)).toEqual({ left: [0], right: [2, 3, 4] })
  })

  test('a pill clipped on both edges is reported on the side it starts past', () => {
    // One pill wider than the viewport: you scroll left to bring its start back.
    expect(offscreenTabs([{ left: 0, width: 400 }], 50, 100)).toEqual({ left: [0], right: [] })
  })

  test('subpixel layout does not invent an offscreen tab', () => {
    // Real widths are fractional; a pill ending 0.4px past the edge is visible.
    expect(offscreenTabs([{ left: 0, width: 100.4 }], 0, 100)).toEqual({ left: [], right: [] })
  })

  test('an unmeasured strip announces nothing', () => {
    // Before the first ResizeObserver callback the viewport is 0, and every pill
    // would score as "off the right" — a strip that flashes a count on mount.
    expect(offscreenTabs(pills, 0, 0)).toEqual({ left: [], right: [] })
  })

  test('an empty strip has no sides', () => {
    expect(offscreenTabs([], 0, 200)).toEqual({ left: [], right: [] })
  })
})
