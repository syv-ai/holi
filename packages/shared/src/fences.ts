/**
 * Fenced code blocks in a markdown body: what language a fence says it holds,
 * and where each fence starts and ends.
 *
 * The editor finds fences through its own syntax tree; this is the same rule
 * for code that has only the text (the PDF export, which turns a mermaid
 * fence into a diagram before Typst sees the note).
 */

/**
 * The fence's language token: the first word of the info string, lowercased.
 * Handles ` ```js title="a.js" `, ` ```python {1,3} `, ` ```{r setup} ` and
 * ` ```.ts `.
 */
export function fenceLanguageId(info: string): string {
  return (
    info
      .trim()
      .split(/[\s,{}]+/)
      .find((w) => w !== '') ?? ''
  )
    .replace(/^\./, '')
    .toLowerCase()
}

/** A closed fenced code block. Offsets are into the text it was read from. */
export interface FencedBlock {
  /** Start of the opening fence line. */
  from: number
  /** End of the closing fence line, before its line break. */
  to: number
  /** The 1-based line of the opening fence. */
  line: number
  /** The language token (`fenceLanguageId`). */
  lang: string
  /** The lines between the fences, without the opening fence's indent. */
  body: string
}

/** Up to three spaces of indent, then three or more of one fence character. */
const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/

/**
 * Every closed fenced code block in `text`, in order, by the CommonMark rule:
 * a fence closes on a line of the same character, at least as long, with
 * nothing after it. A backtick fence's info string cannot hold a backtick.
 * A fence that never closes runs to the end of the text in CommonMark; it is
 * left out here, as the editor leaves a fence still being typed as source.
 * Fences inside a blockquote or a deeper-indented list item are not seen.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = []
  const lines = text.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }

  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(stripCr(lines[i]!))
    if (open === null) continue
    const [, indent, marker, info] = open as unknown as [string, string, string, string]
    if (marker[0] === '`' && info.includes('`')) continue
    const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
    let j = i + 1
    while (j < lines.length && !close.test(stripCr(lines[j]!))) j++
    if (j >= lines.length) break // unclosed: the rest of the text is its body
    const unindent = new RegExp(`^ {0,${indent.length}}`)
    blocks.push({
      from: starts[i]!,
      to: starts[j]! + lines[j]!.length,
      line: i + 1,
      lang: fenceLanguageId(info),
      body: lines
        .slice(i + 1, j)
        .map((l) => stripCr(l).replace(unindent, ''))
        .join('\n'),
    })
    i = j
  }
  return blocks
}

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)
