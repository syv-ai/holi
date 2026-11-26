import { mergeAttributes, Node } from '@tiptap/react'

const REF = /^\[\^([^\]\n]+)\]/

export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { label: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote-reference]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const label = String(node.attrs.label)
    return [
      'sup',
      mergeAttributes(HTMLAttributes, { 'data-footnote-reference': label }),
      ['a', { href: `#footnote-${encodeURIComponent(label)}` }, label],
    ]
  },
  renderText({ node }) {
    return `[^${node.attrs.label}]`
  },
  markdownTokenizer: {
    name: 'footnoteReference',
    level: 'inline' as const,
    start: (source: string) => source.indexOf('[^'),
    tokenize(source: string) {
      const match = REF.exec(source)
      return match ? { type: 'footnoteReference', raw: match[0], label: match[1] } : undefined
    },
  },
  parseMarkdown(token) {
    return { type: 'footnoteReference', attrs: { label: token.label } }
  },
  renderMarkdown({ attrs }) {
    return `[^${attrs?.label ?? ''}]`
  },
})

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  addAttributes() {
    return { label: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'li[data-footnote-definition]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const label = String(node.attrs.label)
    return [
      'li',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-definition': label,
        id: `footnote-${encodeURIComponent(label)}`,
      }),
      0,
    ]
  },
  parseMarkdown(token, helpers) {
    return {
      type: 'footnoteDefinition',
      attrs: { label: token.label },
      content: helpers.parseInline(token.tokens ?? []),
    }
  },
  renderMarkdown({ node, helpers }) {
    return `[^${node.attrs.label}]: ${helpers.renderChildren(node)}\n`
  },
})

export const FootnoteList = Node.create({
  name: 'footnoteList',
  group: 'block',
  content: 'footnoteDefinition+',
  defining: true,
  parseHTML() {
    return [{ tag: 'ol[data-footnotes]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['ol', mergeAttributes(HTMLAttributes, { 'data-footnotes': '' }), 0]
  },
})
