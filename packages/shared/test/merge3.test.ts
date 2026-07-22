import { describe, expect, it } from 'vitest'
import { lineHunks, merge3 } from '../src/merge3'

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

const T = (...lines: string[]) => lines.join('\n')

/** Unwraps a merge that must have been clean, so a failure names the case. */
function merged(base: string, mine: string, theirs: string): string {
  const result = merge3(base, mine, theirs)
  if (result.kind !== 'merged') {
    throw new Error(`expected a clean merge, got conflict: ${JSON.stringify(result.regions)}`)
  }
  return result.text
}

describe('merge3 — clean', () => {
  const BASE = T('one', 'two', 'three', 'four', 'five')

  it('returns theirs when only theirs changed', () => {
    // The clean-buffer reload, arrived at by the general path rather than a
    // special case the caller has to remember.
    const theirs = T('one', 'TWO', 'three', 'four', 'five')
    expect(merged(BASE, BASE, theirs)).toBe(theirs)
  })

  it('returns mine when only mine changed', () => {
    const mine = T('one', 'TWO', 'three', 'four', 'five')
    expect(merged(BASE, mine, BASE)).toBe(mine)
  })

  it('returns base when neither changed', () => {
    expect(merged(BASE, BASE, BASE)).toBe(BASE)
  })

  it('merges edits to different regions', () => {
    // The case prd/notes-editor.md says to write a test against first: a pull
    // landing on the open note while you type.
    const mine = T('ONE', 'two', 'three', 'four', 'five')
    const theirs = T('one', 'two', 'three', 'four', 'FIVE')
    expect(merged(BASE, mine, theirs)).toBe(T('ONE', 'two', 'three', 'four', 'FIVE'))
  })

  it('merges when both sides made the identical change', () => {
    // Common: you save, and the same content arrives from a pull. A banner
    // here would sit on a file that is already right.
    const same = T('one', 'TWO', 'three', 'four', 'five')
    expect(merged(BASE, same, same)).toBe(same)
  })

  it('merges an insertion from each side at different positions', () => {
    const mine = T('one', 'inserted', 'two', 'three', 'four', 'five')
    const theirs = T('one', 'two', 'three', 'four', 'appended', 'five')
    expect(merged(BASE, mine, theirs)).toBe(
      T('one', 'inserted', 'two', 'three', 'four', 'appended', 'five'),
    )
  })

  it('merges adjacent but non-overlapping edits', () => {
    // THE documented divergence from git, which conflicts this case because
    // its merge needs an unchanged line between two hunks. Someone typing at
    // line 3 while the agent edits line 4 should not get a banner.
    const mine = T('one', 'two', 'THREE', 'four', 'five')
    const theirs = T('one', 'two', 'three', 'FOUR', 'five')
    expect(merged(BASE, mine, theirs)).toBe(T('one', 'two', 'THREE', 'FOUR', 'five'))
  })

  it('preserves a trailing newline', () => {
    // Dropping it makes git show a diff on a line nobody touched.
    const base = 'a\nb\n'
    expect(merged(base, 'A\nb\n', 'a\nB\n')).toBe('A\nB\n')
  })

  it('preserves the absence of a trailing newline', () => {
    expect(merged('a\nb', 'A\nb', 'a\nB')).toBe('A\nB')
  })

  it('handles an empty base', () => {
    expect(merged('', '', 'hello')).toBe('hello')
  })

  it('handles both sides deleting the same region', () => {
    const mine = T('one', 'four', 'five')
    expect(merged(BASE, mine, mine)).toBe(mine)
  })

  it('merges a deletion on one side with an edit elsewhere', () => {
    const mine = T('one', 'four', 'five')
    const theirs = T('one', 'two', 'three', 'four', 'FIVE')
    expect(merged(BASE, mine, theirs)).toBe(T('one', 'four', 'FIVE'))
  })
})

/** Unwraps a merge that must have conflicted, so a failure names the case. */
function conflicted(base: string, mine: string, theirs: string) {
  const result = merge3(base, mine, theirs)
  if (result.kind !== 'conflict') {
    throw new Error(`expected a conflict, got a clean merge: ${JSON.stringify(result.text)}`)
  }
  return result.regions
}

describe('merge3 — conflict', () => {
  const BASE = T('one', 'two', 'three', 'four', 'five')

  it('conflicts when both sides changed the same line', () => {
    const result = merge3(BASE, T('one', 'MINE', 'three', 'four', 'five'), T('one', 'THEIRS', 'three', 'four', 'five'))

    expect(result.kind).toBe('conflict')
    // No text, at all. The caller must not be able to write a resolved buffer
    // over the user's, and the absence of the field is what guarantees it.
    expect(result).not.toHaveProperty('text')
  })

  it('conflicts when the changed ranges overlap partially', () => {
    const regions = conflicted(
      BASE,
      T('one', 'MINE', 'MINE', 'four', 'five'),
      T('one', 'two', 'THEIRS', 'THEIRS', 'five'),
    )
    expect(regions).toHaveLength(1)
  })

  it('conflicts on two different insertions at the same position', () => {
    // Both are zero-width in base, so the range test says no — but there is no
    // defensible order to put them in, and inventing one interleaves two
    // people's text. Git calls this add/add and so do we.
    const regions = conflicted(
      BASE,
      T('one', 'two', 'MINE', 'three', 'four', 'five'),
      T('one', 'two', 'THEIRS', 'three', 'four', 'five'),
    )
    expect(regions).toHaveLength(1)
    expect(regions[0]!.mine.lines).toEqual(['MINE'])
    expect(regions[0]!.theirs.lines).toEqual(['THEIRS'])
  })

  it('does NOT conflict when both sides insert the same thing at the same position', () => {
    const same = T('one', 'two', 'BOTH', 'three', 'four', 'five')
    expect(merged(BASE, same, same)).toBe(same)
  })

  it('reports the base, mine and theirs slices', () => {
    const regions = conflicted(
      BASE,
      T('one', 'MINE', 'three', 'four', 'five'),
      T('one', 'THEIRS', 'three', 'four', 'five'),
    )

    expect(regions).toHaveLength(1)
    expect(regions[0]!.base.lines).toEqual(['two'])
    expect(regions[0]!.mine.lines).toEqual(['MINE'])
    expect(regions[0]!.theirs.lines).toEqual(['THEIRS'])
  })

  it("reports offsets into each side's own lines", () => {
    // Built so the three offsets genuinely differ: mine gains two lines above
    // the conflict, theirs loses one. A test where they coincide would pass
    // for the wrong reason.
    const base = T('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
    const mine = T('a', 'X', 'Y', 'b', 'c', 'd', 'e', 'f', 'g', 'MINE')
    const theirs = T('a', 'c', 'd', 'e', 'f', 'g', 'THEIRS')

    const [region] = conflicted(base, mine, theirs)
    expect(region!.base.start).toBe(7)
    expect(region!.mine.start).toBe(9)
    expect(region!.theirs.start).toBe(6)

    // And the offsets actually point at the right line in each array.
    expect(mine.split('\n')[region!.mine.start]).toBe('MINE')
    expect(theirs.split('\n')[region!.theirs.start]).toBe('THEIRS')
  })

  it('reports every conflicting region, not just the first', () => {
    const base = T('a', 'b', 'c', 'd', 'e', 'f', 'g')
    const regions = conflicted(
      base,
      T('MINE1', 'b', 'c', 'd', 'e', 'f', 'MINE2'),
      T('THEIRS1', 'b', 'c', 'd', 'e', 'f', 'THEIRS2'),
    )
    expect(regions).toHaveLength(2)
    expect(regions[0]!.mine.lines).toEqual(['MINE1'])
    expect(regions[1]!.mine.lines).toEqual(['MINE2'])
  })

  it('reports only the genuine overlap when the rest merged cleanly', () => {
    // One mergeable edit and one overlap. The document is a conflict overall,
    // but the report must not name the region that was never in dispute — it
    // is what the reconcile prompt is built from.
    const base = T('a', 'b', 'c', 'd', 'e')
    const regions = conflicted(
      base,
      T('MINE', 'b', 'c', 'OURS', 'e'),
      T('a', 'b', 'c', 'THEIRS', 'e'),
    )

    expect(regions).toHaveLength(1)
    expect(regions[0]!.base.lines).toEqual(['d'])
    expect(regions[0]!.mine.lines).toEqual(['OURS'])
    // 'MINE' was never in dispute and must not appear in the report.
    expect(JSON.stringify(regions)).not.toContain('MINE')
  })

  it('conflicts when one side deletes a region the other edited', () => {
    // delete/modify. A naive overlap test misses it because one hunk has no
    // lines to compare.
    const regions = conflicted(
      BASE,
      T('one', 'four', 'five'),
      T('one', 'two', 'THEIRS', 'four', 'five'),
    )
    expect(regions).toHaveLength(1)
    expect(regions[0]!.mine.lines).toEqual([])
    expect(regions[0]!.theirs.lines).toEqual(['two', 'THEIRS'])
  })

  it('conflicts the whole document when the line alphabet overflows', () => {
    const many = Array.from({ length: 70_000 }, (_, i) => `line ${i}`)
    const base = many.join('\n')

    const regions = conflicted(base, `${base}\nmine`, `${base}\ntheirs`)
    expect(regions).toHaveLength(1)
    expect(regions[0]!.base.lines).toHaveLength(70_000)
  })
})
