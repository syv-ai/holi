/**
 * New task, from the toolbar or a column's +: a title, a description, and the
 * task's fields as a row of chips (`TaskFields`). Written in one create, one
 * file, in the chosen project's folder (the vault root without one).
 */
import { useState } from "react"
import type { StatusDef, Task } from "@holi/shared"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { TaskFields, type TaskFieldValues } from "./task-fields"

export type NewTaskInput = {
  title: string
  status: string
  folder: string
  description?: string
  extra: Partial<
    Pick<Task, "priority" | "start" | "due" | "estimate" | "tags" | "assignees">
  >
}

function emptyDraft(status: string, folder: string): TaskFieldValues {
  return { status, assignees: [], tags: [], folder }
}

export function NewTaskDialog({
  open,
  onOpenChange,
  statuses,
  defaultStatus,
  defaultFolder = "",
  today,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  statuses: readonly StatusDef[]
  defaultStatus: string
  defaultFolder?: string
  today: string
  onCreate: (input: NewTaskInput) => Promise<void>
}) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [fields, setFields] = useState(() =>
    emptyDraft(defaultStatus, defaultFolder)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setTitle("")
    setDescription("")
    setFields(emptyDraft(defaultStatus, defaultFolder))
    setError(null)
  }

  const submit = async () => {
    if (title.trim() === "") return
    setBusy(true)
    setError(null)
    const { status, folder, assignees, tags, priority, due, start, estimate } =
      fields
    try {
      await onCreate({
        title: title.trim(),
        status,
        folder,
        ...(description.trim() !== ""
          ? { description: description.trim() }
          : {}),
        extra: {
          ...(priority !== undefined ? { priority } : {}),
          ...(start !== undefined ? { start } : {}),
          ...(due !== undefined ? { due } : {}),
          ...(estimate !== undefined ? { estimate } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(assignees.length > 0 ? { assignees } : {}),
        },
      })
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              Saved as a task file in the vault.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="new-task-title" className="sr-only">
                Title
              </FieldLabel>
              <Input
                id="new-task-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Task title"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-task-description" className="sr-only">
                Description
              </FieldLabel>
              <Textarea
                id="new-task-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Add a description (optional)"
                className="min-h-24"
              />
            </Field>
            <TaskFields
              values={fields}
              statuses={statuses}
              today={today}
              onChange={(change) =>
                setFields((current) => ({
                  ...current,
                  [change.field]: change.value,
                }))
              }
            />
            {error !== null ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || title.trim() === ""}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
