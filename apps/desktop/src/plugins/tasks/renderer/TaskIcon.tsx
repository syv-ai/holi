/** A task file's glyph, keyed to its status: an empty circle for todo, a
 *  dotted one for doing, a checked one for done.
 *
 *  **The colours are the `--task-*` tokens, not hex**, the same ones the
 *  editor's link orbs for a task use, so a vault theme recolours both at
 *  once. */
import { Circle, CircleCheck, CircleDot } from 'lucide-react'
import { Icon } from '@/primitives'
import type { TaskStatus } from '../shared/types'

export function TaskIcon({ status }: { status: TaskStatus }): React.JSX.Element {
  if (status === 'done') return <Icon icon={CircleCheck} size="sm" className="text-task-done" />
  if (status === 'doing') return <Icon icon={CircleDot} size="sm" className="text-task-doing" />
  return <Icon icon={Circle} size="sm" className="text-task-todo" />
}
