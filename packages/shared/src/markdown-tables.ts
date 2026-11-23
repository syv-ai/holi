import { GFM, parser } from '@lezer/markdown'
import { parseWikiLinks } from './wiki-links'
import {
  isPortableInlineCaption,
  readMarkdownCaptionEnvelopes,
  writeMarkdownCaptionEnvelope,
} from './markdown-captions'

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

export function readMarkdownTableCaptions(markdown: string): MarkdownTableCaption[] {
  return readMarkdownCaptionEnvelopes(markdown).flatMap((frame) => {
    const body = markdown.slice(frame.body.from, frame.body.to)
    const normalizedBody = body.split('')
    for (const link of parseWikiLinks(body)) {
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
        if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) return false
        if (UNSUPPORTED.has(node.name)) unsupported = true
        if (node.name === 'Link' && node.node.getChild('URL') === null) {
          const source = normalizedBody.slice(node.from, node.to).join('')
          if (source.startsWith('[^') || source.startsWith('[@')) unsupported = true
        }
        if (node.node.parent?.name === 'Document') elements.push(node.name)
      },
    })
    if (elements.length !== 1 || elements[0] !== 'Table' || unsupported) return []
    if (!isPortableInlineCaption(markdown.slice(frame.caption.from, frame.caption.to))) return []
    return [frame]
  })
}

export function writeMarkdownTableCaption(body: string, caption: string): string {
  if (
    readMarkdownTableCaptions(
      `<!-- holi:figure -->\n\n${body}\n\n<!-- holi:caption -->\n\n${caption}\n\n<!-- /holi:figure -->`,
    ).length !== 1
  )
    throw new Error('body must be exactly one portable GFM table')
  if (!isPortableInlineCaption(caption))
    throw new Error('caption must be one portable inline paragraph')
  return writeMarkdownCaptionEnvelope(body, caption)
}
