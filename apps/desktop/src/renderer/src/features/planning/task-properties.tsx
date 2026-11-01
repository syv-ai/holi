/**
 * An open task's properties: the same fields as New task, labelled, each
 * change written to the file at once. Where they sit is the person's
 * `propertiesLayout`: `inline`, a collapsible Properties section of two
 * columns of rows above the text, or `sidebar`, stacked in a panel beside it.
 * Draws nothing for a document that is not a task.
 *
 * Every write first saves what the editor has pending (`beforeWrite`): the
 * editor writes the file whole, frontmatter included, so a save still queued
 * from before the change would put the old fields back. A new project moves
 * the file, and so does Sharing (a private task is its `.local.` file), and
 * `onMoved` lets whatever shows it follow the new path. Making a task private
 * asks first: it leaves every teammate's board (docs/features/tasks.md).
 */
import { useState } from 'react'
import { isPrivateTask, type PropertiesLayout, type Task } from '@holi/shared'
import { ChevronDownIcon } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { cn } from '@/lib/cn'
import { todayAtom } from '@/state/clock'
import { parentOf } from '@/lib/tree-paths'
import { statusesAtom } from '@/state/planning'
import {
  makeTaskPrivateAtom,
  moveTaskAtom,
  patchTaskAtom,
  shareTaskAtom,
  tasksAtom,
} from '@/state/tasks'
import { TaskFields, type TaskFieldChange, type TaskFieldValues } from './task-fields'

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

/** Whether a document has properties to show: whether it is a task. */
export function useHasTaskProperties(path: string): boolean {
  return useAtomValue(tasksAtom).has(path)
}

export function TaskProperties({
  path,
  layout,
  beforeWrite,
  onMoved,
  className,
}: {
  path: string
  layout: PropertiesLayout
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
  /** The inline section's fold, for as long as the document is open. */
  const [open, setOpen] = useState(true)
  if (task === undefined) return null

  const fail = (err: unknown) =>
    toast.error('The task could not be saved', {
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
      if (change.field === 'shared') {
        if (change.value === !isPrivateTask(path)) return
        if (change.value) await renamed(() => share(path))
        else setAsking(true)
        return
      }
      await beforeWrite()
      if (change.field === 'folder') {
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

  const fields = (
    <TaskFields
      values={valuesOf(task)}
      statuses={statuses}
      today={today}
      onChange={(change) => void write(change)}
      layout={layout === 'sidebar' ? 'stacked' : 'rows'}
      // A row's tint reaches past the text's edge, and its words sit on it.
      className={layout === 'sidebar' ? undefined : '-mx-2'}
    />
  )

  return (
    <>
      {layout === 'sidebar' ? (
        <aside
          aria-label="Properties"
          className={cn(
            'bg-sidebar flex w-72 shrink-0 flex-col gap-3 overflow-y-auto px-4 py-5',
            className,
          )}
        >
          <h2 className="text-muted-foreground text-xs font-medium">Properties</h2>
          {fields}
        </aside>
      ) : (
        <div className={className}>
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="text" size="inline" className="text-muted-foreground mb-1 text-xs">
                <ChevronDownIcon
                  aria-hidden="true"
                  className="motion-respond group-data-[state=closed]/button:-rotate-90"
                />
                Properties
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>{fields}</CollapsibleContent>
          </Collapsible>
        </div>
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Make this task private?"
        description={`${task.title} will stay on this machine only. It leaves every teammate’s board the next time they sync. Git history keeps the shared version, so anyone with the vault can still find it there. Links to it from shared notes stop resolving.`}
        confirmLabel="Make private"
        cancelLabel="Keep it shared"
        onConfirm={() => void renamed(() => makePrivate(path)).catch(fail)}
      />
    </>
  )
}
