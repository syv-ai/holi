import { Node, mergeAttributes, type Editor } from '@tiptap/react'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { fencedBlocks, readMarkdownCodeCaptions, writeMarkdownCaptionEnvelope } from '@holi/shared'

const SOURCE_FENCE_ATTR = 'data-holi-source-fence'
const SOURCE_FENCE_LANGUAGE_ATTR = 'data-holi-source-fence-language'

export function sourceFenceMatches(source: string, code: string, language: string): boolean {
  const [block] = fencedBlocks(source)
  if (!block || block.from !== 0 || block.to !== source.length) return false
  const opening = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n/.exec(source)
  if (!opening || (opening[2]!.startsWith('`') && opening[3]!.includes('`'))) return false
  const marker = opening[2]![0]!
  const closing = new RegExp(`\\n {0,3}${marker}{${opening[2]!.length},}[ \\t]*$`)
  const match = closing.exec(source)
  if (!match) return false
  const info = opening[3]!.trim().split(/\s+/, 1)[0] ?? ''
  if (info.toLowerCase() !== language.trim().split(/\s+/, 1)[0]?.toLowerCase()) return false
  return block.body === code
}

function renderSafeFence(language: string, code: string): string {
  const delimiter = language.includes('`') ? '~' : '`'
  const longestRun = Math.max(
    0,
    ...[...code.matchAll(new RegExp(`${delimiter}+`, 'g'))].map(([run]) => run.length),
  )
  const fence = delimiter.repeat(Math.max(3, longestRun + 1))
  const info = language.replace(/[\r\n]/g, ' ').trim()
  const opening = `${fence}${info ? ` ${info}` : ''}`
  return `${opening}\n${code}\n${fence}`
}

/** A portable inline-only textblock kept native in the document model. */
export const DocumentCaption = Node.create({
  name: 'documentCaption',
  group: 'block',
  content: 'text*',
  marks: 'bold italic code link strike',
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: 'figcaption' }]
  },
  renderHTML() {
    return ['figcaption', 0]
  },
  addKeyboardShortcuts() {
    const inCaption = () => this.editor.state.selection.$from.parent.type.name === this.name
    return {
      Enter: () => inCaption(),
      'Shift-Enter': () => inCaption(),
    }
  },
})

/** A non-atomic code figure: the existing code block followed by an editable caption. */
export const DocumentFigure = Node.create({
  name: 'documentFigure',
  group: 'block',
  content: '(codeBlock | image) documentCaption',
  defining: true,
  isolating: true,
  draggable: true,
  markdownTokenName: 'holiCodeFigure',

  addAttributes() {
    return { sourceBody: { default: null } }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => {
        const { $from } = this.editor.state.selection
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name === 'documentFigure') return true
        }
        return false
      },
    }
  },

  addProseMirrorPlugins() {
    const { editor } = this
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const markdown = event.clipboardData?.getData('text/plain')
            const { $from } = view.state.selection
            for (let depth = $from.depth; depth > 0; depth--) {
              if ($from.node(depth).type.name === 'codeBlock') return false
            }
            if (!editor.isEditable || !markdown) return false
            if ($from.parent.type.name === 'documentCaption' && /[\r\n]/.test(markdown)) {
              event.preventDefault()
              view.dispatch(view.state.tr.insertText(markdown.replace(/\r?\n/g, ' ')))
              return true
            }
            if (
              !editor.isEditable ||
              !markdown ||
              !readMarkdownCodeCaptions(markdown).some(
                (caption) => caption.language.toLowerCase() !== 'mermaid',
              )
            )
              return false
            const manager = editor.markdown
            if (!manager) return false
            const parsed = editor.schema.nodeFromJSON(manager.parse(markdown))
            if (!parsed.childCount) return false
            view.dispatch(
              view.state.tr.replaceSelection(new Slice(Fragment.from(parsed.content), 0, 0)),
            )
            return true
          },
        },
      }),
    ]
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-holi-code-figure]',
        getAttrs: (element: HTMLElement) =>
          element.parentElement?.closest('blockquote, ul, ol, li') ? false : null,
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-holi-code-figure': '' }), 0]
  },

  renderMarkdown(node, helpers) {
    const code = node.content?.[0]
    const caption = node.content?.[1]
    if (!code || !caption || caption.type !== 'documentCaption') return ''
    if (code.type === 'image') {
      const source = node.attrs?.sourceBody
      const captionText = (caption.content ?? [])
        .map((part: { text?: string }) => part.text ?? '')
        .join('')
      if (typeof source !== 'string') return ''
      if (!captionText.trim()) return source
      const replacements = new Map<string, string>()
      const captionSource = JSON.stringify(caption)
      let placeholderIndex = 0
      const captionForMarkdown = {
        ...caption,
        content: caption.content?.map(
          (part: {
            text?: string
            marks?: { type: string; attrs?: Record<string, unknown> }[]
          }) => {
            const marks = part.marks ?? []
            const isCode = marks.some((mark) => mark.type === 'code')
            let text = part.text
            if (text && !isCode) {
              text = text.replace(/[\\[\\]]/g, (bracket) => {
                let placeholder = `HOLICAPBRACKET${placeholderIndex++}X`
                while (captionText.includes(placeholder) || captionSource.includes(placeholder)) {
                  placeholder = `HOLICAPBRACKET${placeholderIndex++}X`
                }
                replacements.set(placeholder, bracket === '[' ? '&#91;' : '&#93;')
                return placeholder
              })
            }
            return { ...part, ...(text === undefined ? {} : { text }) }
          },
        ),
      }
      let rendered = helpers.renderChildren(captionForMarkdown).replace(/\\n+$/, '')
      for (const [placeholder, entity] of replacements)
        rendered = rendered.replaceAll(placeholder, entity)
      try {
        return writeMarkdownCaptionEnvelope(source, rendered)
      } catch {
        return ''
      }
    }
    if (code.type !== 'codeBlock') return ''
    const rawFence = code.attrs?.sourceFence
    const originalText = code.attrs?.sourceFenceText
    const codeText = code.content?.map((part: { text?: string }) => part.text ?? '').join('') ?? ''
    const language = String(code.attrs?.language ?? '')
    const originalLanguage = code.attrs?.sourceFenceLanguage
    const body =
      typeof rawFence === 'string' &&
      originalText === codeText &&
      String(originalLanguage ?? '')
        .trim()
        .split(/\s+/, 1)[0]
        ?.toLowerCase() === language.trim().split(/\s+/, 1)[0]?.toLowerCase() &&
      sourceFenceMatches(rawFence, codeText, language)
        ? rawFence
        : renderSafeFence(language, codeText)
    const replacements = new Map<string, string>()
    const captionText = (caption.content ?? [])
      .map((part: { text?: string }) => part.text ?? '')
      .join('')
    const captionSource = JSON.stringify(caption)
    let placeholderIndex = 0
    const captionForMarkdown = {
      ...caption,
      content: caption.content?.map(
        (part: { text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }) => {
          const marks = part.marks ?? []
          const isCode = marks.some((mark) => mark.type === 'code')
          let text = part.text
          if (text && !isCode) {
            text = text.replace(/[\[\]]/g, (bracket) => {
              let placeholder = `HOLICAPBRACKET${placeholderIndex++}X`
              while (captionText.includes(placeholder) || captionSource.includes(placeholder)) {
                placeholder = `HOLICAPBRACKET${placeholderIndex++}X`
              }
              replacements.set(placeholder, bracket === '[' ? '&#91;' : '&#93;')
              return placeholder
            })
          }
          return {
            ...part,
            ...(text === undefined ? {} : { text }),
            marks: marks.map((mark) =>
              mark.type === 'link' && typeof mark.attrs?.href === 'string'
                ? {
                    ...mark,
                    attrs: {
                      ...mark.attrs,
                      href: mark.attrs.href.replace(/\[/g, '%5B').replace(/\]/g, '%5D'),
                    },
                  }
                : mark,
            ),
          }
        },
      ),
    }
    let renderedCaption = helpers.renderChildren(captionForMarkdown).replace(/\n+$/, '')
    for (const [placeholder, entity] of replacements) {
      renderedCaption = renderedCaption.replaceAll(placeholder, entity)
    }
    const escapedCaption = renderedCaption

    if (!escapedCaption.trim()) return body
    try {
      return writeMarkdownCaptionEnvelope(body, escapedCaption)
    } catch {
      // A mark the portable grammar cannot express must not erase the caption.
      const plainText = (caption.content ?? [])
        .map((part: { text?: string }) => part.text ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (!plainText) return body
      const escaped = plainText.replace(/([\\`*_{}\[\]()#+.!<>~-])/g, '\\$1')
      try {
        return writeMarkdownCaptionEnvelope(body, escaped)
      } catch {
        return body
      }
    }
  },
})

/** Preserve the original fence byte-for-byte while the code itself is unchanged. */
export function addImageCaption(editor: Editor, pos: number): boolean {
  if (!editor.isEditable) return false
  const node = editor.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'image') return false
  const caption = editor.schema.nodes.documentCaption?.create()
  const image = editor.schema.nodes.image?.create(node.attrs, node.content, node.marks)
  const source = node.attrs.src
  if (
    !caption ||
    !image ||
    typeof source !== 'string' ||
    !source ||
    /^(?:holi-vault:|https?:)/i.test(source)
  )
    return false
  const escapedSource = source.replace(/[\\()]/g, '\\$&')
  const alt = String(node.attrs.alt ?? '').replace(/([\\\[\]])/g, '\\$1')
  const title =
    typeof node.attrs.title === 'string' && node.attrs.title
      ? ` "${node.attrs.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : ''
  const body = `![${alt}](${escapedSource}${title})`
  const figure = editor.schema.nodes.documentFigure?.create({ sourceBody: body }, [image, caption])
  if (!figure) return false
  editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, figure))
  editor.commands.setTextSelection(pos + image.nodeSize + 2)
  editor.view.focus()
  return true
}

export function addCodeCaption(editor: Editor, pos: number): boolean {
  if (!editor.isEditable) return false
  if (pos < 0 || pos > editor.state.doc.content.size) return false
  const node = editor.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'codeBlock' || node.attrs.language?.toLowerCase() === 'mermaid')
    return false
  const paragraph = editor.schema.nodes.documentCaption?.create()
  if (!paragraph) return false
  const code = node.type.create({ ...node.attrs, preserveFence: true }, node.content, node.marks)
  const figure = editor.schema.nodes.documentFigure?.create(null, [code, paragraph])
  if (!figure) return false
  editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, figure))
  const captionStart = pos + 1 + node.nodeSize + 1
  editor.commands.setTextSelection(captionStart)
  editor.view.focus()
  return true
}

export function focusCodeCaption(editor: Editor, pos: number): boolean {
  if (!editor.isEditable || pos < 0 || pos > editor.state.doc.content.size) return false
  const figure = editor.state.doc.nodeAt(pos)
  const code = figure?.type.name === 'documentFigure' ? figure.firstChild : null
  if (!figure || !code) return false
  editor.commands.setTextSelection(pos + code.nodeSize + 2)
  editor.view.focus()
  return true
}

export function removeCodeCaption(editor: Editor, pos: number): boolean {
  if (!editor.isEditable) return false
  if (pos < 0 || pos > editor.state.doc.content.size) return false
  const node = editor.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'documentFigure' || !node.firstChild) return false
  const child = node.firstChild
  const replacement =
    child.type.name === 'codeBlock'
      ? child.type.create({ ...child.attrs, preserveFence: true }, child.content, child.marks)
      : child
  editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, replacement))
  return true
}

export function safeCodeFence(language: string, code: string): string {
  return renderSafeFence(language, code)
}

export const CaptionCodeBlockAttributes = {
  sourceFence: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute(SOURCE_FENCE_ATTR),
    renderHTML: (attributes: Record<string, unknown>) =>
      typeof attributes.sourceFence === 'string'
        ? { [SOURCE_FENCE_ATTR]: attributes.sourceFence }
        : {},
  },
  sourceFenceText: {
    default: null,
    parseHTML: (element: HTMLElement) => element.querySelector('code')?.textContent ?? '',
    renderHTML: () => ({}),
  },
  sourceFenceLanguage: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute(SOURCE_FENCE_LANGUAGE_ATTR),
    renderHTML: (attributes: Record<string, unknown>) =>
      typeof attributes.sourceFenceLanguage === 'string'
        ? { [SOURCE_FENCE_LANGUAGE_ATTR]: attributes.sourceFenceLanguage }
        : {},
  },
  preserveFence: {
    default: false,
    parseHTML: () => false,
    renderHTML: () => ({}),
  },
}
