/**
 * The tree's structural icons: the expand chevron, the folder glyph, and the
 * markdown glyph used by the new-file pending row. Per-file-type leaf icons live
 * in `file-icons.tsx`. All inherit `currentColor` so they follow the row's tint.
 */
import { SiMarkdown } from '@icons-pack/react-simple-icons'
import { ChevronRight, Folder } from 'lucide-react'

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={12}
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
    />
  )
}

export function FolderIcon() {
  return <Folder size={14} aria-hidden="true" />
}

export function MarkdownIcon() {
  return <SiMarkdown size={14} color="currentColor" aria-hidden="true" />
}
