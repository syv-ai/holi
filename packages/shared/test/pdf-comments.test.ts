import { describe, expect, it } from 'vitest'
import {
  commentThreads,
  commentThreadsJson,
  formatCommentThreads,
  glyphRuns,
  pdfAskHeader,
  type PdfAnnotationInput,
} from '../src/pdf-comments'

const HIGHLIGHT = 9
const TEXT = 1
const LINK = 2
const SQUARE = 5
const STAMP = 13

let n = 0
function ann(over: Partial<PdfAnnotationInput>): PdfAnnotationInput {
  n += 1
  return {
    id: `a${n}`,
    subtype: TEXT,
    pageIndex: 0,
    rect: { x: 10, y: 10, width: 20, height: 20 },
    ...over,
  }
}

const at = (iso: string): Date => new Date(iso)

describe('commentThreads', () => {
  it('orders threads by page, then down the page, then across it', () => {
    const threads = commentThreads([
      ann({ id: 'p2', pageIndex: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }),
      ann({ id: 'low', rect: { x: 0, y: 500, width: 1, height: 1 } }),
      ann({ id: 'right', rect: { x: 300, y: 100, width: 1, height: 1 } }),
      ann({ id: 'left', rect: { x: 50, y: 100, width: 1, height: 1 } }),
    ])
    expect(threads.map((t) => t.id)).toEqual(['left', 'right', 'low', 'p2'])
    expect(threads.map((t) => t.page)).toEqual([1, 1, 1, 2])
  })

  it('breaks a tie in position by creation time', () => {
    const threads = commentThreads([
      ann({ id: 'later', created: at('2026-09-22T12:00:00Z') }),
      ann({ id: 'earlier', created: at('2026-09-22T11:00:00Z') }),
    ])
    expect(threads.map((t) => t.id)).toEqual(['earlier', 'later'])
  })

  it('nests replies under their mark, oldest first, and does not list them as threads', () => {
    const threads = commentThreads([
      ann({ id: 'root', subtype: HIGHLIGHT, contents: 'Should be 30 days.' }),
      ann({
        id: 'r2',
        inReplyToId: 'root',
        contents: 'Done.',
        created: at('2026-09-22T16:00:00Z'),
      }),
      ann({
        id: 'r1',
        inReplyToId: 'root',
        contents: 'Agreed.',
        created: at('2026-09-22T15:00:00Z'),
      }),
    ])
    expect(threads).toHaveLength(1)
    expect(threads[0]!.replies.map((r) => r.text)).toEqual(['Agreed.', 'Done.'])
  })

  it('keeps a highlight with no comment, because a mark can be feedback on its own', () => {
    const [thread] = commentThreads([ann({ subtype: HIGHLIGHT, markedText: 'x' })])
    expect(thread!.kind).toBe('highlight')
    expect(thread!.text).toBe('')
  })

  it('folds a grouped mark into its leader rather than listing it', () => {
    const threads = commentThreads([
      ann({ id: 'leader', subtype: SQUARE }),
      ann({ id: 'member', subtype: SQUARE, inReplyToId: 'leader', replyType: 2 }),
    ])
    expect(threads.map((t) => t.id)).toEqual(['leader'])
  })

  it('gives a replacement the words it replaces, from the struck mark grouped under it', () => {
    const [thread, ...rest] = commentThreads([
      ann({ id: 'caret', subtype: 14, contents: '30 days' }),
      ann({ id: 'struck', subtype: 12, inReplyToId: 'caret', replyType: 2, markedText: '60 days' }),
    ])
    expect(rest).toEqual([])
    expect(thread).toMatchObject({ kind: 'caret', markedText: '60 days', text: '30 days' })
  })

  it('leaves out links and anything else the comments panel does not list', () => {
    const threads = commentThreads([ann({ subtype: LINK }), ann({ subtype: 20 })])
    expect(threads).toEqual([])
  })

  it('names the kind of mark, and calls every drawn outline a shape', () => {
    const kinds = commentThreads([
      ann({ subtype: TEXT }),
      ann({ subtype: SQUARE }),
      ann({ subtype: 4 }),
      ann({ subtype: STAMP }),
      ann({ subtype: 12 }),
    ]).map((t) => t.kind)
    expect(kinds.sort()).toEqual(['note', 'shape', 'shape', 'stamp', 'strikeout'])
  })
})

describe('formatCommentThreads', () => {
  const opts = { timeZone: 'UTC' }

  it('lays threads out the way the ask and the command both show them', () => {
    const threads = commentThreads([
      ann({
        id: 'h',
        subtype: HIGHLIGHT,
        pageIndex: 3,
        markedText: 'payment within\r\n60 days',
        author: 'Ada Holm',
        created: at('2026-09-22T14:10:00Z'),
        contents: 'Should be 30 days, per our terms.',
      }),
      ann({
        inReplyToId: 'h',
        pageIndex: 3,
        author: 'Bo Lind',
        created: at('2026-09-22T15:02:00Z'),
        contents: 'Agreed.',
      }),
      ann({
        pageIndex: 6,
        author: 'Bo Lind',
        created: at('2026-09-23T09:41:00Z'),
        contents: 'Is this clause standard?',
      }),
    ])
    expect(formatCommentThreads('contracts/acme-msa.pdf', threads, opts)).toBe(
      [
        '[From contracts/acme-msa.pdf, 2 comments]',
        '',
        'Page 4, highlight on "payment within 60 days"',
        '  Ada Holm, 2026-09-22 14:10',
        '  > Should be 30 days, per our terms.',
        '  Reply, Bo Lind, 2026-09-22 15:02',
        '  > Agreed.',
        '',
        'Page 7, note',
        '  Bo Lind, 2026-09-23 09:41',
        '  > Is this clause standard?',
      ].join('\n'),
    )
  })

  it('quotes a multi-line comment line by line, and says when there is none', () => {
    const threads = commentThreads([
      ann({ id: 'a', contents: 'One.\n\nTwo.', created: at('2026-09-22T10:00:00Z') }),
      ann({ id: 'b', subtype: HIGHLIGHT, created: at('2026-09-22T11:00:00Z') }),
    ])
    expect(formatCommentThreads('x.pdf', threads, opts)).toBe(
      [
        '[From x.pdf, 2 comments]',
        '',
        'Page 1, note',
        '  Unknown, 2026-09-22 10:00',
        '  > One.',
        '  >',
        '  > Two.',
        '',
        'Page 1, highlight',
        '  Unknown, 2026-09-22 11:00',
        '  (no comment)',
      ].join('\n'),
    )
  })

  it('says "1 comment" for one, and leaves out a date it does not have', () => {
    const threads = commentThreads([ann({ author: 'Ada Holm', contents: 'Hi.' })])
    expect(formatCommentThreads('x.pdf', threads, opts)).toBe(
      ['[From x.pdf, 1 comment]', '', 'Page 1, note', '  Ada Holm', '  > Hi.'].join('\n'),
    )
  })

  it('says so when there are no comments', () => {
    expect(formatCommentThreads('a b.pdf', [], opts)).toBe('No comments in a b.pdf.')
  })
})

describe('commentThreadsJson', () => {
  it('gives the same threads as data, with ids and ISO timestamps', () => {
    const threads = commentThreads([
      ann({
        id: 'h',
        subtype: HIGHLIGHT,
        markedText: 'net 60',
        author: 'Ada Holm',
        created: at('2026-09-22T14:10:00Z'),
        contents: 'Why?',
      }),
      ann({ id: 'r', inReplyToId: 'h', author: 'Bo Lind', contents: 'Legacy.' }),
    ])
    expect(commentThreadsJson('x.pdf', threads)).toEqual({
      path: 'x.pdf',
      threads: [
        {
          id: 'h',
          page: 1,
          kind: 'highlight',
          markedText: 'net 60',
          author: 'Ada Holm',
          created: '2026-09-22T14:10:00.000Z',
          modified: null,
          text: 'Why?',
          replies: [{ id: 'r', author: 'Bo Lind', created: null, modified: null, text: 'Legacy.' }],
        },
      ],
    })
  })
})

describe('glyphRuns', () => {
  const box = (x: number, y: number) => ({ x, y, width: 4, height: 10 })

  it('takes the characters whose centre lies under a rect, as runs of consecutive indices', () => {
    // Two lines of five characters; the mark covers the tail of the first and
    // the head of the second.
    const glyphs = [0, 1, 2, 3, 4].map((i) => box(i * 5, 0))
    glyphs.push(...[0, 1, 2, 3, 4].map((i) => box(i * 5, 20)))
    const rects = [
      { x: 10, y: 0, width: 15, height: 10 },
      { x: 0, y: 20, width: 9, height: 10 },
    ]
    expect(glyphRuns(glyphs, rects)).toEqual([{ start: 2, count: 5 }])
  })

  it('carries a run across a sizeless generated space', () => {
    const glyphs = [box(0, 0), { x: 0, y: 0, width: 0, height: 0 }, box(10, 0)]
    expect(glyphRuns(glyphs, [{ x: 0, y: 0, width: 20, height: 10 }])).toEqual([
      { start: 0, count: 3 },
    ])
  })

  it('splits where the covered characters are not consecutive', () => {
    const glyphs = [0, 1, 2, 3].map((i) => box(i * 5, 0))
    expect(
      glyphRuns(glyphs, [
        { x: 0, y: 0, width: 4, height: 10 },
        { x: 15, y: 0, width: 4, height: 10 },
      ]),
    ).toEqual([
      { start: 0, count: 1 },
      { start: 3, count: 1 },
    ])
  })
})

describe('pdfAskHeader', () => {
  it('names the PDF, and when it has comments, how many and how to read them', () => {
    expect(pdfAskHeader('docs/msa.pdf', 0)).toBe('[From docs/msa.pdf]')
    expect(pdfAskHeader('docs/msa.pdf', 1)).toBe(
      '[From docs/msa.pdf, 1 comment: holi pdf comments docs/msa.pdf]',
    )
    expect(pdfAskHeader('docs/msa.pdf', 3)).toBe(
      '[From docs/msa.pdf, 3 comments: holi pdf comments docs/msa.pdf]',
    )
  })

  it('quotes a path the shell would split', () => {
    expect(pdfAskHeader("client docs/Bo's msa.pdf", 2)).toBe(
      "[From client docs/Bo's msa.pdf, 2 comments: holi pdf comments 'client docs/Bo'\\''s msa.pdf']",
    )
  })
})
