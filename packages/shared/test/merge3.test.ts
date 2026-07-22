import { describe, expect, it } from 'vitest'
import { lineHunks } from '../src/merge3'

describe('lineHunks', () => {
  it('reports nothing for identical input', () => {
    expect(lineHunks(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([])
  })

  it('reports an insertion as a zero-width hunk', () => {
    // start === end is what tells the merge walk "this goes between two base
    // lines" rather than "this replaces one".
    expect(lineHunks(['a', 'c'], ['a', 'b', 'c'])).toEqual([{ start: 1, end: 1, lines: ['b'] }])
  })

  it('reports a deletion as a hunk with no lines', () => {
    expect(lineHunks(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ start: 1, end: 2, lines: [] }])
  })

  it('reports a replacement in place', () => {
    expect(lineHunks(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([
      { start: 1, end: 2, lines: ['B'] },
    ])
  })

  it('reports two separate edits as two hunks', () => {
    // Coalescing these into one hunk spanning the middle would make every
    // top-and-bottom edit conflict with everything.
    const base = ['a', 'b', 'c', 'd', 'e']
    expect(lineHunks(base, ['A', 'b', 'c', 'd', 'E'])).toEqual([
      { start: 0, end: 1, lines: ['A'] },
      { start: 4, end: 5, lines: ['E'] },
    ])
  })

  it('handles an empty base', () => {
    expect(lineHunks([], ['a', 'b'])).toEqual([{ start: 0, end: 0, lines: ['a', 'b'] }])
  })

  it('handles an empty other', () => {
    expect(lineHunks(['a', 'b'], [])).toEqual([{ start: 0, end: 2, lines: [] }])
  })

  it('returns ordered, non-overlapping hunks', () => {
    // The merge walk consumes base left to right and relies on both.
    const base = ['1', '2', '3', '4', '5', '6', '7', '8']
    const other = ['1', 'x', '3', '4', '5', 'y', 'z', '7', '8']
    const hunks = lineHunks(base, other)!

    let cursor = -1
    for (const h of hunks) {
      expect(h.start).toBeGreaterThanOrEqual(cursor)
      expect(h.end).toBeGreaterThanOrEqual(h.start)
      cursor = h.end
    }
    expect(hunks.length).toBeGreaterThan(1)
  })

  it('applies its own hunks back onto base to reproduce other', () => {
    // The property that matters, stated once instead of asserted shape by
    // shape: hunks are a complete description of the edit.
    const cases: [string[], string[]][] = [
      [['a', 'b', 'c'], ['a', 'B', 'c']],
      [['a', 'b', 'c'], ['c', 'b', 'a']],
      [[], ['x']],
      [['x'], []],
      [['a', 'a', 'a'], ['a', 'a', 'a', 'a']],
      [['# Title', '', 'Body.'], ['# Title', '', 'Intro.', '', 'Body.']],
    ]

    for (const [base, other] of cases) {
      const hunks = lineHunks(base, other)!
      const out: string[] = []
      let cursor = 0
      for (const h of hunks) {
        out.push(...base.slice(cursor, h.start), ...h.lines)
        cursor = h.end
      }
      out.push(...base.slice(cursor))
      expect(out).toEqual(other)
    }
  })
})
