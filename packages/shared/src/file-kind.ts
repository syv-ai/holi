/**
 * What kind of file a vault path is, for choosing an icon and an editor.
 *
 * The vault is "mostly markdown" but holds anything now. `markdown` and `text`
 * open in an editor; `image` / `pdf` / `doc` open a typed placeholder until a
 * real renderer exists. Unknown or extension-less files default to `text` (the
 * forgiving choice — a `.env` or a `Makefile` is editable), so the placeholder
 * is reserved for the known visual/rich formats that would be garbage as UTF-8.
 */
export type FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'doc'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const DOC = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pages', 'numbers', 'key'])

export function fileKind(path: string): FileKind {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE.has(ext)) return 'image'
  if (DOC.has(ext)) return 'doc'
  return 'text'
}
