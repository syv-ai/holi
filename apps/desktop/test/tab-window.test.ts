/**
 * The tab strip's overflow decision. Widths are given rather than measured, so
 * these are arithmetic and say nothing about fonts.
 */
import { describe, expect, it } from 'vitest'
import { tabWindow, type TabWindowInput } from '../src/renderer/src/lib/tab-window'

/** Six 100px tabs, 4px apart, with a 40px "+N" control. */
const base: TabWindowInput = {
  widths: [100, 100, 100, 100, 100, 100],
  available: 1000,
  active: 0,
  overflowWidth: 40,
  gap: 4,
}

const win = (over: Partial<TabWindowInput>) => tabWindow({ ...base, ...over })

describe('tabWindow', () => {
  it('is empty for an empty pane', () => {
    expect(win({ widths: [], active: -1 })).toEqual({ start: 0, end: 0, hidden: 0 })
  })

  it('shows everything when everything fits', () => {
    // 6*100 + 5*4 = 620.
    expect(win({ available: 620 })).toEqual({ start: 0, end: 6, hidden: 0 })
  })

  it('reserves nothing for a control it will not draw', () => {
    // Exactly 620 of room and a 40px control: if the control were reserved
    // unconditionally, the last tab would be hidden to make space for a button
    // announcing that it is hidden.
    expect(win({ available: 620, overflowWidth: 400 }).hidden).toBe(0)
  })

  it('hides what does not fit, and counts it', () => {
    // 500 of strip − 40 control − 4 gap = 456 of room → four tabs (412), not five.
    expect(win({ available: 500 })).toEqual({ start: 0, end: 4, hidden: 2 })
  })

  it('fills from the left', () => {
    expect(win({ available: 300, active: 0 }).start).toBe(0)
  })

  it('slides right to keep the active tab on screen', () => {
    // Room for two. Active is the last tab, so the window ends on it.
    const w = win({ available: 300, active: 5 })

    expect(w.end).toBe(6)
    expect(w.start).toBe(4)
    expect(w.hidden).toBe(4)
  })

  it('slides no further than it must', () => {
    // Active tab 2 with room for four: the left-anchored run already contains
    // it, so nothing moves.
    expect(win({ available: 500, active: 2 })).toEqual({ start: 0, end: 4, hidden: 2 })
  })

  it('shows the active tab even when it alone overflows', () => {
    // One tab, wider than the strip. Better clipped than absent.
    expect(win({ widths: [900], available: 200, active: 0 })).toEqual({
      start: 0,
      end: 1,
      hidden: 0,
    })
  })

  it('shows one tab when the strip has room for none of them', () => {
    const w = win({ available: 50, active: 3 })

    expect(w.end - w.start).toBe(1)
    expect(w.start).toBe(3)
    expect(w.hidden).toBe(5)
  })

  it('counts tabs hidden on both sides', () => {
    // Active in the middle, room for one: two hidden left, three hidden right.
    const w = win({ available: 150, active: 2 })

    expect(w).toEqual({ start: 2, end: 3, hidden: 5 })
  })

  it('survives an unmeasured tab', () => {
    // A tab that has never been rendered has no width yet; treat it as zero
    // rather than as NaN, which would poison every comparison downstream.
    // 150 − 40 − 4 = 106 of room. Counting the unmeasured tab as zero, the first
    // three fit (100 + 0 + … ) up to the 100px third; counting it as NaN, none
    // would, and the strip would collapse to a single tab for one unpainted pill.
    const w = tabWindow({ ...base, widths: [100, Number.NaN as number, 100], available: 150 })

    expect(w.start).toBe(0)
    expect(w.end).toBe(2)
  })
})
