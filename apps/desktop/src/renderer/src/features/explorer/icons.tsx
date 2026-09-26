/**
 * The tree's task glyph. Per-file-type leaf icons live in
 * `composites/file-icons.tsx`.
 */
import type { TaskStatus } from '@holi/shared'
import { Circle, CircleCheck, CircleDot } from 'lucide-react'

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
