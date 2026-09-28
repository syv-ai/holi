/**
 * A card on the board (docs/features/tasks.md).
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
import { cn } from '@/lib/cn'
import { shortStamp } from '@/lib/date-presets'
import {
  Button,
  ConfirmInPlace,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  StrikeText,
  TaskCheck,
  instant,
  settle,
} from '@/primitives'
import { nowAtom, todayAtom } from '@/state/clock'
import { openBesideAtom } from '@/state/panes'
import { deleteTaskAtom, filterAtom, setTaskStatusAtom } from '@/state/tasks'
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

/** A label or tag that filters the board by itself: the dock's Tags filter,
 *  toggled. Its own click, so it does not open the card. */
function FilterWord({
  word,
  onFilter,
  className,
  children,
}: {
  word: string
  onFilter?: (word: string) => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  if (!onFilter) return <span className={className}>{children}</span>
  return (
    <Button
      variant="ghost"
      size="xs"
      data-filter-word={word}
      onClick={(event) => {
        event.stopPropagation()
        onFilter(word)
      }}
      className={cn(
        'h-auto rounded-sm px-0 text-[11px] font-normal text-inherit active:scale-100 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </Button>
  )
}

/** A card's meta line: due, labels, tags. Quick add draws its preview with it;
 *  on the board, `onFilter` makes each label and tag filter by itself. */
export function TaskMeta({
  task,
  onFilter,
}: {
  task: Task
  onFilter?: (word: string) => void
}): React.JSX.Element | null {
  const now = useAtomValue(nowAtom)
  const reduced = useReducedMotion() ?? false
  const labels = virtualLabels(task, now)
  if (!task.due && labels.length === 0 && task.tags.length === 0) return null
  return (
    <div className="mt-1 flex h-4 items-center gap-x-2 overflow-hidden text-[11px] whitespace-nowrap text-muted-foreground">
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
        <FilterWord key={label} word={label} onFilter={onFilter} className={LABEL_TONE[label]}>
          {label}
        </FilterWord>
      ))}
      {task.tags.map((tag) => (
        <FilterWord key={tag} word={tag} onFilter={onFilter}>
          #{tag}
        </FilterWord>
      ))}
    </div>
  )
}

export function BoardCard({
  task,
  shown,
  drag,
  parking,
  arrival,
}: {
  task: Task
  /** The column the card is drawn in: its status, or where it is parked
   *  while its check plays. Its look follows this, not the file. */
  shown: TaskStatus
  drag: Drag
  parking: Parking
  /** Set only while this card is new to the board (`useArrivals`). */
  arrival?: { className?: string; style?: { animationDelay: string } }
}): React.JSX.Element {
  const today = useAtomValue(todayAtom)
  const setStatus = useSetAtom(setTaskStatusAtom)
  const open = useSetAtom(openBesideAtom)
  const remove = useSetAtom(deleteTaskAtom)
  const setFilter = useSetAtom(filterAtom)
  const filterBy = (word: string) =>
    setFilter((f) => ({
      ...f,
      tags: f.tags.includes(word) ? f.tags.filter((t) => t !== word) : [...f.tags, word],
    }))
  const reduced = useReducedMotion() ?? false
  const sequence = useCheckSequence(task, today, parking, setStatus)
  const folded = drag.isFolded(task.path)
  const done = shown === 'done'

  // A plain element, not a motion one: motion claims `onDragStart` for its own
  // gesture and never hands it to the DOM, and the board's drag is native.
  const card = (
    <div
      {...drag.source(task)}
      data-task={task.path}
      // A task IS its file: a click opens it beside the board as a preview.
      onClick={() => open(task.path)}
      className={cn(
        // A title never wraps, so a long one never makes a card taller; a card
        // with no due date or tags is one row shorter.
        'group/card cursor-grab rounded-xl px-2.5 py-3 text-xs motion-respond active:cursor-grabbing',
        done ? 'hover:bg-accent' : 'bg-muted/40 hover:bg-muted/70',
        arrival?.className,
      )}
      style={arrival?.style}
    >
      <div className="flex items-start gap-2">
        <TaskCheck
          filled={sequence.filled}
          doing={shown === 'doing'}
          onDrawn={sequence.onDrawn}
          label={`${done ? 'Reopen' : 'Complete'} ${task.title}`}
          onClick={(event) => {
            event.stopPropagation()
            sequence.toggle()
          }}
          className="mt-px"
        />
        <div className="min-w-0 flex-1">
          {/* A px down: the line box centres on the orb, but mixed-case text reads
              high in it. */}
          <div className="relative top-px origin-left truncate leading-4 motion-respond group-hover/card:scale-[1.03]">
            <StrikeText text={task.title} struck={sequence.struck} onStruck={sequence.onStruck} />
          </div>
          <TaskMeta task={task} onFilter={filterBy} />
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
      {/* The space below a card is inside its fold, not a list gap: a gap
          stays open around a card folded to nothing and shuts in one frame
          when the card leaves, jumping everything under it. */}
      <div className="pb-2.5">
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
      </div>
    </motion.div>
  )
}
