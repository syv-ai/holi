import { describe, expect, it } from 'vitest'
import { gridFocusMove, monthGrid } from '../src/calendar'

const flat = (year: number, month: number) => monthGrid(year, month).flat()

describe('monthGrid', () => {
  it('is always six rows of seven, whatever the month needs', () => {
    // February 2027 starts on a Monday and has 28 days — five rows would cover
    // it exactly. June 2026 needs six. Both come back the same size, so the
    // popover does not change height when you page between them.
    for (const [year, month] of [
      [2027, 2],
      [2026, 6],
      [2026, 8],
      [2028, 2],
    ] as const) {
      const grid = monthGrid(year, month)
      expect(grid, `${year}-${month}`).toHaveLength(6)
      for (const week of grid) expect(week).toHaveLength(7)
    }
  })

  it('borrows no leading days when the month starts on a Monday', () => {
    // 2026-06-01 is a Monday.
    const grid = monthGrid(2026, 6)
    expect(grid[0]![0]).toEqual({ date: '2026-06-01', inMonth: true })
  })

  it('borrows six leading days when the month starts on a Sunday, being Monday-first', () => {
    // 2026-02-01 is a Sunday, so the week it sits in opens on 2026-01-26.
    const grid = monthGrid(2026, 2)
    expect(grid[0]![0]).toEqual({ date: '2026-01-26', inMonth: false })
    expect(grid[0]![6]).toEqual({ date: '2026-02-01', inMonth: true })
  })

  it('contains the leap day, in the month', () => {
    expect(flat(2028, 2)).toContainEqual({ date: '2028-02-29', inMonth: true })
    expect(flat(2026, 2).map((d) => d.date)).not.toContain('2026-02-29')
  })

  it('runs one day at a time across both month boundaries', () => {
    const days = flat(2026, 8).map((d) => d.date)
    expect(days).toHaveLength(42)
    for (let i = 1; i < days.length; i++) {
      const prev = Date.parse(`${days[i - 1]}T00:00:00Z`)
      expect(Date.parse(`${days[i]}T00:00:00Z`) - prev, `${days[i - 1]} → ${days[i]}`).toBe(
        86_400_000,
      )
    }
  })

  it('marks exactly the month s own days as inMonth', () => {
    const inMonth = flat(2026, 8).filter((d) => d.inMonth)
    expect(inMonth).toHaveLength(31)
    expect(inMonth[0]!.date).toBe('2026-08-01')
    expect(inMonth.at(-1)!.date).toBe('2026-08-31')
  })

  it('normalises a month outside 1-12 into the neighbouring year', () => {
    // Rather than throwing: the picker pages by incrementing a number, and a
    // December → January step is the one case that would hit it. Normalising is
    // what lets the caller stay arithmetic.
    expect(monthGrid(2026, 13)).toEqual(monthGrid(2027, 1))
    expect(monthGrid(2026, 0)).toEqual(monthGrid(2025, 12))
  })
})

describe('gridFocusMove', () => {
  it('walks a week down, out of the month it started in', () => {
    // The move that makes arrow keys worth having: the grid draws six weeks and
    // the focus has to be able to leave the month, which is what forces the
    // caller to re-page the view.
    expect(gridFocusMove('2026-08-27', 'ArrowDown')).toBe('2026-09-03')
  })

  it('pages a month at a time, clamping to a day that month has', () => {
    // The keyboard's version of the header's chevrons. 31 March has no 31
    // February to land on, and the same clamp the recurrence math uses is the
    // one that keeps this from skipping into the month after.
    expect(gridFocusMove('2026-03-31', 'PageUp')).toBe('2026-02-28')
    expect(gridFocusMove('2026-01-31', 'PageDown')).toBe('2026-02-28')
  })

  it('claims nothing else', () => {
    // A grid that swallowed Tab or Escape would trap the focus inside a popover
    // — the two keys a user needs most when they want out of one.
    for (const key of ['Tab', 'Escape', 'Enter', ' ', 'a']) {
      expect(gridFocusMove('2026-08-27', key)).toBeNull()
    }
  })
})
