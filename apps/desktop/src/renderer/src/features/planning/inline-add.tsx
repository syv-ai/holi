/**
 * "Add task" at the foot of a column or a group: a quiet button that becomes
 * a one-line title field. Enter adds and stays open for the next one, the way
 * a list is typed in; Escape, or leaving it empty, closes it.
 */
import { useState } from "react"
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function InlineAdd({
  label,
  onAdd,
  dashed = false,
}: {
  /** What the button and field are called: "Add task to To do". */
  label: string
  onAdd: (title: string) => Promise<void>
  /** An empty column's add: kanban-board-4's dashed drop-sized button. */
  dashed?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)

  if (!open && dashed) {
    return (
      <Button
        type="button"
        variant="dashed"
        size="lg"
        className="w-full"
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        Add task
      </Button>
    )
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground justify-start"
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        Add task
      </Button>
    )
  }

  const submit = async () => {
    const text = title.trim()
    if (text === "") return setOpen(false)
    setBusy(true)
    try {
      await onAdd(text)
      setTitle("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Input
      autoFocus
      aria-label={label}
      placeholder="Task title"
      value={title}
      readOnly={busy}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={() => {
        if (title.trim() === "") setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          void submit()
        } else if (event.key === "Escape") {
          event.preventDefault()
          setTitle("")
          setOpen(false)
        }
      }}
    />
  )
}
