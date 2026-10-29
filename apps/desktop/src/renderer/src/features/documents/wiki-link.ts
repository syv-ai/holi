/**
 * `[[Target]]` and `[[Target|label]]` as an inline chip, written back exactly
 * as it was read. Without it the markdown serializer escapes the brackets
 * (`\[\[Target\]\]`) and every link in a document breaks on its first save.
 *
 * Typed or pasted, `[[…]]` becomes a chip as its `]]` lands; left as text,
 * it would be saved escaped and stop being a link.
 *
 * Pressing a chip asks `onOpen` (set by the document view) to open the
 * target; resolving the name to a path is the view's business.
 */
import { InputRule, mergeAttributes, Node, PasteRule } from '@tiptap/react'

const WIKI_LINK = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/
const TYPED = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]$/
const PASTED = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g

/** A chip's attributes from a `[[target|label]]` match. */
const attrsOf = (match: RegExpMatchArray) => ({
  target: match[1]!.trim(),
  label: match[2]?.trim() ?? null,
})

export interface WikiLinkOptions {
  onOpen: (target: string) => void
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { onOpen: () => undefined }
  },

  addAttributes() {
    return {
      target: { default: '' },
      label: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-wiki-link]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-wiki-link': node.attrs.target,
        class:
          'text-primary cursor-pointer rounded-sm underline decoration-current/30 underline-offset-2 hover:decoration-current',
      }),
      node.attrs.label ?? node.attrs.target,
    ]
  },

  // The whole match, brackets and all, becomes the chip.
  addInputRules() {
    return [
      new InputRule({
        find: TYPED,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create(attrsOf(match)))
        },
      }),
    ]
  },

  addPasteRules() {
    return [
      new PasteRule({
        find: PASTED,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create(attrsOf(match)))
        },
      }),
    ]
  },

  renderText({ node }) {
    return node.attrs.label ?? node.attrs.target
  },

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize(src: string) {
      const match = WIKI_LINK.exec(src)
      if (!match) return undefined
      return {
        type: 'wikiLink',
        raw: match[0],
        target: match[1]!.trim(),
        label: match[2]?.trim() ?? null,
      }
    },
  },

  parseMarkdown(token) {
    return {
      type: 'wikiLink',
      attrs: { target: token.target, label: token.label ?? null },
    }
  },

  renderMarkdown(node) {
    const { target, label } = node.attrs ?? {}
    return label ? `[[${target}|${label}]]` : `[[${target}]]`
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.dataset.wikiLink = node.attrs.target
      dom.className =
        'text-primary cursor-pointer rounded-sm underline decoration-current/30 underline-offset-2 hover:decoration-current'
      dom.textContent = node.attrs.label ?? node.attrs.target
      dom.addEventListener('mousedown', (event) => {
        event.preventDefault()
        this.options.onOpen(node.attrs.target)
      })
      return { dom }
    }
  },
})
