/**
 * The in-app stand-in for a rich file Holi can't yet render — an image, PDF or
 * office document (spec §Arbitrary files). It names the file and its type and
 * says support is coming; a real per-type viewer replaces it later. Text files
 * are NOT here: they edit in the plain editor (`EditorPane plain`). Deliberately
 * NOT a "reveal in Finder" shortcut — the file stays in-app, in the vault, and
 * syncs like everything else.
 */
import type { FileKind } from '@holi/shared'
import { FileText, Image, type LucideIcon } from 'lucide-react'

/** The rich formats without an editor — text opens the plain editor instead. */
type OpenableKind = Exclude<FileKind, 'markdown' | 'text'>

function describe(kind: OpenableKind): { label: string; Icon: LucideIcon; note: string } {
  switch (kind) {
    case 'image':
      return { label: 'Image', Icon: Image, note: 'Image preview is coming soon.' }
    case 'pdf':
      return { label: 'PDF', Icon: FileText, note: 'PDF preview is coming soon.' }
    case 'doc':
      return { label: 'Document', Icon: FileText, note: 'Document preview is coming soon.' }
  }
}

export function FilePlaceholder({ path, kind }: { path: string; kind: OpenableKind }) {
  const { label, Icon, note } = describe(kind)
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
