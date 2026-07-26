/**
 * The tree's icon set, from lucide-react. These thin wrappers keep stable names
 * and a no-arg (or `{open}`) signature so `file-icons.tsx` and the tree don't
 * care that the glyphs are lucide. All inherit `currentColor` (lucide strokes
 * with it), so `file-icons.tsx` can tint them per file type.
 *
 * lucide has no dedicated markdown/pdf/word glyph, so those text-document kinds
 * share `FileText` — the *colour* is the type signal here, per file-icons.tsx.
 */
import { Braces, ChevronRight, Code, File, FileText, Folder, Image, Settings2, Table } from 'lucide-react'

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
  return <FileText size={14} aria-hidden="true" />
}

export function FileIcon() {
  return <File size={14} aria-hidden="true" />
}

export function ImageIcon() {
  return <Image size={14} aria-hidden="true" />
}

export function PdfIcon() {
  return <FileText size={14} aria-hidden="true" />
}

export function DocIcon() {
  return <FileText size={14} aria-hidden="true" />
}

export function BracesIcon() {
  return <Braces size={14} aria-hidden="true" />
}

export function CodeIcon() {
  return <Code size={14} aria-hidden="true" />
}

export function TableIcon() {
  return <Table size={14} aria-hidden="true" />
}

export function ConfigIcon() {
  return <Settings2 size={14} aria-hidden="true" />
}
