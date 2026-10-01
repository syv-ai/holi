/**
 * The in-app stand-in for a rich file Holi can't render: an office document,
 * or a PDF while no plugin claims it. It names the file and its type and says support is coming. Text
 * files edit in the plain editor instead. Deliberately NOT a "reveal in
 * Finder" shortcut: the file stays in-app, in the vault, and syncs.
 */
import type { FileKind } from '@holi/shared'
import { FileText, type LucideIcon } from 'lucide-react'

/** The rich formats without a viewer of their own. Text opens the plain
 *  editor instead. */
type OpenableKind = Exclude<FileKind, 'markdown' | 'text' | 'image'>

function describe(kind: OpenableKind): { label: string; Icon: LucideIcon; note: string } {
  switch (kind) {
    case 'doc':
      return { label: 'Document', Icon: FileText, note: 'Document preview is coming soon.' }
    case 'pdf':
      return { label: 'PDF', Icon: FileText, note: 'No plugin that shows PDFs is on.' }
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
        {label}. {note} It lives in the vault and syncs.
      </p>
    </div>
  )
}
