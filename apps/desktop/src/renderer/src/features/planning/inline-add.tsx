/*
 * "Add task" at the foot of a column or a group: a quiet button that becomes
 * a one-line title field. Enter adds and stays open for the next one, the way
 * a list is typed in; Escape, or leaving it empty, closes it.
 */
import { useRef, useState } from 'react'
import { PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usePlanningVisible } from './planning-visibility'
import { useVimField } from '@/hooks/use-vim-field'
import { VimFieldMode } from '@/composites/vim-field-mode'

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
  const currentRef = useRef(current)
  currentRef.current = current
  const { open, title, busy } = current
  const vim = useVimField('planning-inline-add', title)
  const update = (patch: Partial<InlineAddState>) => {
    const next = { ...currentRef.current, ...patch }
    currentRef.current = next
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
    const latest = currentRef.current
    if (latest.busy) return
    const text = latest.title.trim()
    if (text === '') return update({ open: false })
    update({ busy: true })
    try {
      await onAdd(text)
      update({ title: '' })
    } catch {
      // Keep the draft so the person can retry after a failed add.
    } finally {
      update({ busy: false })
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Input
        autoFocus={visible && focused}
        aria-label={label}
        placeholder="Task title"
        value={title}
        {...vim.vimFieldProps}
        readOnly={busy}
        onChange={(event) => update({ title: event.target.value })}
        onBlur={(event) => {
          vim.vimFieldProps.onBlur?.(event)
          if (title.trim() === '') update({ open: false })
        }}
        onKeyDown={(event) => {
          vim.vimFieldProps.onKeyDown?.(event)
          if (event.defaultPrevented || event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            update({ title: '', open: false })
          }
        }}
      />
      <VimFieldMode mode={vim.vimFieldMode} />
    </div>
  )
}
