/**
 * The tree's structural icons: the expand chevron, the folder glyph, and the
 * markdown glyph used by the new-file pending row. Per-file-type leaf icons live
 * in `file-icons.tsx`. All inherit `currentColor` so they follow the row's tint.
 */
import type { TaskStatus } from '@holi/shared'
import { SiMarkdown } from '@icons-pack/react-simple-icons'
import { ChevronRight, Folder, Square, SquareCheck, SquareDot } from 'lucide-react'

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

/** A task file's leaf glyph, keyed to its status so the tree shows progress at a
 * glance: an empty box for todo, a dotted box for doing, a checked box for done —
 * tinted apart from the markdown/file icons so a `task.*.md` reads as a task. */
export function TaskIcon({ status }: { status: TaskStatus }) {
  if (status === 'done') return <SquareCheck size={14} color="#34d399" aria-hidden="true" />
  if (status === 'doing') return <SquareDot size={14} color="#fbbf24" aria-hidden="true" />
  return <Square size={14} color="#90a4ae" aria-hidden="true" />
}
