/**
 * Portable framing for an optional Markdown element caption. The reader only
 * owns the envelope: callers decide which body Markdown is a supported element
 * and which inline Markdown is an editable caption.
 */

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

    const list = /^( {0,3}(?:[-+*]|\d+[.)])\s+)(.*)$/.exec(line)
    const container = list?.[1] ?? ''
    const content = list?.[2] ?? line
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(content)
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

    const html = /^ {0,3}(.*)$/.exec(line)![1]!
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

    const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)\b/i.exec(html)
    if (tag) {
      const name = tag[1]!.toLowerCase()
      if (RAW_TAGS.has(name)) {
        ignored[i] = true
        if (!new RegExp(`</${name}\\s*>`, 'i').test(html)) htmlTerminator = `</${name}\\s*>`
        continue
      }
      if (
        BLOCK_TAGS.test(name) &&
        /^<\/?[A-Za-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>(?:[ \t]*)$/.test(html)
      ) {
        ignored[i] = true
        htmlBlock = true
        continue
      }
      if (BLOCK_TAGS.test(name) && /^<\/?[A-Za-z][\w:-]*(?:\s|\/?\s*>)/.test(html)) {
        ignored[i] = true
        htmlBlock = true
        continue
      }
      if (/^<\/?[A-Za-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>(?:[ \t]*)$/.test(html)) {
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
  const result: MarkdownCaptionEnvelope[] = []
  for (let i = 0; i < lines.length; i++) {
    if (ignored[i] || standalone(lines[i]!.text) !== FIGURE) continue
    // A nested opener after a caption makes a completed outer frame ambiguous.
    // An opener before the caption is malformed framing, so recovery continues
    // there instead of letting it consume otherwise independent frames.
    const nextMarker = lines.findIndex(
      (line, index) =>
        index > i && !ignored[index] && [FIGURE, END].includes(standalone(line.text) ?? ''),
    )
    const outerCaption = lines.findIndex(
      (line, index) =>
        index > i && index < nextMarker && !ignored[index] && standalone(line.text) === CAPTION,
    )
    if (
      nextMarker !== -1 &&
      standalone(lines[nextMarker]!.text) === FIGURE &&
      outerCaption !== -1
    ) {
      const innerEnd = lines.findIndex(
        (line, index) => index > nextMarker && !ignored[index] && standalone(line.text) === END,
      )
      const outerEnd =
        innerEnd === -1
          ? -1
          : lines.findIndex(
              (line, index) => index > innerEnd && !ignored[index] && standalone(line.text) === END,
            )
      if (outerEnd !== -1) {
        i = outerEnd
        continue
      }
    }
    if (lines[i + 1]?.text !== '') continue
    let cap = i + 2
    while (cap < lines.length && (ignored[cap] || standalone(lines[cap]!.text) !== CAPTION)) {
      if (
        !ignored[cap] &&
        (standalone(lines[cap]!.text) === FIGURE || standalone(lines[cap]!.text) === END)
      )
        break
      cap++
    }
    if (
      standalone(lines[cap]?.text ?? '') !== CAPTION ||
      ignored[cap] ||
      lines[cap - 1]!.text !== ''
    )
      continue
    const captionStart = cap + 2
    if (lines[cap + 1]?.text !== '') continue
    let end = captionStart
    while (end < lines.length && (standalone(lines[end]!.text) !== END || ignored[end])) {
      if (standalone(lines[end]!.text) === FIGURE || standalone(lines[end]!.text) === CAPTION) break
      end++
    }
    if (
      end >= lines.length ||
      end === captionStart ||
      standalone(lines[end]!.text) !== END ||
      ignored[end]
    )
      continue
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
  if (!body.trim() || !caption.trim())
    throw new Error('caption envelope body and caption must not be empty')
  if (
    body.startsWith('\n') ||
    body.endsWith('\n') ||
    caption.includes('\n') ||
    caption.includes('\r')
  ) {
    throw new Error('caption envelope content must not have framing or multiline whitespace')
  }
  // Canonical output uses LF. CRLF input remains readable, but the writer does
  // not normalize body text because its source range must preserve exact input.
  if (body.includes('\r') || caption.includes('\r'))
    throw new Error('caption envelope content must use LF line endings')
  if (
    /^(?: {4}|\t)/.test(caption) ||
    /^(?: {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|<)| {0,3}(?:---+|\*\*\*+|___+))/.test(
      caption,
    )
  ) {
    throw new Error('caption must be one inline Markdown paragraph')
  }
  const serialized = `${FIGURE}\n\n${body}\n\n${CAPTION}\n\n${caption}\n\n${END}`
  const [frame] = readMarkdownCaptionEnvelopes(serialized)
  if (
    !frame ||
    serialized.slice(frame.body.from, frame.body.to) !== body ||
    serialized.slice(frame.caption.from, frame.caption.to) !== caption
  ) {
    throw new Error('caption envelope content must round-trip without swallowing its framing')
  }
  return serialized
}
