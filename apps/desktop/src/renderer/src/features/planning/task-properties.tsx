/**
 * An open task's fields, above its body: the same chips as New task, each
 * change written to the file at once. Draws nothing for a document that is
 * not a task.
 *
 * Every write first saves what the editor has pending (`beforeWrite`): the
 * editor writes the file whole, frontmatter included, so a save still queued
 * from before the change would put the old fields back. A new project moves
 * the file, and so does Sharing (a private task is its `.local.` file), and
 * `onMoved` lets whatever shows it follow the new path. Making a task private
 * asks first: it leaves every teammate's board (docs/features/tasks.md).
 */
import { useState } from "react"
import { isPrivateTask, type Task } from "@holi/shared"
import { useAtomValue, useSetAtom } from "jotai"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/cn"
import { todayAtom } from "@/state/clock"
import { parentOf } from "@/lib/tree-paths"
import { statusesAtom } from "@/state/planning"
import {
  makeTaskPrivateAtom,
  moveTaskAtom,
  patchTaskAtom,
  shareTaskAtom,
  tasksAtom,
} from "@/state/tasks"
import {
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
    folder: parentOf(task.path),
    estimate: task.estimate,
    shared: !isPrivateTask(task.path),
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
  const share = useSetAtom(shareTaskAtom)
  const makePrivate = useSetAtom(makeTaskPrivateAtom)
  /** Make private, waiting for its answer. */
  const [asking, setAsking] = useState(false)
  if (task === undefined) return null

  const fail = (err: unknown) =>
    toast.error("The task could not be saved", {
      description: err instanceof Error ? err.message : String(err),
    })

  /** A rename that gives the task a new path, followed by whatever shows it. */
  const renamed = async (rename: () => Promise<string | null>) => {
    await beforeWrite()
    const to = await rename()
    if (to !== null && to !== path) onMoved?.(path, to)
  }

  const write = async (change: TaskFieldChange) => {
    try {
      if (change.field === "shared") {
        if (change.value === !isPrivateTask(path)) return
        if (change.value) await renamed(() => share(path))
        else setAsking(true)
        return
      }
      await beforeWrite()
      if (change.field === "folder") {
        if (change.value === parentOf(path)) return
        const to = await move(path, change.value)
        if (to !== null && to !== path) onMoved?.(path, to)
      } else {
        await patch(path, patchOf(change))
      }
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <TaskFields
        values={valuesOf(task)}
        statuses={statuses}
        today={today}
        onChange={(change) => void write(change)}
        className={cn(className)}
      />
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this task private?</AlertDialogTitle>
            <AlertDialogDescription>
              {task.title} will stay on this machine only. It leaves every
              teammate’s board the next time they sync. Git history keeps the
              shared version, so anyone with the vault can still find it there.
              Links to it from shared notes stop resolving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it shared</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void renamed(() => makePrivate(path)).catch(fail)}
            >
              Make private
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
