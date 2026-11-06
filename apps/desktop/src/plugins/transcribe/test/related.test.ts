/**
 * Related lines for Send: BM25 over ~20 s windows of consecutive lines,
 * lowercased, Danish stopwords out, words cut to five characters; the top
 * five with any match, outside the lines the task already has.
 */
import { describe, expect, it } from 'vitest'
import type { Segment } from '../shared/meeting'
import { relatedWindows } from '../main/related'

/** A line every 5 s, so four lines make a 20 s window. */
function meeting(texts: string[]): Segment[] {
  return texts.map((text, i) => ({
    i,
    speaker: 'Me',
    start: i * 5,
    end: i * 5 + 4,
    text,
    chunk: 0,
  }))
}

const filler = 'vi snakker lige om vejret og frokosten'

describe('related windows', () => {
  it('rank the window that shares the query’s words first, as one stretch of lines', () => {
    const segs = meeting([
      filler,
      filler,
      filler,
      filler,
      'kan vi eksportere boardet til CSV',
      'ja økonomi vil have eksporten',
      filler,
      filler,
      filler,
      'budgettet for piloten',
      filler,
      filler,
    ])
    const found = relatedWindows(segs, 'CSV eksport')
    expect(found[0]).toMatchObject({ lines: [4, 5, 6, 7], start: 20, end: 39 })
    expect(found[0]!.text).toContain('eksportere boardet til CSV')
    // Only windows that match at all.
    expect(found).toHaveLength(1)
    expect(found[0]!.score).toBeGreaterThan(0)
  })

  it('match words by their first five letters, and ignore stopwords and fillers', () => {
    const segs = meeting(['planlægningen af lokalplanerne', filler, filler, filler, filler])
    // "lokalplan" and "lokalplanerne" share "lokal".
    expect(relatedWindows(segs, 'lokalplan')).toHaveLength(1)
    // Only stopwords and fillers: nothing to look for.
    expect(relatedWindows(segs, 'og det er jo øh altså')).toEqual([])
    expect(relatedWindows(segs, '')).toEqual([])
  })

  it('leave out the excluded lines, and cut windows where lines stop being consecutive', () => {
    const segs = meeting(Array.from({ length: 8 }, (_v, i) => `eksport ${i}`))
    const found = relatedWindows(segs, 'eksport', new Set([2, 3]))
    expect(found.map((w) => w.lines)).toEqual([
      [4, 5, 6, 7],
      [0, 1],
    ])
    expect(found.flatMap((w) => w.lines)).not.toContain(2)
  })

  it('give at most five, best first', () => {
    const segs = meeting(Array.from({ length: 40 }, (_v, i) => (i % 4 === 0 ? 'eksport' : filler)))
    const found = relatedWindows(segs, 'eksport')
    expect(found).toHaveLength(5)
    const scores = found.map((w) => w.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('find nothing when nothing matches', () => {
    expect(relatedWindows(meeting([filler, filler]), 'kubernetes')).toEqual([])
    expect(relatedWindows([], 'eksport')).toEqual([])
  })
})
