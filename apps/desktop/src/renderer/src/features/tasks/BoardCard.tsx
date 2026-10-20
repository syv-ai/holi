/**
 * A card on the board (docs/features/tasks.md), a ReUI kanban item: the whole
 * card is its drag handle (a press that moves 10px starts a drag; one that does
 * not is a click, which opens the task beside the board).
 *
 * Completing it fills its check at once, before the write; the card moves to
 * Done when the vault re-reads. A recurring task rolls forward instead: its
 * check empties again and its due date moves.
 */
import type { Task } from '@holi/shared'
import { virtualLabels } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { shortStamp } from '@/lib/date-presets'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  KanbanItem,
  KanbanItemHandle,
  TaskCheck,
} from '@/primitives'
import { nowAtom } from '@/state/clock'
import { openBesideAtom } from '@/state/panes'
import { deleteTaskAtom, filterAtom, setTaskStatusAtom, togglePerson } from '@/state/tasks'
import { ConfirmDelete } from './ConfirmDelete'

/** Signal labels are coloured text on no background (never a tint of their
 *  own hue); tags are plain muted text. Named palette utilities, so the gate
 *  allows them: a deliberate set with no semantic-token equivalent. */
const LABEL_TONE: Record<string, string> = {
  overdue: 'text-red-400',
  p1: 'text-orange-400',
  p2: 'text-amber-700 dark:text-amber-400',
}

/** A label or tag that filters the board by itself: the toolbar's Tags
 *  filter, toggled. Its own click, so it does not open the card. */
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
        'h-auto rounded-sm px-0 text-xs font-normal text-inherit active:scale-100 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </Button>
  )
}

/** A card's meta line: due, labels, assignees, tags. Quick add draws its preview with it;
 *  on the board, `onFilter` makes each label and tag filter by itself. */
export function TaskMeta({
  task,
  onFilter,
  onFilterPerson,
}: {
  task: Task
  onFilter?: (word: string) => void
  /** Filters by an assignee, as `onFilter` does by a label or tag. */
  onFilterPerson?: (login: string) => void
}): React.JSX.Element | null {
  const now = useAtomValue(nowAtom)
  const labels = virtualLabels(task, now)
  if (!task.due && labels.length === 0 && task.tags.length === 0 && task.assignees.length === 0) {
    return null
  }
  return (
    <div className="mt-1 flex h-4 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
      {task.due && (
        <span>
          {task.recurrence ? '↻ ' : ''}
          {shortStamp(task.due)}
        </span>
      )}
      {labels.map((label) => (
        <FilterWord key={label} word={label} onFilter={onFilter} className={LABEL_TONE[label]}>
          {label}
        </FilterWord>
      ))}
      {task.assignees.map((login) => (
        <FilterWord key={`@${login}`} word={login} onFilter={onFilterPerson}>
          @{login}
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

/** The card itself: what the board shows and what follows the pointer while
 *  it is dragged (`overlay`, which has no actions). */
export function CardFace({
  task,
  filled,
  onToggle,
  actions,
}: {
  task: Task
  filled: boolean
  onToggle?: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  const setFilter = useSetAtom(filterAtom)
  const filterBy = (word: string) =>
    setFilter((f) => ({
      ...f,
      tags: f.tags.includes(word) ? f.tags.filter((t) => t !== word) : [...f.tags, word],
    }))
  const filterByPerson = (login: string) => setFilter((f) => togglePerson(f, login))
  const done = task.status === 'done'
  return (
    <div className="group/card flex items-start gap-2 rounded-lg bg-background p-2.5 text-xs shadow-xs motion-respond hover:bg-accent/50">
      <TaskCheck
        filled={filled}
        doing={task.status === 'doing'}
        label={`${done ? 'Reopen' : 'Complete'} ${task.title}`}
        onClick={(event) => {
          event.stopPropagation()
          onToggle?.()
        }}
        className="mt-px"
      />
      <div className="min-w-0 flex-1">
        {/* A title never wraps, so a long one never makes a card taller. */}
        <div
          className={cn(
            'truncate text-sm leading-4',
            filled ? 'text-muted-foreground line-through' : 'text-foreground',
          )}
        >
          {task.title}
        </div>
        <TaskMeta task={task} onFilter={filterBy} onFilterPerson={filterByPerson} />
      </div>
      {actions}
    </div>
  )
}

export function BoardCard({ task }: { task: Task }): React.JSX.Element {
  const setStatus = useSetAtom(setTaskStatusAtom)
  const open = useSetAtom(openBesideAtom)
  const remove = useSetAtom(deleteTaskAtom)
  /** The check's state between a click and the re-read that follows it. */
  const [checked, setChecked] = useState<boolean | null>(null)
  const [confirming, setConfirming] = useState(false)
  const done = task.status === 'done'
  const filled = checked ?? done

  const toggle = () => {
    const next = !filled
    setChecked(next)
    void setStatus(task.path, next ? 'done' : 'todo').finally(() => setChecked(null))
  }

  return (
    <KanbanItem value={task.path} data-task={task.path}>
      {/* The board's second way to act on a card, besides its ⋯. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <KanbanItemHandle
            // A task IS its file: a click opens it beside the board.
            onClick={() => open(task.path)}
          >
            <CardFace
              task={task}
              filled={filled}
              onToggle={toggle}
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      icon={Ellipsis}
                      label={`Actions for ${task.title}`}
                      tooltip={false}
                      data-card-menu={task.path}
                      onClick={(event) => event.stopPropagation()}
                      quiet
                      className="opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                    />
                  </DropdownMenuTrigger>
                  {/* Portalled, but React bubbles its clicks through the card:
                      they stop before they open it. */}
                  <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                    <DropdownMenuItem onSelect={() => open(task.path)}>Open</DropdownMenuItem>
                    <DropdownMenuItem onSelect={toggle}>
                      {done ? 'Reopen' : 'Complete'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                      Delete…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          </KanbanItemHandle>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => open(task.path)}>Open</ContextMenuItem>
          <ContextMenuItem onSelect={toggle}>{done ? 'Reopen' : 'Complete'}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            Delete…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmDelete
        open={confirming}
        title={`Delete ${task.title}?`}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove(task.path)}
      />
    </KanbanItem>
  )
}
