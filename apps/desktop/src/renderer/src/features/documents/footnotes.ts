import { mergeAttributes, Node } from '@tiptap/react'
import type { Marked, Token } from 'marked'

const REFERENCE = /^\[\^([^[\]\n]+)\]/
const DEFINITION = /^ {0,3}\[\^([^[\]\n]+)\]:[ \t]*([^\n]*)(?:\n|$)/

/** One definition's source and body; continuation indentation belongs to the
 * definition, not to the nested Markdown blocks it contains. */
function readDefinition(source: string) {
  const first = DEFINITION.exec(source)
  if (!first) return null
  let raw = first[0]
  let body = `${first[2]}\n`
  let remaining = source.slice(raw.length)
  while (remaining) {
    const continuation = /^(?: {4}|\t)([^\n]*)(?:\n|$)/.exec(remaining)
    if (continuation) {
      raw += continuation[0]
      body += `${continuation[1]}\n`
      remaining = remaining.slice(continuation[0].length)
      continue
    }
    const blanks = /^(?:[ \t]*\n)+/.exec(remaining)
    if (blanks && /^(?: {4}|\t)/.test(remaining.slice(blanks[0].length))) {
      raw += blanks[0]
      body += blanks[0].replace(/[^\n]/g, '')
      remaining = remaining.slice(blanks[0].length)
      continue
    }
    break
  }
  return { raw, body, label: first[1]! }
}

/** Install the same grammar in the source/provenance lexer and each editor's
 * actual Markdown manager, after ordinary reference-definition tokenizers. */
export function installFootnoteMarkdown(instance: Marked) {
  instance.use({
    extensions: [
      {
        name: 'footnoteReference',
        level: 'inline',
        start: (source) => source.indexOf('[^'),
        tokenizer(source) {
          const match = REFERENCE.exec(source)
          if (match) return { type: 'footnoteReference', raw: match[0], label: match[1] }
        },
      },
      {
        name: 'footnoteList',
        level: 'block',
        start: (source) => source.search(/^ {0,3}\[\^[^[\]\n]+\]:/m),
        tokenizer(source) {
          const definitions: Token[] = []
          let raw = ''
          let remaining = source
          while (true) {
            const definition = readDefinition(remaining)
            if (!definition) break
            definitions.push({
              type: 'footnoteDefinition',
              raw: definition.raw,
              label: definition.label,
              tokens: this.lexer.blockTokens(definition.body),
            })
            raw += definition.raw
            remaining = remaining.slice(definition.raw.length)
            const separator = /^(?:[ \t]*\n)+/.exec(remaining)?.[0] ?? ''
            if (!DEFINITION.test(remaining.slice(separator.length))) break
            raw += separator
            remaining = remaining.slice(separator.length)
          }
          if (definitions.length) return { type: 'footnoteList', raw, tokens: definitions }
        },
        childTokens: ['tokens'],
      },
    ],
  })
}

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
      mergeAttributes(HTMLAttributes, { 'data-footnote-reference': label, class: 'text-xs' }),
      ['a', { href: `#footnote-${encodeURIComponent(label)}` }, label],
    ]
  },
  renderText({ node }) {
    return `[^${node.attrs.label}]`
  },
  parseMarkdown(token) {
    return { type: 'footnoteReference', attrs: { label: token.label } }
  },
  renderMarkdown(node) {
    return `[^${node.attrs?.label ?? ''}]`
  },
})

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
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
    const content = helpers.parseChildren(token.tokens ?? [])
    if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' })
    return { type: 'footnoteDefinition', attrs: { label: token.label }, content }
  },
  renderMarkdown(node, helpers) {
    const body = helpers.renderChildren(node.content ?? [], '\n\n').trimEnd()
    return `[^${node.attrs?.label}]: ${body.replace(/\n/g, '\n    ')}`
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
  parseMarkdown(token, helpers) {
    return { type: 'footnoteList', content: helpers.parseChildren(token.tokens ?? []) }
  },
  renderMarkdown(node, helpers) {
    return helpers.renderChildren(node.content ?? [], '\n\n')
  },
})
