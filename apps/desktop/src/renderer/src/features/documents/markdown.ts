/**
 * A document is markdown on disk and Tiptap in the editor. Only the body
 * passes through the editor: the frontmatter block is kept byte for byte and
 * put back on save, since the editor neither shows nor understands it.
 *
 * The body round-trips through Tiptap's own markdown rules (`@tiptap/markdown`
 * and each extension's parse and render), so a file's formatting is
 * normalised the first time it is edited here, never on open alone.
 */
import { Markdown } from '@tiptap/markdown'
import { readMarkdownCodeCaptions } from '@holi/shared'

/** The line that marks where an agent run was asked to write: an HTML
 *  comment, so it is invisible anywhere else the file is read. */
export const AGENT_MARKER = '<!-- holi:agent -->'

/** The extension the editor needs to read and write markdown. */
function withDocumentFigures(manager: { parse: (source: string) => any }, source: string) {
  const frames = readMarkdownCodeCaptions(source).filter(
    (frame) => frame.language.toLowerCase() !== 'mermaid',
  )
  if (!frames.length) return manager.parse(source)

  const placeholders = frames.map((_, index) => {
    let token = `<!-- holi-private-caption-${index} -->`
    let suffix = 0
    while (source.includes(token)) token = `<!-- holi-private-caption-${index}-${++suffix} -->`
    return token
  })
  let substituted = source
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index]!
    substituted =
      substituted.slice(0, frame.envelope.from) +
      placeholders[index] +
      substituted.slice(frame.envelope.to)
  }
  const parsed = manager.parse(substituted)
  const figures = frames.map((frame) => {
    const fence = source.slice(frame.body.from, frame.body.to)
    const codeDocument = manager.parse(fence)
    const code = codeDocument.content?.find((node: any) => node.type === 'codeBlock')
    const captionMarkdown = source.slice(frame.caption.from, frame.caption.to)
    const captionDocument = manager.parse(captionMarkdown)
    const caption = captionDocument.content?.find((node: any) => node.type === 'paragraph')
    if (!code || !caption) return null
    const text = code.content?.map((part: any) => part.text ?? '').join('') ?? ''
    code.attrs = {
      ...code.attrs,
      sourceFence: fence,
      sourceFenceText: text,
      sourceFenceLanguage: String(code.attrs?.language ?? ''),
    }
    return {
      type: 'documentFigure',
      content: [code, { type: 'documentCaption', content: caption.content }],
    }
  })
  let index = 0
  parsed.content = (parsed.content ?? []).flatMap((node: any) => {
    const placeholder = placeholders[index]
    if (
      placeholder &&
      node.type === 'htmlBlock' &&
      String(node.attrs?.html).trim() === placeholder
    ) {
      const figure = figures[index++]
      return figure ? [figure] : [node]
    }
    return [node]
  })
  return parsed
}

export const DocumentMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    const initial = this.editor.options.content
    this.parent?.(event)
    const manager = this.editor.markdown
    if (!manager || typeof initial !== 'string') return
    const parse = manager.parse.bind(manager)
    manager.parse = (source: string) => withDocumentFigures({ parse }, source)
    if (
      this.editor.options.contentType === 'markdown' &&
      readMarkdownCodeCaptions(initial).length
    ) {
      this.editor.options.content = withDocumentFigures({ parse }, initial)
      this.editor.options.contentType = 'json'
    }
  },
}).configure({
  indentation: { style: 'space', size: 2 },
  markedOptions: { gfm: true },
})

/** A file split where its body starts: `head` is the frontmatter fence and
 *  everything up to the body, verbatim; empty when there is none. */
export function splitDocument(text: string): { head: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { head: '', body: normalized }
  const close = normalized.indexOf('\n---', 3)
  if (close === -1) return { head: '', body: normalized }
  const lineEnd = normalized.indexOf('\n', close + 4)
  if (lineEnd === -1) return { head: `${normalized}\n`, body: '' }
  // Blank lines between the fence and the body stay with the head.
  let start = lineEnd + 1
  while (normalized[start] === '\n') start++
  return { head: normalized.slice(0, start), body: normalized.slice(start) }
}

/** The file again: the head as it was, the editor's body, one trailing
 *  newline. */
export function joinDocument(head: string, body: string): string {
  const trimmed = body.replace(/\s+$/, '')
  return trimmed === '' ? head : `${head}${trimmed}\n`
}

/** The name a document shows: its file name without the extension. */
export function documentTitle(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
