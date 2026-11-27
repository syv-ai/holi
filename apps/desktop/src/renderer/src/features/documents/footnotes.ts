import { mergeAttributes, Node } from '@tiptap/react'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Marked, Token } from 'marked'

const REFERENCE = /^\[\^([^[\]\n]+)\]/
const DEFINITION = /^ {0,3}\[\^([^[\]\n]+)\]:[ \t]*([^\n]*)(?:\n|$)/
interface DefinitionTarget {
  pos: number
  size: number
  id: string
  number: number
  references: ReferenceTarget[]
}
interface ReferenceTarget {
  pos: number
  id: string
  definition?: DefinitionTarget
}
interface NavigationIndex {
  decorations: DecorationSet
  references: Map<number, ReferenceTarget>
  targets: Map<string, number>
}
const footnoteKey = new PluginKey<NavigationIndex>('documentFootnotes')
let editorSequence = 0

function normalizedLabel(label: string) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function footnoteNavigation() {
  const scope = `footnote-${++editorSequence}`
  return new Plugin<NavigationIndex>({
    key: footnoteKey,
    state: {
      init: (_, state) => indexFootnotes(state.doc, scope),
      apply: (tr, current) => (tr.docChanged ? indexFootnotes(tr.doc, scope) : current),
    },
    props: {
      decorations: (state) => footnoteKey.getState(state)?.decorations ?? null,
      handleDOMEvents: {
        click: navigateFootnote,
        keydown: (view, event) => event.key === 'Enter' && navigateFootnote(view, event),
      },
    },
  })
}

function navigateFootnote(view: EditorView, event: Event) {
  const anchor =
    event.target instanceof Element ? event.target.closest('a[data-footnote-destination]') : null
  if (!anchor || !view.dom.contains(anchor)) return false
  const id = anchor.getAttribute('data-footnote-destination')!
  const position = footnoteKey.getState(view.state)?.targets.get(id)
  event.preventDefault()
  event.stopPropagation()
  if (position === undefined) return true
  view.dispatch(
    view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position + 1))),
  )
  view.focus()
  ;(view.nodeDOM(position) as HTMLElement).scrollIntoView({ block: 'nearest' })
  return true
}

/** Derived view state only: numbering and navigation never alter Markdown or
 * create autosave/history transactions. Every editor owns its target IDs. */
function indexFootnotes(doc: ProseMirrorNode, scope: string): NavigationIndex {
  const definitions: DefinitionTarget[] = []
  const firstDefinition = new Map<string, DefinitionTarget>()
  const references = new Map<number, ReferenceTarget>()
  const targets = new Map<string, number>()
  doc.descendants((node, pos) => {
    if (node.type.name !== 'footnoteDefinition') return
    const definition = {
      pos,
      size: node.nodeSize,
      id: `${scope}-note-${pos}`,
      number: definitions.length + 1,
      references: [] as ReferenceTarget[],
    }
    definitions.push(definition)
    const label = normalizedLabel(String(node.attrs.label))
    if (!firstDefinition.has(label)) firstDefinition.set(label, definition)
    targets.set(definition.id, pos)
  })
  doc.descendants((node, pos) => {
    if (node.type.name !== 'footnoteReference') return
    const definition = firstDefinition.get(normalizedLabel(String(node.attrs.label)))
    const reference = { pos, id: `${scope}-ref-${pos}`, definition }
    references.set(pos, reference)
    targets.set(reference.id, pos)
    definition?.references.push(reference)
  })
  const decorations: Decoration[] = []
  for (const definition of definitions) {
    decorations.push(
      Decoration.node(definition.pos, definition.pos + definition.size, {
        id: definition.id,
        value: String(definition.number),
      }),
    )
    if (definition.references.length)
      decorations.push(
        Decoration.widget(
          definition.pos + definition.size - 1,
          (view) => {
            const links = view.dom.ownerDocument.createElement('span')
            links.contentEditable = 'false'
            links.className = 'text-xs'
            definition.references.forEach((reference, index) => {
              const anchor = view.dom.ownerDocument.createElement('a')
              anchor.href = `#${reference.id}`
              anchor.dataset.footnoteDestination = reference.id
              anchor.setAttribute(
                'aria-label',
                `Back to footnote ${definition.number}, reference ${index + 1}`,
              )
              anchor.textContent = definition.references.length === 1 ? ' ↩' : ` ↩${index + 1}`
              links.append(anchor)
            })
            return links
          },
          {
            side: -1,
            key: `${definition.id}:${definition.references.map((ref) => ref.id).join(',')}`,
          },
        ),
      )
  }
  for (const reference of references.values())
    decorations.push(
      Decoration.node(reference.pos, reference.pos + 1, {
        id: reference.id,
        'data-footnote-number': String(reference.definition?.number ?? ''),
        'data-footnote-target': reference.definition?.id ?? '',
      }),
    )
  return { decorations: DecorationSet.create(doc, decorations), references, targets }
}

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
  addProseMirrorPlugins() {
    return [footnoteNavigation()]
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote-reference]', priority: 60 }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const label = String(node.attrs.label)
    const id = `footnote-${encodeURIComponent(normalizedLabel(label))}`
    return [
      'sup',
      mergeAttributes(HTMLAttributes, { 'data-footnote-reference': label, class: 'text-xs' }),
      ['a', { href: `#${encodeURIComponent(id)}` }, label],
    ]
  },
  addNodeView() {
    return ({ node, view, getPos }) => {
      const dom = view.dom.ownerDocument.createElement('sup')
      dom.className = 'text-xs'
      dom.contentEditable = 'false'
      const render = (current: ProseMirrorNode) => {
        dom.dataset.footnoteReference = String(current.attrs.label)
        const position = getPos()
        const reference =
          position === undefined
            ? undefined
            : footnoteKey.getState(view.state)?.references.get(position)
        dom.replaceChildren()
        if (!reference?.definition) {
          dom.textContent = `[^${current.attrs.label}]`
          return
        }
        const anchor = view.dom.ownerDocument.createElement('a')
        anchor.href = `#${reference.definition.id}`
        anchor.dataset.footnoteDestination = reference.definition.id
        anchor.setAttribute('aria-label', `Footnote ${reference.definition.number}`)
        anchor.textContent = String(reference.definition.number)
        dom.append(anchor)
      }
      render(node)
      return {
        dom,
        ignoreMutation: () => true,
        update(current) {
          if (current.type !== node.type) return false
          render(current)
          return true
        },
      }
    }
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
    return [{ tag: 'li[data-footnote-definition]', priority: 60 }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const label = String(node.attrs.label)
    return [
      'li',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-definition': label,
        id: `footnote-${encodeURIComponent(normalizedLabel(label))}`,
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
    return [{ tag: 'ol[data-footnotes]', priority: 60 }]
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
