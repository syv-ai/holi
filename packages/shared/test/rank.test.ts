/**
 * Where a dragged card's rank lands (`prd/tasks.md` §Board UX).
 *
 * The property that matters is that a drop writes **one** file: the card takes
 * a rank between its new neighbours and nothing else moves. Dense integers
 * would renumber every card below the drop, which on a shared vault is a
 * conflict per card for one person's tidying.
 */
import { describe, expect, it } from 'vitest'
import { needsRenumber, rankBetween } from '../src/rank'

describe('rankBetween', () => {
  it('lands strictly between its neighbours', () => {
    const rank = rankBetween(1, 2)
    expect(rank).toBeGreaterThan(1)
    expect(rank).toBeLessThan(2)
  })

  it('goes above the top card and below the bottom one', () => {
    // The two ends of a column. Dropping at the top must beat the current
    // first card, and the gap has to stay usable — this is the move a user
    // repeats, so halving the distance to the neighbour every time would run
    // out of room fastest exactly where it is used most.
    expect(rankBetween(null, 4)).toBeLessThan(4)
    expect(rankBetween(6, null)).toBeGreaterThan(6)
  })

  it('starts somewhere a card can be dropped above', () => {
    // An empty column. Starting at 0 would leave nothing between it and a
    // "drop above" that has to produce a smaller number — negative ranks are
    // legal but they read as a bug in a file a human opens.
    expect(rankBetween(null, null)).toBeGreaterThan(0)
  })
})

describe('needsRenumber', () => {
  it('says nothing about a column that has room left', () => {
    expect(needsRenumber([1, 2, 3])).toBe(false)
  })

  it('catches a gap that has been dropped into until it closed', () => {
    // The one real cost of sparse ranks, and it is bounded: dropping into the
    // same gap halves it every time. This is what tells the board to rewrite
    // the column as whole numbers before the halving stops producing a distinct
    // number at all.
    let lo = 1
    const hi = 2
    for (let i = 0; i < 40; i++) lo = rankBetween(lo, hi)
    expect(needsRenumber([lo, hi])).toBe(true)
  })
})
