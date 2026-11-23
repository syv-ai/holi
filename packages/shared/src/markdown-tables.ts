import { GFM, parser } from '@lezer/markdown'
import { parseWikiLinks } from './wiki-links'
import {
  isPortableInlineCaption,
  readMarkdownCaptionEnvelopes,
  writeMarkdownCaptionEnvelope,
} from './markdown-captions'
import type { MarkdownCaptionEnvelope } from './markdown-captions'

const markdownParser = parser.configure(GFM)
const UNSUPPORTED = new Set([
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'Autolink',
  'FootnoteReference',
  'FootnoteDefinition',
])

export type MarkdownTableCaption = MarkdownCaptionEnvelope

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
        if (node.node.parent?.name === 'Document') elements.push(node.name)
        if (['FencedCode', 'CodeBlock'].includes(node.name)) return false
        if (node.name === 'InlineCode') return false
        if (UNSUPPORTED.has(node.name)) unsupported = true
        if (node.name === 'Link' && node.node.getChild('URL') === null) {
          const source = normalizedBody.slice(node.from, node.to).join('')
          if (source.startsWith('[^') || source.startsWith('[@')) unsupported = true
        }
      },
    })
    if (elements.length !== 1 || elements[0] !== 'Table' || unsupported) return []
    if (!isPortableInlineCaption(markdown.slice(frame.caption.from, frame.caption.to))) return []
    return [frame]
  })
}

export function writeMarkdownTableCaption(body: string, caption: string): string {
  const serialized = writeMarkdownCaptionEnvelope(body, caption)
  const frame = readMarkdownTableCaptions(serialized)[0]
  if (!frame)
    throw new Error('expected exactly one portable GFM table and one portable inline caption')
  return serialized
}
