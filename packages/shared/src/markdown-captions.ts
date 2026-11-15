/**
 * Portable framing for an optional Markdown element caption. The reader only
 * owns the envelope: callers decide which body Markdown is a supported element
 * and which inline Markdown is an editable caption.
 */
import { fencedBlocks } from './fences'

export interface CaptionRange {
  /** Exact JavaScript string offsets; end is exclusive. */
  from: number
  to: number
}

export interface MarkdownCaptionEnvelope {
  envelope: CaptionRange
  body: CaptionRange
  caption: CaptionRange
}

/** A caption envelope whose body is exactly one supported fenced code block. */
export interface MarkdownCodeCaption {
  envelope: CaptionRange
  body: CaptionRange
  caption: CaptionRange
  language: string
}

/**
 * Select only envelopes that can be rendered as one code element and one inline
 * paragraph. Unsupported structures remain opaque source text for their caller.
 */
export function readMarkdownCodeCaptions(text: string): MarkdownCodeCaption[] {
  return readMarkdownCaptionEnvelopes(text).flatMap((frame) => {
    const body = text.slice(frame.body.from, frame.body.to)
    const [block] = fencedBlocks(body)
    // The element is exactly one fence, not an opening and closing fence
    // surrounding arbitrary prose or additional blocks. `fencedBlocks` owns
    // CommonMark's fence and indentation semantics.
    if (!block || block.from !== 0 || block.to !== body.length) return []
    const caption = text.slice(frame.caption.from, frame.caption.to)
    if (!isPortableInlineCaption(caption)) return []
    return [{ ...frame, language: block.lang }]
  })
}

/** Only accept one paragraph of portable inline Markdown, never raw HTML. */
export function isPortableInlineCaption(caption: string): boolean {
  if (!caption.trim() || /[\r\n\u2028\u2029]/.test(caption)) return false
  if (/^[ \t]/.test(caption) && !/^(?:&#32;|&#9;)+/.test(caption)) return false
  // Reference definitions and reference links depend on document-wide definitions;
  // extracting them would change their meaning in the surrounding document.
  const plain = caption.replace(/(`+)(.*?)\1/g, '').replace(/\\([\\[\\]<>!])/g, '')
  if (/!\s*\[/.test(plain)) return false
  if (/^ {0,3}\[[^\]]+\]:/.test(plain)) return false
  if (/\[[^\]]+\](?:\[[^\]]*\])?(?!\s*\()/.test(plain)) return false
  // Reject angle brackets only when they are not protected by inline code.
  if (/[<>]/.test(plain)) return false
  // CommonMark block openers, including empty headings and thematic breaks.
  if (
    /^ {0,3}(?:#{1,6}(?:\s|$)|>|(?:[-*_][ \t]*){3,}[ \t]*$|(?:[-*+]|\d+[.)])(?:[ \t]+|$)|(?:`{3,}|~{3,}))/i.test(
      caption,
    )
  )
    return false
  return true
}

const FIGURE = '<!-- holi:figure -->'
const CAPTION = '<!-- holi:caption -->'
const END = '<!-- /holi:figure -->'
const MARKERS = new Set([FIGURE, CAPTION, END])
const BLOCK_TAGS =
  /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|template|textarea|tfoot|th|thead|title|tr|track|ul|script|style|pre)$/i
const RAW_TAGS = new Set(['script', 'style', 'pre', 'textarea'])

interface Line {
  text: string
  from: number
  to: number
  next: number
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let from = 0
  while (from < text.length) {
    const lf = text.indexOf('\n', from)
    const next = lf === -1 ? text.length : lf + 1
    let to = lf === -1 ? text.length : lf
    if (to > from && text[to - 1] === '\r') to--
    lines.push({ text: text.slice(from, to), from, to, next })
    from = next
  }
  if (text.length === 0 || text.endsWith('\n'))
    lines.push({ text: '', from: text.length, to: text.length, next: text.length })
  return lines
}

function protectedLines(lines: Line[]): boolean[] {
  const ignored = lines.map(() => false)
  let fence: { char: string; length: number; container: string } | null = null
  let htmlTerminator: string | null = null
  let htmlBlock = false
  let frontmatter = lines[0]?.text === '---'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.text
    if (frontmatter) {
      ignored[i] = true
      if (i > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false
      continue
    }
    if (htmlTerminator !== null) {
      ignored[i] = true
      if (
        htmlTerminator === '-->' ? line.includes('-->') : new RegExp(htmlTerminator, 'i').test(line)
      )
        htmlTerminator = null
      continue
    }
    if (htmlBlock) {
      if (line.trim() === '') {
        htmlBlock = false
        continue
      }
      ignored[i] = true
      continue
    }

    const list = /^( {0,3}(?:[-+*]|\d+[.)])\s+)(.*)$/s.exec(line)
    const container = list?.[1] ?? ''
    const content = list?.[2] ?? line
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/s.exec(content)
    if (fence?.container && !list && line.trim() !== '' && !/^ {2,}/.test(line)) {
      fence = null
    }
    if (fence !== null) {
      ignored[i] = true
      const inContainer = fence.container ? list?.[1] === fence.container : !list
      const candidate = list ? content : line
      const close = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \t]*$`)
      const continuationClose = new RegExp(`^ {2,}${fence.char}{${fence.length},}[ \t]*$`)
      if (
        (inContainer && close.test(candidate)) ||
        (fence.container && continuationClose.test(line))
      )
        fence = null
      continue
    }
    if (fenceMatch && !(fenceMatch[2]![0] === '`' && fenceMatch[3]!.includes('`'))) {
      ignored[i] = true
      fence = { char: fenceMatch[2]![0]!, length: fenceMatch[2]!.length, container }
      continue
    }
    if (/^(?: {4}|\t)/.test(line) || /^(?: {0,3}>| {0,3}(?:[-+*]|\d+[.)])\s)/.test(line)) {
      ignored[i] = true
      continue
    }

    const html = line.replace(/^ {0,3}/, '')
    if (/^<!--/.test(html) && !MARKERS.has(html)) {
      ignored[i] = true
      if (!html.includes('-->')) htmlTerminator = '-->'
      continue
    }
    if (/^<\?/.test(html)) {
      ignored[i] = true
      if (!html.includes('?>')) htmlTerminator = '\\?>'
      continue
    }
    if (/^<!\[CDATA\[/i.test(html)) {
      ignored[i] = true
      if (!html.includes(']]>')) htmlTerminator = '\\]\\]>'
      continue
    }
    if (/^<![A-Z]/.test(html)) {
      ignored[i] = true
      if (!html.includes('>')) htmlTerminator = '>'
      continue
    }

    const tag = tagLine(html)
    if (tag) {
      const { name } = tag
      if (RAW_TAGS.has(name)) {
        ignored[i] = true
        if (!new RegExp(`</${name}\\s*>`, 'i').test(html)) htmlTerminator = `</${name}\\s*>`
        continue
      }
      const trailing = html.slice(html.lastIndexOf('>') + 1)
      const completeLine = tag.complete && !/[<>]/.test(trailing) && !trailing.trim()
      if (
        BLOCK_TAGS.test(name) &&
        tag.startsTag &&
        (completeLine ||
          tag.afterName === html.length ||
          /^(?:\s|\/?>)/.test(html.slice(tag.afterName)))
      ) {
        ignored[i] = true
        htmlBlock = true
        continue
      }
      if (completeLine) {
        ignored[i] = true
        htmlBlock = true
      }
    }
  }
  return ignored
}

function standalone(line: string): string | null {
  if (line !== line.trim()) return null
  return MARKERS.has(line) ? line : null
}

function tagLine(
  line: string,
): { name: string; startsTag: boolean; complete: boolean; afterName: number } | null {
  let cursor = 0
  if (line[cursor] !== '<') return null
  cursor++
  if (line[cursor] === '/') cursor++
  const nameStart = cursor
  if (!/[A-Za-z]/.test(line[cursor] ?? '')) return null
  cursor++
  while (/[A-Za-z0-9:-]/.test(line[cursor] ?? '')) cursor++
  const name = line.slice(nameStart, cursor).toLowerCase()
  const startsTag =
    cursor === line.length ||
    line[cursor] === ' ' ||
    line[cursor] === '\t' ||
    line[cursor] === '/' ||
    line[cursor] === '>'
  if (!startsTag) return null
  while (cursor < line.length && line[cursor] !== '>') {
    if (line[cursor] === '<')
      return { name, startsTag, complete: false, afterName: nameStart + name.length }
    cursor++
  }
  return { name, startsTag, complete: cursor < line.length, afterName: nameStart + name.length }
}

/**
 * Find unambiguous, standalone top-level envelopes. Invalid candidates are
 * skipped rather than claiming later text; scanning resumes at the next line.
 * Body/caption ranges exclude the required blank-line separators and marker
 * lines. Fences, frontmatter, raw HTML, indented code and list/quote lines are
 * opaque. This deliberately conservative lexical protection is not a Markdown
 * parser; unsupported nested constructs remain ordinary source.
 */
export function readMarkdownCaptionEnvelopes(text: string): MarkdownCaptionEnvelope[] {
  const lines = linesOf(text)
  const ignored = protectedLines(lines)
  const marker = lines.map((line, index) => (ignored[index] ? null : standalone(line.text)))
  const nextMarker = new Array<number>(lines.length + 1).fill(-1)
  const nextBoundary = new Array<number>(lines.length + 1).fill(-1)
  const nextCaption = new Array<number>(lines.length + 1).fill(-1)
  const nextEnd = new Array<number>(lines.length + 1).fill(-1)
  for (let index = lines.length - 1; index >= 0; index--) {
    nextMarker[index] = marker[index] ? index : nextMarker[index + 1]!
    nextBoundary[index] =
      marker[index] === FIGURE || marker[index] === END ? index : nextBoundary[index + 1]!
    nextCaption[index] = marker[index] === CAPTION ? index : nextCaption[index + 1]!
    nextEnd[index] = marker[index] === END ? index : nextEnd[index + 1]!
  }
  const nestedRanges: Array<{ from: number; to: number }> = []
  const openFigures: Array<{ index: number; nested: boolean }> = []
  for (let index = 0; index < marker.length; index++) {
    if (marker[index] === FIGURE) {
      if (openFigures.length > 0) openFigures[openFigures.length - 1]!.nested = true
      openFigures.push({ index, nested: false })
    } else if (marker[index] === END && openFigures.length > 0) {
      const opened = openFigures.pop()!
      if (opened.nested) nestedRanges.push({ from: opened.index, to: index })
    }
  }
  nestedRanges.sort((left, right) => left.from - right.from)
  const mergedNestedRanges: Array<{ from: number; to: number }> = []
  for (const range of nestedRanges) {
    const previous = mergedNestedRanges.at(-1)
    if (previous && range.from <= previous.to + 1) previous.to = Math.max(previous.to, range.to)
    else mergedNestedRanges.push({ ...range })
  }
  const result: MarkdownCaptionEnvelope[] = []
  let nestedRangeIndex = 0
  for (let i = 0; i < lines.length; i++) {
    while (
      nestedRangeIndex < mergedNestedRanges.length &&
      mergedNestedRanges[nestedRangeIndex]!.to < i
    )
      nestedRangeIndex++
    const nestedRange = mergedNestedRanges[nestedRangeIndex]
    if (nestedRange && nestedRange.from <= i) {
      i = nestedRange.to
      continue
    }
    if (marker[i] !== FIGURE) continue
    if (lines[i + 1]?.text !== '') continue
    const cap = nextMarker[i + 2]!
    if (cap === -1 || marker[cap] !== CAPTION || lines[cap - 1]?.text !== '') continue
    const captionStart = cap + 2
    if (lines[cap + 1]?.text !== '') continue
    const end = nextMarker[captionStart]!
    if (end === -1 || marker[end] !== END || end === captionStart) continue
    if (lines[end - 1]!.text !== '' || end - captionStart < 2) continue
    const bodyStart = i + 2
    const bodyEnd = cap - 1
    const bodyLast = bodyEnd - 1
    const captionLast = end - 2
    if (bodyLast < bodyStart || captionLast < captionStart) continue
    const bodyFrom = lines[bodyStart]!.from
    const bodyTo = lines[bodyLast]!.to
    const captionFrom = lines[captionStart]!.from
    const captionTo = lines[captionLast]!.to
    if (!text.slice(bodyFrom, bodyTo).trim() || !text.slice(captionFrom, captionTo).trim()) continue
    result.push({
      envelope: { from: lines[i]!.from, to: lines[end]!.to },
      body: { from: bodyFrom, to: bodyTo },
      caption: { from: captionFrom, to: captionTo },
    })
    i = end
  }
  return result
}

/** Serialize one opaque body and one inline caption using canonical framing. */
export function writeMarkdownCaptionEnvelope(body: string, caption: string): string {
  if (/^(?: {4}| {0,3}\t)/.test(caption))
    throw new Error('caption must be one inline Markdown paragraph')
  const portableCaption = caption.replace(/^[ \t]+/, (leading) =>
    [...leading].map((char) => (char === '\t' ? '&#9;' : '&#32;')).join(''),
  )
  if (!body.trim() || !caption.trim())
    throw new Error('caption envelope body and caption must not be empty')
  if (
    body.startsWith('\n') ||
    body.endsWith('\n') ||
    portableCaption.includes('\n') ||
    portableCaption.includes('\r')
  ) {
    throw new Error('caption envelope content must not have framing or multiline whitespace')
  }
  // Canonical output uses LF. CRLF input remains readable, but the writer does
  // not normalize body text because its source range must preserve exact input.
  if (body.includes('\r') || portableCaption.includes('\r'))
    throw new Error('caption envelope content must use LF line endings')
  if (
    /^(?: {4}| {0,3}\t)/.test(portableCaption) ||
    /^(?: {0,3}(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|`{3,}|~{3,}|<)| {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$)/.test(
      portableCaption,
    )
  ) {
    throw new Error('caption must be one inline Markdown paragraph')
  }
  const serialized = `${FIGURE}\n\n${body}\n\n${CAPTION}\n\n${portableCaption}\n\n${END}`
  const [frame] = readMarkdownCaptionEnvelopes(serialized)
  if (
    !frame ||
    serialized.slice(frame.body.from, frame.body.to) !== body ||
    serialized.slice(frame.caption.from, frame.caption.to) !== portableCaption
  ) {
    throw new Error('caption envelope content must round-trip without swallowing its framing')
  }
  return serialized
}
