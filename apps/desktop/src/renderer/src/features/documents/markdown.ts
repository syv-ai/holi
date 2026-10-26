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

/** The line that marks where an agent run was asked to write: an HTML
 *  comment, so it is invisible anywhere else the file is read. */
export const AGENT_MARKER = '<!-- holi:agent -->'

/** The extension the editor needs to read and write markdown. */
export const DocumentMarkdown = Markdown.configure({
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
