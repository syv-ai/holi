import { GFM, parser } from '@lezer/markdown'
import { readMarkdownTableCaptions } from '@holi/shared'
import { splitFrontmatter } from '@holi/shared'

const markdownParser = parser.configure(GFM)

/** Full-document definitions as parsed by CommonMark, excluding code and HTML.
 * Rebuild from syntax fields rather than copying container source: a definition
 * can span blockquote/list lines whose markers are not part of its value. */
export function readMarkdownReferenceDefinitions(markdown: string): string {
  const body = splitFrontmatter(markdown).body
  // Lezer does not recognize `\\>` inside an angle destination. Replace it
  // with an equally sized escaped character while parsing so the closing `>`
  // remains structural; source offsets still map directly to `body`. Paired
  // backslashes leave the angle unescaped and must retain their closing role.
  const parserInput = body.replace(/(\\+)>/g, (match, escapes: string) =>
    escapes.length % 2 === 0 ? match : `${escapes}x`,
  )
  const tree = markdownParser.parse(parserInput)
  const definitions: string[] = []
  const quoteMarks: { from: number; to: number }[] = []
  tree.iterate({
    enter(node) {
      if (node.name === 'QuoteMark') quoteMarks.push({ from: node.from, to: node.to })
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
          definitions.push(
            `${fieldText(label)}: ${fieldText(url, false)}${title === null ? '' : ` ${fieldText(title)}`}`,
          )
        } else if (label !== null) {
          // Lezer omits URL for valid angle destinations containing an escaped
          // closing angle bracket. Keep its parsed source intact rather than
          // silently dropping a definition that the Markdown renderer resolves.
          definitions.push(body.slice(node.from, node.to))
        }
        return false
      }
      if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag'].includes(node.name)) return false
    },
  })
  return definitions.length === 0 ? '' : `\n\n${definitions.join('\n')}`
}
