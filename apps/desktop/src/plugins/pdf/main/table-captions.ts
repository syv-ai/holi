import { GFM, parser } from '@lezer/markdown'
import {
  isPortableInlineCaption,
  parseWikiLinks,
  readMarkdownCaptionEnvelopes,
  splitFrontmatter,
} from '@holi/shared'

const markdownParser = parser.configure(GFM)
const UNSUPPORTED = new Set([
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'Autolink',
  'FootnoteReference',
  'FootnoteDefinition',
])

export interface MarkdownTableCaption {
  envelope: { from: number; to: number }
  body: { from: number; to: number }
  caption: { from: number; to: number }
}

/** Full-document definitions as parsed by CommonMark, excluding code and HTML.
 * Rebuild from syntax fields rather than copying container source: a definition
 * can span blockquote/list lines whose markers are not part of its value. */
export function readMarkdownReferenceDefinitions(markdown: string): string {
  const body = splitFrontmatter(markdown).body
  const tree = markdownParser.parse(body)
  const definitions: { from: number; to: number; text: string }[] = []
  const excluded: { from: number; to: number }[] = []
  const quoteMarks: { from: number; to: number }[] = []
  tree.iterate({
    enter(node) {
      if (node.name === 'QuoteMark') quoteMarks.push({ from: node.from, to: node.to })
      if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag'].includes(node.name)) {
        excluded.push({ from: node.from, to: node.to })
      }
    },
  })
  const fieldText = (field: { from: number; to: number }, collapseSpace = true): string => {
    let text = ''
    let at = field.from
    for (const mark of quoteMarks) {
      if (mark.from < at || mark.to > field.to) continue
      text += body.slice(at, mark.from)
      at = mark.to
    }
    text += body.slice(at, field.to)
    // CommonMark folds ASCII whitespace in labels. Unicode separators such as
    // NBSP are label content and must remain unchanged.
    return collapseSpace ? text.replace(/[ \t\n\r\f]+/g, ' ') : text
  }
  tree.iterate({
    enter(node) {
      if (node.name === 'LinkReference') {
        const label = node.node.getChild('LinkLabel')
        const url = node.node.getChild('URL')
        const title = node.node.getChild('LinkTitle')
        if (label !== null && url !== null) {
          definitions.push({
            from: node.from,
            to: node.to,
            text: `${fieldText(label)}: ${fieldText(url, false)}${title === null ? '' : ` ${fieldText(title)}`}`,
          })
        } else if (label !== null) {
          // Lezer omits URL for valid angle destinations containing an escaped
          // closing angle bracket. Keep its parsed source intact rather than
          // silently dropping a definition that the Markdown renderer resolves.
          definitions.push({ from: node.from, to: node.to, text: body.slice(node.from, node.to) })
        }
        return false
      }
      if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag'].includes(node.name)) return false
    },
  })
  // Lezer currently drops a definition whose angle destination escapes `>`.
  // Match source lines only outside parser-recognized code and HTML blocks, and
  // normalize blockquote/list markers before preserving the definition. The
  // candidate's source span keeps fallback and parsed definitions in precedence
  // order; overlapping equivalent spans handle Lezer's omitted-URL node case.
  const lineStarts = [...body.matchAll(/^/gm)].map((match) => match.index ?? 0)
  const escapedAngleDefinition = /^ {0,3}(\[[^\]\n]+\]:\s*<[^\n]*\\>[^\n]*>[^\n]*)$/
  for (const from of lineStarts) {
    const end = body.indexOf('\n', from)
    const to = end === -1 ? body.length : end
    if (excluded.some((range) => from >= range.from && from < range.to)) continue
    let candidate = body.slice(from, to)
    candidate = candidate.replace(/^(?: {0,3}> ?)+/, '')
    candidate = candidate.replace(/^(?: {0,3}(?:[-+*]|\d+[.)]) +)/, '')
    const match = escapedAngleDefinition.exec(candidate)
    const definition = match?.[1]
    if (definition !== undefined) definitions.push({ from, to, text: definition })
  }
  const ordered: typeof definitions = []
  for (const definition of definitions.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const duplicate = ordered.some(
      (previous) =>
        previous.text === definition.text &&
        definition.from < previous.to &&
        previous.from < definition.to,
    )
    if (!duplicate) ordered.push(definition)
  }
  return ordered.length === 0 ? '' : `\n\n${ordered.map(({ text }) => text).join('\n')}`
}

/** Select envelopes whose body is exactly one portable GFM table. */
export function readMarkdownTableCaptions(markdown: string): MarkdownTableCaption[] {
  return readMarkdownCaptionEnvelopes(markdown).flatMap((frame) => {
    const body = markdown.slice(frame.body.from, frame.body.to)
    const wikiLinks = parseWikiLinks(body)
    const normalizedBody = body.split('')
    for (const link of wikiLinks) {
      for (let index = link.start; index < link.end; index++) {
        if (normalizedBody[index] !== '\n' && normalizedBody[index] !== '\r')
          normalizedBody[index] = 'x'
      }
    }
    const tree = markdownParser.parse(normalizedBody.join(''))
    const elements: string[] = []
    let unsupported = false
    tree.iterate({
      enter(node) {
        if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) {
          return false
        }
        if (UNSUPPORTED.has(node.name)) unsupported = true
        if (node.name === 'Link' && node.node.getChild('URL') === null) {
          const source = normalizedBody.slice(node.from, node.to).join('')
          if (source.startsWith('[^') || source.startsWith('[@')) unsupported = true
        }
        if (node.node.parent?.name === 'Document') elements.push(node.name)
      },
    })
    if (elements.length !== 1 || elements[0] !== 'Table' || unsupported) return []
    const caption = markdown.slice(frame.caption.from, frame.caption.to)
    if (!isPortableInlineCaption(caption)) return []
    return [frame]
  })
}
