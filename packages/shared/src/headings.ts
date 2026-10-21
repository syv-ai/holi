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

/**
 * A heading's anchor, as GitHub makes it: lower case, punctuation dropped,
 * spaces as hyphens. `Next steps (Q3)` is `next-steps-q3`. What a Holi link to
 * a heading carries, so the link reads like the heading it points at.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * The 1-based line of the first heading in `text` (a whole file, frontmatter
 * and all) whose slug is `heading`'s, or null. `heading` may be the slug or the
 * heading's own words. A frontmatter block is skipped: a `# comment` in YAML is
 * not a heading. Two headings with the same words: the first wins.
 */
export function findHeadingLine(text: string, heading: string): number | null {
  const want = headingSlug(heading)
  if (want === '') return null
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let from = 0
  if (lines[0] === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.startsWith('---'))
    if (close !== -1) from = close + 1
  }
  for (const { index, text: words } of atxHeadings(lines, from)) {
    if (words !== '' && headingSlug(words) === want) return index + 1
  }
  return null
}
