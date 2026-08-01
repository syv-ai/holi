/**
 * The in-app stand-in for a file Holi can't yet open with a real editor or
 * viewer — every non-markdown file, for now (spec §Arbitrary files). It names the
 * file and its type and says support is coming; a real per-type editor/renderer
 * replaces it later. Deliberately NOT a "reveal in Finder" shortcut — the file
 * stays in-app, in the vault, and syncs like everything else.
 */
import type { FileKind } from '@holi/shared'
import { File, FileText, Image, type LucideIcon } from 'lucide-react'

type OpenableKind = Exclude<FileKind, 'markdown'>

function describe(path: string, kind: OpenableKind): { label: string; Icon: LucideIcon; note: string } {
  switch (kind) {
    case 'image':
      return { label: 'Image', Icon: Image, note: 'Image preview is coming soon.' }
    case 'pdf':
      return { label: 'PDF', Icon: FileText, note: 'PDF preview is coming soon.' }
    case 'doc':
      return { label: 'Document', Icon: FileText, note: 'Document preview is coming soon.' }
    default: {
      const dot = path.lastIndexOf('.')
      const ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1).toUpperCase() : ''
      return {
        label: ext ? `${ext} file` : 'File',
        Icon: File,
        note: 'In-app editing for this file type is coming soon.',
      }
    }
  }
}

export function FilePlaceholder({ path, kind }: { path: string; kind: OpenableKind }) {
  const { label, Icon, note } = describe(path, kind)
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
      <div className="text-muted-foreground">
        <Icon size={40} strokeWidth={1.5} />
      </div>
      <p className="mt-2 font-mono text-sm text-foreground">{name}</p>
      <p className="text-xs">
        {label} — {note} It lives in the vault and syncs.
      </p>
    </div>
  )
}
