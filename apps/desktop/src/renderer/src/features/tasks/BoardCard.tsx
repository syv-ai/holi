/**
 * A card on the board (docs/features/tasks.md), and the new-card field a
 * column's `+` grows into.
 *
 * **Tinted, borderless.** The column is `--card`, a card `--muted` a step
 * lighter; nothing draws an edge. A done card recedes to a flat row, so
 * finished work stops competing with open work.
 *
 * **Its moving parts** are the board's: it folds away while dragged
 * (`useBoardDrag`), springs to a new place when its neighbours change, and
 * flies to its new column when its check releases it (`layoutId`, the path).
 */
import type { Task, TaskStatus } from '@holi/shared'
import { virtualLabels } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { shortStamp } from '@/lib/date-presets'
import {
  ConfirmInPlace,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Input,
  StrikeText,
  TaskCheck,
  instant,
  settle,
} from '@/primitives'
import { nowAtom, todayAtom } from '@/state/clock'
import { openBesideAtom } from '@/state/panes'
import { deleteTaskAtom, setTaskStatusAtom } from '@/state/tasks'
import { useCheckSequence, type Parking } from './use-check-sequence'
import type { useBoardDrag } from './use-board-drag'

type Drag = ReturnType<typeof useBoardDrag>

/** Signal labels are coloured text on no background (never a tint of their
 *  own hue); tags are plain muted text. Named palette utilities, so the gate
 *  allows them: a deliberate set with no semantic-token equivalent. */
const LABEL_TONE: Record<string, string> = {
  overdue: 'text-red-400',
  p1: 'text-orange-400',
  p2: 'text-amber-400',
}

function Meta({ task }: { task: Task }): React.JSX.Element | null {
  const now = useAtomValue(nowAtom)
  const reduced = useReducedMotion() ?? false
  const labels = virtualLabels(task, now)
  if (!task.due && labels.length === 0 && task.tags.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
      {task.due && (
        // Keyed by the date, so a recurring task rolling forward shows the
        // new date arriving rather than a silent swap.
        <motion.span
          key={task.due}
          initial={reduced ? false : { y: -6, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={reduced ? instant : settle}
        >
          {task.recurrence ? '↻ ' : ''}
          {shortStamp(task.due)}
        </motion.span>
      )}
      {labels.map((label) => (
        <span key={label} className={LABEL_TONE[label]}>
          {label}
        </span>
      ))}
      {task.tags.map((tag) => (
        <span key={tag}>#{tag}</span>
      ))}
    </div>
  )
}

export function BoardCard({
  task,
  drag,
  parking,
  arrival,
}: {
  task: Task
  drag: Drag
  parking: Parking
  /** Set only while this card is new to the board (`useArrivals`). */
  arrival?: { className?: string; style?: { animationDelay: string } }
}): React.JSX.Element {
  const today = useAtomValue(todayAtom)
  const setStatus = useSetAtom(setTaskStatusAtom)
  const open = useSetAtom(openBesideAtom)
  const remove = useSetAtom(deleteTaskAtom)
  const reduced = useReducedMotion() ?? false
  const sequence = useCheckSequence(task, today, parking, setStatus)
  const folded = drag.isFolded(task.path)
  const done = task.status === 'done'

  // A plain element, not a motion one: motion claims `onDragStart` for its own
  // gesture and never hands it to the DOM, and the board's drag is native.
  const card = (
    <div
      {...drag.source(task)}
      data-task={task.path}
      // A task IS its file: a click opens it beside the board as a preview.
      onClick={() => open(task.path)}
      className={cn(
        'group/card cursor-grab rounded-xl px-2.5 py-2 text-xs motion-respond active:cursor-grabbing',
        done ? 'hover:bg-accent' : 'bg-muted hover:brightness-110',
        arrival?.className,
      )}
      style={arrival?.style}
    >
      <div className="flex items-start gap-2">
        <TaskCheck
          filled={sequence.filled}
          onDrawn={sequence.onDrawn}
          label={`${done ? 'Reopen' : 'Complete'} ${task.title}`}
          onClick={(event) => {
            event.stopPropagation()
            sequence.toggle()
          }}
          className="mt-px"
        />
        <div className="min-w-0 flex-1">
          <StrikeText
            text={task.title}
            struck={sequence.struck}
            onStruck={sequence.onStruck}
            className="leading-4"
          />
          <Meta task={task} />
        </div>
        <ConfirmInPlace
          label={`Delete ${task.title}`}
          confirmLabel="Delete"
          onConfirm={() => void remove(task.path)}
          className="opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 data-asking:opacity-100"
        />
      </div>
    </div>
  )

  return (
    // Three layers, so no two animations write the same transform: the outer
    // owns position and fold, the middle the flick, the card the drag.
    <motion.div
      layout={reduced ? false : 'position'}
      // Only a card at rest flies: a folded one is mid-drop, and its landing
      // is the gap closing, not a flight from where it was picked up.
      layoutId={folded || reduced ? undefined : task.path}
      transition={reduced ? instant : settle}
      initial={false}
      animate={{ height: folded ? 0 : 'auto', opacity: folded ? 0 : 1 }}
      className={cn('overflow-hidden', folded && 'pointer-events-none')}
    >
      {/* The board's second way to delete, besides the bin; and to open. */}
      <ContextMenu>
        <motion.div {...sequence.flick}>
          <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
        </motion.div>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => open(task.path)}>Open</ContextMenuItem>
          <ContextMenuItem onSelect={() => sequence.toggle()}>
            {done ? 'Reopen' : 'Complete'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => void remove(task.path)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </motion.div>
  )
}

/**
 * The column's new card. It shares a `layoutId` with the column's `+`, so it
 * grows out of the button into the column's first lane; Tab and Shift+Tab move
 * it to the next lane as the same element. Enter adds and stays open for the
 * next; Escape, or leaving it empty, folds it back into the `+`.
 */
export function NewCard({
  status,
  lane,
  layoutId,
  onSubmit,
  onLane,
  onClose,
}: {
  status: TaskStatus
  lane: string
  layoutId: string
  onSubmit: (title: string) => void
  onLane: (step: 1 | -1) => void
  onClose: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const reduced = useReducedMotion() ?? false
  return (
    <motion.div
      layoutId={reduced ? undefined : layoutId}
      transition={reduced ? instant : settle}
      style={{ borderRadius: 12 }}
      data-new-card={status}
      className="bg-muted px-2.5 py-2"
    >
      <Input
        variant="bare"
        autoFocus
        value={title}
        placeholder={`New task in ${lane || 'the vault root'}`}
        aria-label={`New ${status} task`}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && title.trim()) {
            event.preventDefault()
            onSubmit(title.trim())
            setTitle('')
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
          if (event.key === 'Tab') {
            event.preventDefault()
            onLane(event.shiftKey ? -1 : 1)
          }
        }}
        onBlur={() => title === '' && onClose()}
        className="text-xs"
      />
      <p className="mt-1 text-[10px] text-muted-foreground">
        Enter adds · Tab moves lane · Esc closes
      </p>
    </motion.div>
  )
}
