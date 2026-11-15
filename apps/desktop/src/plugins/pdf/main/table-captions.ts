import { GFM, parser } from '@lezer/markdown'
import { isPortableInlineCaption, parseWikiLinks, readMarkdownCaptionEnvelopes } from '@holi/shared'

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

/** Neutralize user raw-Typst comments without shifting any parser source positions. */
export function removeRawTypstComments(markdown: string): string {
  const tree = markdownParser.parse(markdown)
  const ranges: { from: number; to: number }[] = []
  tree.iterate({
    enter(node) {
      if (!['Comment', 'HTMLBlock', 'HTMLTag'].includes(node.name)) return
      const text = markdown.slice(node.from, node.to)
      const pattern = /<!--raw-typst\b[\s\S]*?(?:-->|$)/g
      for (const match of text.matchAll(pattern)) {
        const from = node.from + match.index
        ranges.push({ from, to: from + match[0].length })
      }
    },
  })
  if (ranges.length === 0) return markdown
  const chars = markdown.split('')
  for (const { from, to } of ranges) {
    for (let index = from; index < to; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
    }
  }
  return chars.join('')
}

/** Full-document definitions as parsed by CommonMark, excluding code and HTML. */
export function readMarkdownReferenceDefinitions(markdown: string): string {
  const tree = markdownParser.parse(markdown)
  const definitions: string[] = []
  tree.iterate({
    enter(node) {
      if (node.name === 'LinkReference') {
        definitions.push(markdown.slice(node.from, node.to))
        return false
      }
      if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag'].includes(node.name)) return false
    },
  })
  return definitions.length === 0 ? '' : `\n\n${definitions.join('\n')}`
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
