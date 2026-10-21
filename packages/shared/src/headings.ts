/**
 * A markdown body's first heading, read and written.
 *
 * This is the title rule. A task's name is the first heading in its body at
 * **any** level, not a `title:` in frontmatter and not the filename, so there
 * is no second field to disagree with it. Nothing here is task-specific.
 *
 * **ATX only** (`# Title`), never setext (`Title` over `=====`): Holi's editor
 * writes only ATX, and setext would need a line of lookahead.
 */

/** Up to three leading spaces is still a heading; the fourth makes it code. */
const ATX = /^ {0,3}(#{1,6})\s+(.*)$/
/** The same indent rule for a fence, which is the thing a `#` can hide inside. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** A closing run of hashes is decoration, not part of the text: `# Title #`. */
const TRAILING_HASHES = /\s+#+\s*$/

/** One ATX heading of a body: its line index, its hashes and its text. */
interface AtxHeading {
  index: number
  hashes: string
  text: string
}

/**
 * Every ATX heading in `lines`, top to bottom, from line `from` on.
 *
 * **Fenced code is skipped**, which is why this is not a one-line regex: a task
 * whose body opens with a shell block would otherwise be called `!/bin/bash`.
 */
function* atxHeadings(lines: readonly string[], from = 0): Generator<AtxHeading> {
  let fence: string | null = null
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!
    const fenced = FENCE.exec(line)
    if (fenced !== null) {
      const marker = fenced[1]![0]!
      // A ``` inside a ~~~ block is content, not a close. Only its own
      // character can end a fence.
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue

    const heading = ATX.exec(line)
    if (heading === null) continue
    yield { index: i, hashes: heading[1]!, text: heading[2]!.replace(TRAILING_HASHES, '').trim() }
  }
}

/** The first heading's text, or `null` when the body has none. */
export function firstHeading(body: string): string | null {
  for (const { text } of atxHeadings(body.split('\n'))) {
    // `#` alone is an empty heading, which names nothing. Keep looking.
    if (text !== '') return text
  }
  return null
}

/**
 * The body with `title` as its first heading.
 *
 * Replaces the existing heading's text when there is one, keeping its level,
 * and prepends an `#` heading when there is not.
 */
export function setFirstHeading(body: string, title: string): string {
  const lines = body.split('\n')
  for (const { index, hashes, text } of atxHeadings(lines)) {
    if (text === '') continue
    lines[index] = `${hashes} ${title}`
    return lines.join('\n')
  }

  const rest = body.trim()
  return rest === '' ? `# ${title}\n` : `# ${title}\n\n${rest}\n`
}

/** Code spans: their contents are literal text, as GitHub renders them. */
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g
/** What GitHub's anchor generator drops: punctuation and symbols except `-`
 *  and `_`, control and format characters, and every separator but a space. */
const NOT_IN_SLUG = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu

/** A heading's inline markdown as the text GitHub renders and slugs: an image
 *  as its alt text, a link as its words, HTML tags and emphasis markers gone. */
function renderedText(text: string): string {
  const parts: string[] = []
  let at = 0
  const inline = (raw: string): string =>
    raw
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<(?:https?:|mailto:)[^>\s]*>/gi, (url) => url.slice(1, -1))
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      // `*` is dropped as punctuation anyway; `_` is kept unless it is emphasis.
      .replace(/(^|[^\p{L}\p{N}\\])(_{1,3})(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}])/gu, '$1$3')
      .replace(/\\([!-/:-@[-`{-~])/g, '$1')
  for (const span of text.matchAll(CODE_SPAN)) {
    parts.push(inline(text.slice(at, span.index)), span[2]!.replace(/^ (.*) $/s, '$1'))
    at = span.index + span[0].length
  }
  parts.push(inline(text.slice(at)))
  return parts.join('')
}

/**
 * A heading's base anchor, as GitHub makes it: the rendered text in lower
 * case, punctuation and symbols dropped, and each space a hyphen (a run of
 * spaces is a run of hyphens). `Next steps (Q3)` is `next-steps-q3`. NFC first,
 * so a letter typed as one code point or as a base and an accent slugs the
 * same. A repeated heading's `-1`, `-2` comes from `headingAnchors`, which
 * sees the whole document.
 */
export function headingSlug(text: string): string {
  return renderedText(text.normalize('NFC').trim())
    .toLowerCase()
    .replace(NOT_IN_SLUG, '')
    .replace(/ /g, '-')
}

/** One heading of a document and the anchor GitHub gives it. */
export interface HeadingAnchor {
  /** 1-based line. */
  line: number
  slug: string
}

/**
 * Every ATX heading in `text` (a whole file, frontmatter and all) with its
 * GitHub anchor, top to bottom. A repeated slug gets `-1`, `-2` in document
 * order, and a suffixed slug is itself taken, as GitHub's slugger does: `A`,
 * `A`, `A-1` are `a`, `a-1`, `a-1-1`. Frontmatter is skipped, since a `# comment`
 * in YAML is not a heading, and so is fenced code.
 */
export function headingAnchors(text: string): HeadingAnchor[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let from = 0
  if (lines[0] === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.startsWith('---'))
    if (close !== -1) from = close + 1
  }
  const seen = new Map<string, number>()
  const anchors: HeadingAnchor[] = []
  for (const { index, text: words } of atxHeadings(lines, from)) {
    const base = headingSlug(words)
    let slug = base
    while (seen.has(slug)) {
      const n = seen.get(base)! + 1
      seen.set(base, n)
      slug = `${base}-${n}`
    }
    seen.set(slug, 0)
    anchors.push({ line: index + 1, slug })
  }
  return anchors
}

/**
 * The 1-based line of the heading in `text` whose GitHub anchor is `heading`,
 * or null. `heading` may also be the heading's own words, which find the first
 * heading with those words.
 */
export function findHeadingLine(text: string, heading: string): number | null {
  const anchors = headingAnchors(text)
  const exact = heading.normalize('NFC').trim()
  const words = headingSlug(heading)
  if (exact === '') return null
  const found =
    anchors.find((anchor) => anchor.slug === exact) ??
    anchors.find((anchor) => words !== '' && anchor.slug === words)
  return found?.line ?? null
}
