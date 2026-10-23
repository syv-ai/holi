/**
 * New task, from the toolbar: a title and the fields worth setting before a
 * task exists. Written in one create, one file, in the vault root; anything
 * else is set on the task itself once it is open.
 */
import { useState } from "react"
import type { Priority, StatusDef, Task } from "@holi/shared"
import { isEstimate } from "@holi/shared"

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PRIORITIES } from "@/lib/planning"
import { StatusDot } from "./task-bits"

const NO_PRIORITY = "none"

export type NewTaskInput = {
  title: string
  status: string
  extra: Partial<Pick<Task, "priority" | "start" | "due" | "estimate">>
}

export function NewTaskDialog({
  open,
  onOpenChange,
  statuses,
  defaultStatus,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  statuses: readonly StatusDef[]
  defaultStatus: string
  onCreate: (input: NewTaskInput) => Promise<void>
}) {
  const [title, setTitle] = useState("")
  const [status, setStatus] = useState(defaultStatus)
  const [priority, setPriority] = useState<string>(NO_PRIORITY)
  const [start, setStart] = useState("")
  const [due, setDue] = useState("")
  const [estimate, setEstimate] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setTitle("")
    setStatus(defaultStatus)
    setPriority(NO_PRIORITY)
    setStart("")
    setDue("")
    setEstimate("")
    setError(null)
  }

  const estimateBad = estimate.trim() !== "" && !isEstimate(estimate.trim())

  const submit = async () => {
    if (title.trim() === "" || estimateBad) return
    setBusy(true)
    setError(null)
    try {
      await onCreate({
        title: title.trim(),
        status,
        extra: {
          ...(priority !== NO_PRIORITY
            ? { priority: priority as Priority }
            : {}),
          ...(start !== "" ? { start } : {}),
          ...(due !== "" ? { due } : {}),
          ...(estimate.trim() !== "" ? { estimate: estimate.trim() } : {}),
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
      <DialogContent className="sm:max-w-md">
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
              Saved as a task file in the vault. Everything else can be set on
              the task once it is open.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="new-task-title">Title</FieldLabel>
              <Input
                id="new-task-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs doing?"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="new-task-status">Status</FieldLabel>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="new-task-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <StatusDot status={s} />
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-task-priority">Priority</FieldLabel>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id="new-task-priority" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PRIORITY}>No priority</SelectItem>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-task-start">Start</FieldLabel>
                <Input
                  id="new-task-start"
                  type="date"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-task-due">Due</FieldLabel>
                <Input
                  id="new-task-due"
                  type="date"
                  value={due}
                  onChange={(event) => setDue(event.target.value)}
                />
              </Field>
            </div>
            <Field data-invalid={estimateBad || undefined}>
              <FieldLabel htmlFor="new-task-estimate">Estimate</FieldLabel>
              <Input
                id="new-task-estimate"
                value={estimate}
                aria-invalid={estimateBad || undefined}
                onChange={(event) => setEstimate(event.target.value)}
                placeholder="30m, 2h, 1.5d, 1w"
              />
              {estimateBad ? (
                <FieldError>A number and m, h, d or w, like 2d.</FieldError>
              ) : null}
            </Field>
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
            <Button
              type="submit"
              disabled={busy || title.trim() === "" || estimateBad}
            >
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
