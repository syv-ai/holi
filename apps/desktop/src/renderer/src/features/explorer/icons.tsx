/**
 * The tree's structural icons: the expand chevron, the folder glyph, and the
 * markdown glyph used by the new-file pending row. Per-file-type leaf icons live
 * in `composites/file-icons.tsx`. All inherit `currentColor` so they follow the row's tint.
 */
import type { TaskStatus } from '@holi/shared'
import {
  AppWindow,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FileText,
  Folder,
} from 'lucide-react'

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={12}
      aria-hidden="true"
      className="motion-respond"
      style={{ transform: open ? 'rotate(90deg)' : 'none' }}
    />
  )
}

export function FolderIcon() {
  return <Folder size={14} aria-hidden="true" />
}

/** A vault app's own folder, which Edit Source reveals in the tree. Same glyph
 *  as the app rows in the apps section, so one icon means "app" everywhere. */
export function AppFolderIcon() {
  return <AppWindow size={14} aria-hidden="true" />
}

export function MarkdownIcon() {
  return <FileText size={14} color="currentColor" aria-hidden="true" />
}

/** A task file's leaf glyph, keyed to its status: an empty circle for todo, a
 * dotted one for doing, a checked one for done.
 *
 * **The colours are the `--task-*` tokens, not hex**, the same ones the
 * editor's task orbs use, so a vault theme recolours both at once (D64). */
export function TaskIcon({ status }: { status: TaskStatus }) {
  if (status === 'done')
    return <CircleCheck size={14} color="var(--task-done)" aria-hidden="true" />
  if (status === 'doing')
    return <CircleDot size={14} color="var(--task-doing)" aria-hidden="true" />
  return <Circle size={14} color="var(--task-todo)" aria-hidden="true" />
}
