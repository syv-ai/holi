/**
 * What kind of file a vault path is, for choosing an icon and an editor.
 *
 * `markdown` and `text` open in an editor, `image` and `pdf` in their viewers,
 * and `doc` in a typed placeholder. Unknown or extension-less files default to
 * `text` (the forgiving choice: a `.env` or a `Makefile` is editable), so the
 * placeholder is reserved for rich formats that would be garbage as UTF-8.
 */
export type FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'doc'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const DOC = new Set([
  'doc',
  'docx',
  'odt',
  'rtf',
  'xls',
  'xlsx',
  'ods',
  'ppt',
  'pptx',
  'odp',
  'epub',
  'pages',
  'numbers',
  'key',
])

/** A path's extension, lowercased; '' for none. A leading dot is a hidden
 *  name, not an extension. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** The documents the Read all the things plugin opens read-only (docs/features/reader.md). */
export type ReadableDoc = 'docx' | 'pptx' | 'epub'

const READABLE: ReadonlySet<string> = new Set<ReadableDoc>(['docx', 'pptx', 'epub'])

/** Which readable document a path is, or null. Core asks too, to say which
 *  plugin to turn on when it is off. */
export function readableDoc(path: string): ReadableDoc | null {
  const ext = extensionOf(path)
  return READABLE.has(ext) ? (ext as ReadableDoc) : null
}

export function fileKind(path: string): FileKind {
  const ext = extensionOf(path)
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE.has(ext)) return 'image'
  if (DOC.has(ext)) return 'doc'
  return 'text'
}
