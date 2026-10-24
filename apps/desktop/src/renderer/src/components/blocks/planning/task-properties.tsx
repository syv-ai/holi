/**
 * An open task's fields, above its body: the same chips as New task, each
 * change written to the file at once. Draws nothing for a document that is
 * not a task.
 *
 * Every write first saves what the editor has pending (`beforeWrite`): the
 * editor writes the file whole, frontmatter included, so a save still queued
 * from before the change would put the old fields back. A new project moves
 * the file, and `onMoved` lets whatever shows it follow the new path.
 */
import type { Task } from "@holi/shared"
import { useAtomValue, useSetAtom } from "jotai"
import { toast } from "sonner"

import { cn } from "@/lib/cn"
import { todayAtom } from "@/state/clock"
import { statusesAtom } from "@/state/planning"
import { moveTaskAtom, patchTaskAtom, tasksAtom } from "@/state/tasks"
import {
  folderOf,
  TaskFields,
  type TaskFieldChange,
  type TaskFieldValues,
} from "./task-fields"

function valuesOf(task: Task): TaskFieldValues {
  return {
    status: task.status,
    assignees: task.assignees,
    priority: task.priority,
    due: task.due,
    start: task.start,
    tags: task.tags,
    folder: folderOf(task.path),
    estimate: task.estimate,
  }
}

/** A change as the file's patch: a cleared field is `null`, a cleared list
 *  is empty. */
function patchOf(change: TaskFieldChange): Record<string, unknown> {
  return { [change.field]: change.value ?? null }
}

export function TaskProperties({
  path,
  beforeWrite,
  onMoved,
  className,
}: {
  path: string
  beforeWrite: () => Promise<void>
  onMoved?: (from: string, to: string) => void
  className?: string
}) {
  const task = useAtomValue(tasksAtom).get(path)
  const statuses = useAtomValue(statusesAtom)
  const today = useAtomValue(todayAtom)
  const patch = useSetAtom(patchTaskAtom)
  const move = useSetAtom(moveTaskAtom)
  if (task === undefined) return null

  const write = async (change: TaskFieldChange) => {
    try {
      await beforeWrite()
      if (change.field === "folder") {
        if (change.value === folderOf(path)) return
        const to = await move(path, change.value)
        if (to !== null && to !== path) onMoved?.(path, to)
      } else {
        await patch(path, patchOf(change))
      }
    } catch (err) {
      toast.error("The task could not be saved", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <TaskFields
      values={valuesOf(task)}
      statuses={statuses}
      today={today}
      onChange={(change) => void write(change)}
      className={cn(className)}
    />
  )
}
