/**
 * A PDF's comments as threads, and the one way Holi writes them down for the
 * agent (D106).
 *
 * Two readers feed this: the open viewer's annotation store, for an ask sent
 * from the PDF viewer, and PDFium in main over the saved file, for
 * `holi pdf comments`. Both hand over plain records, so the thread rules and the
 * layout live here once and a pasted ask reads exactly like the command's output.
 *
 * **The set is the one embedpdf's comments panel lists**
 * (`getSidebarAnnotationsWithRepliesGroupedByPage` in its annotation plugin), so
 * the ask, the command and the panel the person is looking at agree: a mark or
 * a note is a thread, a text note that answers another (`/IRT`) is a reply, and
 * a mark grouped under another (`/RT /Group`) is part of its leader. Links and
 * form fields are not comments.
 */

/** One annotation as a reader found it. Browser-safe: no embedpdf types. */
export interface PdfAnnotationInput {
  /** The annotation's `/NM`. */
  id: string
  /** The PDF annotation subtype, in the numbering embedpdf's enum uses (text
   *  note 1, highlight 9, …). */
  subtype: number
  /** 0-based. */
  pageIndex: number
  /** Top-left origin, the way embedpdf reports it. Used only for ordering. */
  rect: { x: number; y: number; width: number; height: number }
  author?: string
  created?: Date
  modified?: Date
  contents?: string
  inReplyToId?: string
  replyType?: number
  /** The text the mark covers, already resolved by the reader. */
  markedText?: string
}

export type PdfMarkKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'free text'
  | 'ink'
  | 'shape'
  | 'stamp'
  | 'caret'
  | 'redaction'

export interface PdfComment {
  id: string
  author: string | null
  created: Date | null
  modified: Date | null
  /** Possibly empty: a mark with no comment is still feedback. */
  text: string
}

export interface PdfCommentThread extends PdfComment {
  /** 1-based, the way a person says it. */
  page: number
  kind: PdfMarkKind
  markedText: string | null
  replies: PdfComment[]
}

const TEXT = 1
const REPLY_GROUP = 2

/** Every subtype the comments panel lists, by the name the agent reads. */
const KINDS: Record<number, PdfMarkKind> = {
  1: 'note',
  3: 'free text',
  4: 'shape', // line
  5: 'shape', // square
  6: 'shape', // circle
  7: 'shape', // polygon
  8: 'shape', // polyline
  9: 'highlight',
  10: 'underline',
  11: 'squiggly',
  12: 'strikeout',
  13: 'stamp',
  14: 'caret',
  15: 'ink',
  28: 'redaction',
}

/** Highlight, underline, squiggly, strikeout: the marks that cover text. */
export const PDF_TEXT_MARKUP_SUBTYPES: readonly number[] = [9, 10, 11, 12]

const time = (d: Date | undefined): number => d?.getTime() ?? 0

const comment = (a: PdfAnnotationInput): PdfComment => ({
  id: a.id,
  author: a.author !== undefined && a.author.trim() !== '' ? a.author : null,
  created: a.created ?? null,
  modified: a.modified ?? null,
  text: a.contents ?? '',
})

export function commentThreads(annotations: PdfAnnotationInput[]): PdfCommentThread[] {
  const replies = new Map<string, PdfAnnotationInput[]>()
  for (const a of annotations) {
    if (a.subtype !== TEXT || a.inReplyToId === undefined) continue
    const list = replies.get(a.inReplyToId) ?? []
    list.push(a)
    replies.set(a.inReplyToId, list)
  }

  const roots = annotations.filter((a) => {
    const kind = KINDS[a.subtype]
    if (kind === undefined || a.inReplyToId === undefined) return kind !== undefined
    // A text note with an /IRT is a reply; any other mark with one is listed
    // unless it is grouped under its leader, as the panel does.
    return a.subtype !== TEXT && a.replyType !== REPLY_GROUP
  })

  roots.sort(
    (a, b) =>
      a.pageIndex - b.pageIndex ||
      a.rect.y - b.rect.y ||
      a.rect.x - b.rect.x ||
      time(a.created) - time(b.created),
  )

  return roots.map((a) => ({
    ...comment(a),
    page: a.pageIndex + 1,
    kind: KINDS[a.subtype]!,
    markedText: a.markedText !== undefined && a.markedText.trim() !== '' ? a.markedText : null,
    replies: (replies.get(a.id) ?? [])
      .slice()
      .sort((x, y) => time(x.created) - time(y.created))
      .map(comment),
  }))
}

/** `YYYY-MM-DD HH:MM`, in local time unless a zone is given (tests pass UTC). */
function minute(d: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

function byline(c: PdfComment, timeZone: string | undefined): string {
  const who = c.author ?? 'Unknown'
  return c.created === null ? who : `${who}, ${minute(c.created, timeZone)}`
}

/** Every line quoted, blank ones included: a quote with holes in it is a
 *  different comment. */
const quoted = (text: string): string[] =>
  text === '' ? ['  (no comment)'] : text.split(/\r\n|\r|\n/).map((line) => `  > ${line}`.trimEnd())

export function formatCommentThreads(
  path: string,
  threads: PdfCommentThread[],
  opts: { timeZone?: string } = {},
): string {
  if (threads.length === 0) return `No comments in ${path}.`
  const blocks = threads.map((t) => {
    // The marked text sits in quotes on one line, so the PDF's own line breaks
    // (embedpdf keeps them as \r\n) become spaces.
    const on = t.markedText === null ? '' : ` on "${t.markedText.replace(/\s+/g, ' ').trim()}"`
    const lines = [
      `Page ${t.page}, ${t.kind}${on}`,
      `  ${byline(t, opts.timeZone)}`,
      ...quoted(t.text),
    ]
    for (const r of t.replies) lines.push(`  Reply, ${byline(r, opts.timeZone)}`, ...quoted(r.text))
    return lines.join('\n')
  })
  const count = threads.length === 1 ? '1 comment' : `${threads.length} comments`
  return [`[From ${path}, ${count}]`, ...blocks].join('\n\n')
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())

const commentJson = (c: PdfComment) => ({
  id: c.id,
  author: c.author,
  created: iso(c.created),
  modified: iso(c.modified),
  text: c.text,
})

/** The same threads as data, for `holi pdf comments --json`. */
export function commentThreadsJson(path: string, threads: PdfCommentThread[]) {
  return {
    path,
    threads: threads.map((t) => ({
      id: t.id,
      page: t.page,
      kind: t.kind,
      markedText: t.markedText,
      author: t.author,
      created: iso(t.created),
      modified: iso(t.modified),
      text: t.text,
      replies: t.replies.map(commentJson),
    })),
  }
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Which characters a mark covers, as runs of consecutive character indices.
 *
 * For a mark another tool wrote, which stores only its rectangles: a reader
 * passes the page's glyph boxes (PDFium's, one per character index) and the
 * mark's segment rectangles, then reads the text of each run. A glyph counts
 * when its centre lies inside a rectangle, which is what keeps a neighbouring
 * line's ascenders out.
 *
 * A glyph with no size (PDFium's generated spaces and line breaks) has no
 * position to test, so it neither starts a run nor breaks one: two covered
 * words with a generated space between them are one run, space included.
 */
export function glyphRuns(glyphs: Box[], rects: Box[]): { start: number; count: number }[] {
  const runs: { start: number; count: number }[] = []
  /** Where the current run would have to continue from, bridging sizeless glyphs. */
  let next = -1
  glyphs.forEach((g, i) => {
    if (g.width === 0 && g.height === 0) {
      if (next === i) next = i + 1
      return
    }
    const cx = g.x + g.width / 2
    const cy = g.y + g.height / 2
    const inside = rects.some(
      (r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height,
    )
    const last = runs[runs.length - 1]
    if (inside && last !== undefined && next === i) last.count = i - last.start + 1
    else if (inside) runs.push({ start: i, count: 1 })
    next = inside ? i + 1 : -1
  })
  return runs
}
