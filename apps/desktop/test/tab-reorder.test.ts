/**
 * Where every pill would sit if you let go now.
 *
 * The strip shows a reorder *while you aim it*: the pills between the tab's own
 * slot and the one under the pointer slide aside, opening the hole it would drop
 * into. That preview is a list of x-offsets, and this is where they are decided
 * — on numbers, because jsdom computes no layout and a rendered strip measures
 * 0×0. The component's only job is to hand them to `translateX`.
 *
 * `to` is the index a drop would insert **before**, in the CURRENT array —
 * `dropIndex`'s convention, unchanged, so the same number drives the preview and
 * the drop itself.
 */
import { describe, expect, test } from 'vitest'
import { reorderOffsets } from '../src/renderer/src/lib/tab-reorder'

/** Three 100px pills with a 10px gap: they sit at 0, 110 and 220. */
const three = [100, 100, 100]
const GAP = 10

describe('reorderOffsets', () => {
  test('a tab dropped where it already is moves nothing', () => {
    expect(reorderOffsets(three, 1, 1, GAP)).toEqual([0, 0, 0])
  })

  test('inserting before the NEXT tab is also where it already is', () => {
    // Remove index 1 and insert before what was index 2, and it lands back in
    // its own slot. The strip must not open a hole for a move that is no move.
    expect(reorderOffsets(three, 1, 2, GAP)).toEqual([0, 0, 0])
  })

  test('dragging the first tab to the end pulls the others left past it', () => {
    // New order 1, 2, 0 — so 0 travels 220 and the two it passed each come back
    // one slot, which is its own width plus the gap.
    expect(reorderOffsets(three, 0, 3, GAP)).toEqual([220, -110, -110])
  })

  test('dragging the last tab to the front pushes the others right', () => {
    expect(reorderOffsets(three, 2, 0, GAP)).toEqual([110, 110, -220])
  })

  test('only the tabs between the two slots move', () => {
    const four = [100, 100, 100, 100]
    // 0 stays put; 1 moves past 2 and they swap.
    expect(reorderOffsets(four, 1, 3, GAP)).toEqual([0, 110, -110, 0])
  })

  test('the offsets are the real widths, not an average', () => {
    // A 40px pill and a 200px pill swap: each moves by the other's width plus
    // the gap, and the two numbers are different.
    expect(reorderOffsets([40, 200], 0, 2, GAP)).toEqual([210, -50])
  })

  test('the preview stays inside the strip the pills already occupy', () => {
    // Nothing may be previewed outside the resting extent, or a drag could push
    // a pill out of the scroll viewport it is being aimed inside. (The offsets
    // do NOT sum to zero — only equal-width pills do that: the dragged pill
    // covers the others' widths while each of them steps back by ITS width.)
    const widths = [80, 120, 60, 140]
    const gap = GAP
    const resting = widths.map((_, i) => widths.slice(0, i).reduce((a, w) => a + w + gap, 0))
    const extent = widths.reduce((a, w) => a + w + gap, 0) - gap

    for (const to of [0, 1, 2, 3, 4]) {
      for (const from of [0, 1, 2, 3]) {
        reorderOffsets(widths, from, to, gap).forEach((offset, i) => {
          expect(resting[i] + offset).toBeGreaterThanOrEqual(0)
          expect(resting[i] + offset + widths[i]).toBeLessThanOrEqual(extent)
        })
      }
    }
  })

  test('an index off the end of the strip moves nothing', () => {
    // A drag that began in another pane has no slot here to move out of.
    expect(reorderOffsets(three, -1, 2, GAP)).toEqual([0, 0, 0])
    expect(reorderOffsets(three, 3, 0, GAP)).toEqual([0, 0, 0])
    expect(reorderOffsets(three, 0, 9, GAP)).toEqual([0, 0, 0])
  })

  test('an empty strip has no offsets', () => {
    expect(reorderOffsets([], 0, 0, GAP)).toEqual([])
  })
})
