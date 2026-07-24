import { describe, expect, it } from 'vitest'
import {
  formatWikiLink,
  parseWikiLinks,
  rewriteWikiLinks,
  rewriteWikiLinksMulti,
} from '../src/wiki-links'

describe('parseWikiLinks', () => {
  it('parses a single note link with positions', () => {
    const text = 'see [[notes/a.md]] for details'
    expect(parseWikiLinks(text)).toEqual([
      {
        raw: '[[notes/a.md]]',
        kind: 'note',
        target: 'notes/a.md',
        label: undefined,
        start: 4,
        end: 18,
      },
    ])
  })

  it('splits an optional |Label off the target, trimming both', () => {
    const [link] = parseWikiLinks('[[ projects/q2/roadmap.md | The Roadmap ]]')
    expect(link).toMatchObject({
      kind: 'note',
      target: 'projects/q2/roadmap.md',
      label: 'The Roadmap',
    })
  })

  it('classifies [[task:<id>]] as a task chip carrying the bare id', () => {
    const [chip] = parseWikiLinks('do [[task:0192-abc]] first')
    expect(chip).toMatchObject({ kind: 'task', target: '0192-abc', label: undefined })
  })

  it('conforms to the old grammar: multiple links, no newline crossing, greedy lone [, empty bodies skipped', () => {
    expect(parseWikiLinks('[[a.md]] then [[b.md]]').map((l) => l.target)).toEqual(['a.md', 'b.md'])
    expect(parseWikiLinks('[[a\nb.md]]')).toEqual([]) // bodies never span lines
    expect(parseWikiLinks('[[ ]] [[task: ]]')).toEqual([]) // blank bodies/ids resolve to nothing
    // greedy body keeps a lone '[' inside the token (old editor behaviour):
    expect(parseWikiLinks('[[x [y.md]]')[0]).toMatchObject({ raw: '[[x [y.md]]', target: 'x [y.md' })
  })
})

describe('formatWikiLink', () => {
  it('builds tokens that round-trip through the parser, with and without label', () => {
    expect(formatWikiLink('notes/a.md')).toBe('[[notes/a.md]]')
    expect(formatWikiLink('notes/a.md', 'Alpha')).toBe('[[notes/a.md|Alpha]]')
    expect(parseWikiLinks(formatWikiLink('notes/a.md', 'Alpha'))[0]).toMatchObject({
      kind: 'note',
      target: 'notes/a.md',
      label: 'Alpha',
    })
  })
})

describe('rewriteWikiLinks (the D12 rename primitive)', () => {
  it('rewrites only links targeting the old path, preserving labels and everything else', () => {
    const text = 'see [[old/a.md]] and [[old/a.md|Alpha]] but not [[other.md]] or [[task:x1]]'
    const { text: out, count } = rewriteWikiLinks(text, 'old/a.md', 'new/b.md')
    expect(out).toBe('see [[new/b.md]] and [[new/b.md|Alpha]] but not [[other.md]] or [[task:x1]]')
    expect(count).toBe(2)
  })

  it('is a no-op (count 0, identical text) when nothing matches', () => {
    const text = 'plain prose [[some/where.md]]'
    expect(rewriteWikiLinks(text, 'missing.md', 'x.md')).toEqual({ text, count: 0 })
  })

  it('matches targets ignoring the body whitespace the parser also ignores', () => {
    const { text: out, count } = rewriteWikiLinks('[[ old/a.md | L ]]', 'old/a.md', 'new/b.md')
    expect(out).toBe('[[new/b.md|L]]')
    expect(count).toBe(1)
  })
})

describe('rewriteWikiLinksMulti', () => {
  it('rewrites each targeted link once, from the ORIGINAL map (no chaining)', () => {
    // a→b and b→c in the SAME batch: the [[a.md]] link must become [[b.md]],
    // NOT be chained on to [[c.md]]. This is the property N sequential renames
    // cannot hold — the whole reason move is one pass over a full map.
    const map = new Map([
      ['a.md', 'b.md'],
      ['b.md', 'c.md'],
    ])
    const { text, count } = rewriteWikiLinksMulti('see [[a.md]] and [[b.md|Old]]', map)
    expect(text).toBe('see [[b.md]] and [[c.md|Old]]')
    expect(count).toBe(2)
  })

  it('leaves untargeted links and task chips alone, and returns the input unchanged at count 0', () => {
    const map = new Map([['a.md', 'z.md']])
    expect(rewriteWikiLinksMulti('[[keep.md]] and [[task:t1]]', map)).toEqual({
      text: '[[keep.md]] and [[task:t1]]',
      count: 0,
    })
  })
})
