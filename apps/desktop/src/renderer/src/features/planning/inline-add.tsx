/*
 * "Add task" at the foot of a column or a group: a quiet button that becomes
 * a one-line title field. Enter adds and stays open for the next one, the way
 * a list is typed in; Escape, or leaving it empty, closes it.
 */
import { useState } from 'react'
import { PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usePlanningVisible } from './planning-visibility'

export type InlineAddState = { open: boolean; title: string; busy: boolean }

export function InlineAdd({
  label,
  onAdd,
  dashed = false,
  focused = true,
  state,
  onStateChange,
}: {
  /** What the button and field are called: "Add task to To do". */
  label: string
  onAdd: (title: string) => Promise<void>
  /** An empty column's add: kanban-board-4's dashed drop-sized button. */
  dashed?: boolean
  focused?: boolean
  state?: InlineAddState
  onStateChange?: (state: InlineAddState) => void
}) {
  const visible = usePlanningVisible()
  const [localState, setLocalState] = useState<InlineAddState>({
    open: false,
    title: '',
    busy: false,
  })
  const current = state ?? localState
  const { open, title, busy } = current
  const update = (patch: Partial<InlineAddState>) => {
    const next = { ...current, ...patch }
    setLocalState(next)
    onStateChange?.(next)
  }

  if (!open && dashed) {
    return (
      <Button
        type="button"
        variant="dashed"
        size="lg"
        className="w-full"
        aria-label={label}
        onClick={() => update({ open: true })}
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
        onClick={() => update({ open: true })}
      >
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        Add task
      </Button>
    )
  }

  const submit = async () => {
    const text = title.trim()
    if (text === '') return update({ open: false })
    update({ busy: true })
    try {
      await onAdd(text)
      update({ title: '' })
    } finally {
      update({ busy: false })
    }
  }

  return (
    <Input
      autoFocus={visible && focused}
      aria-label={label}
      placeholder="Task title"
      value={title}
      readOnly={busy}
      onChange={(event) => update({ title: event.target.value })}
      onBlur={() => {
        if (title.trim() === '') update({ open: false })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void submit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          update({ title: '', open: false })
        }
      }}
    />
  )
}
