import { GFM, parser } from '@lezer/markdown'
import {
  fileKind,
  isPortableInlineCaption,
  parseWikiLinks,
  readMarkdownCaptionEnvelopes,
} from '@holi/shared'

const markdownParser = parser.configure(GFM)
const UNSUPPORTED = new Set([
  'HTMLBlock',
  'HTMLTag',
  'Image',
  'LinkReference',
  'Autolink',
  'FootnoteReference',
  'FootnoteDefinition',
])

export interface MarkdownTableCaption {
  envelope: { from: number; to: number }
  body: { from: number; to: number }
  caption: { from: number; to: number }
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
    const codeRanges: { from: number; to: number }[] = []
    let unsupported = false
    tree.iterate({
      enter(node) {
        if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) {
          codeRanges.push({ from: node.from, to: node.to })
          return false
        }
        if (UNSUPPORTED.has(node.name)) unsupported = true
        if (node.name === 'Link' && node.node.getChild('URL') === null) unsupported = true
        if (node.node.parent?.name === 'Document') elements.push(node.name)
      },
    })
    const proseWikiLinks = wikiLinks.filter(
      (link) => !codeRanges.some((range) => link.start >= range.from && link.start < range.to),
    )
    if (proseWikiLinks.some((link) => fileKind(link.target) === 'image')) unsupported = true
    if (elements.length !== 1 || elements[0] !== 'Table' || unsupported) return []
    const caption = markdown.slice(frame.caption.from, frame.caption.to)
    if (!isPortableInlineCaption(caption)) return []
    return [frame]
  })
}
