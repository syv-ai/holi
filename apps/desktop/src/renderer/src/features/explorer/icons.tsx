/**
 * The tree's structural icons: the expand chevron, the folder glyph, and the
 * markdown glyph used by the new-file pending row. Per-file-type leaf icons live
 * in `file-icons.tsx`. All inherit `currentColor` so they follow the row's tint.
 */
import type { TaskStatus } from '@holi/shared'
import { SiMarkdown } from '@icons-pack/react-simple-icons'
import { AppWindow, ChevronRight, Folder, Square, SquareCheck, SquareDot } from 'lucide-react'

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

/** A vault app's own folder. An app is a thing you run, not a place you keep
 *  files, and now that Edit Source reveals `.holi/apps/<id>/` in the tree (#18)
 *  the folder is somewhere people actually look. Same glyph as the app rows in
 *  the apps section, so one icon means "app" wherever it appears. */
export function AppFolderIcon() {
  return <AppWindow size={14} aria-hidden="true" />
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
