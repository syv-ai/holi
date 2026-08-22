/** The stripped board (prd/tasks.md §Board UX).
 *
 * One layout. Todo / Doing / Done, fixed; one swim lane per folder, because the
 * folder IS the lane. A cell is `(column, lane)`.
 *
 * **Both axes are writes.** Dragging between columns rewrites `status`; dragging
 * between lanes moves the file into that folder and rewrites every inbound
 * `[[wiki-link]]` in the same pass (`tasks.move`); a diagonal does both as one
 * action. The branch is decided by `dropIntent`.
 *
 * There is no "N excluded" count anywhere, because nothing is hidden into
 * unselected buckets. The empty state distinguishes "no tasks" from "nothing
 * matches".
 */
import type { Task, TaskStatus } from '@holi/shared'
import { virtualLabels } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Input, Tooltip } from '@/primitives'
import { shortStamp } from '@/lib/date-presets'
import { cn } from '@/lib/cn'
import { reorderRank, sortCell } from '@/lib/board-order'
import { FilterBar } from './FilterBar'
import { TaskDetailPanel } from './TaskDetail'
import {
  ROOT_LANE,
  brokenTasksAtom,
  completeTaskAtom,
  createTaskAtom,
  dropIntent,
  filterAtom,
  laneLabel,
  laneOf,
  laneOrder,
  matchesFilter,
  moveTaskAtom,
  nowAtom,
  patchTaskAtom,
  selectedTaskPathAtom,
  setTaskStatusAtom,
  tasksAtom,
} from '@/state/tasks'

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
]

/** Virtual labels get a colour; a task's own tags stay neutral. The chip is the same
 * shape either way — they read as one vocabulary. A deliberate colour-coded set with
 * no semantic-token equivalents (named palette utilities, so the gate allows them). */
const CHIP: Record<string, string> = {
  overdue: 'bg-red-950 text-red-300 border-red-900',
  p1: 'bg-orange-950 text-orange-300 border-orange-900',
  p2: 'bg-amber-950/70 text-amber-300 border-amber-900',
  p3: 'bg-neutral-800 text-neutral-400 border-neutral-700',
}

function Card({
  task,
  cue,
}: {
  task: Task
  /** A same-cell drag is aimed here: draw the rule it would land on. */
  cue?: 'before' | 'after' | null
}): React.JSX.Element {
  const now = useAtomValue(nowAtom)
  const complete = useSetAtom(completeTaskAtom)
  const select = useSetAtom(selectedTaskPathAtom)

  const labels = virtualLabels(task, now)

  return (
    <div
      draggable
      data-task={task.path}
      // The dragged path rides the drag itself, not React state: the drop handler
      // looks the task up by path (its lane and status), so dataTransfer is the
      // whole payload — no companion state to keep in sync.
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.path)
      }}
      onClick={() => select(task.path)}
      // No border, no fill. A board of forty tasks was forty drawn boxes inside
      // twelve more; the text and its checkbox are enough to say where one task
      // ends. The hover tint stays — it is the only thing left that says this
      // row is a target you can pick up.
      className={cn(
        'cursor-grab rounded-md p-2 text-xs hover:bg-muted/40 active:cursor-grabbing',
        cue === 'before' && 'border-t-2 border-t-primary',
        cue === 'after' && 'border-b-2 border-b-primary',
      )}
    >
      <div className="flex items-start gap-2">
        {/* The card's ONE affordance. Completion goes through tasks.complete, so a
            recurring task ROLLS FORWARD rather than persisting `done`. */}
        <Checkbox
          checked={task.status === 'done'}
          onCheckedChange={() => void complete(task.path)}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 shrink-0"
          aria-label={`Complete ${task.title}`}
        />
        <span className={task.status === 'done' ? 'text-muted-foreground line-through' : ''}>
          {task.title}
        </span>
      </div>

      {(labels.length > 0 || task.tags.length > 0 || task.due) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6">
          {/* Humanised, not raw: a due date may carry a time now, and
              `due 2026-08-03T09:00` on a card is a stamp, not a date. */}
          {task.due && (
            <span className="text-[10px] text-muted-foreground">due {shortStamp(task.due)}</span>
          )}
          {labels.map((l) => (
            <span key={l} className={cn('rounded border px-1 text-[10px]', CHIP[l])}>
              {l}
            </span>
          ))}
          {task.tags.map((t) => (
            <span
              key={t}
              className="rounded border border-border bg-secondary px-1 text-[10px] text-secondary-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Add a task to one cell — so it carries both axes, the column's status and the
 * lane's folder.
 *
 * **Summoned by the column header's `+`, not resident in the cell.** It used to
 * sit in all of them at once: one input per (column, lane), so a board with five
 * folders drew fifteen empty fields whose only job was to be available. The
 * control moved to the header; what it reveals is still one input per cell,
 * because the cell is what says which folder the task lands in — a single field
 * under the header would have to pick a folder silently, and the board's whole
 * claim is that the lane IS the folder.
 */
function QuickAdd({
  status,
  folder,
  autoFocus,
  onCancel,
}: {
  status: TaskStatus
  folder: string
  /** The column's first lane takes the caret when the header opens the row. */
  autoFocus?: boolean
  onCancel: () => void
}): React.JSX.Element {
  const create = useSetAtom(createTaskAtom)
  const [title, setTitle] = useState('')

  // Enter submits — replaces the old <form onSubmit> (a native <form> is not a
  // primitive; the keydown handler is the same behaviour without the element).
  const submit = () => {
    const t = title.trim()
    if (!t) return
    setTitle('')
    void create({ title: t, status, folder })
  }

  return (
    <Input
      value={title}
      autoFocus={autoFocus}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
        // Escape puts the row away again — the same key that closes the detail
        // panel, and the only way out that does not need the mouse.
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      placeholder="task title"
      className="h-auto border-transparent bg-transparent px-1 py-0.5 text-xs shadow-none hover:border-input focus-visible:border-ring"
    />
  )
}

/**
 * Task files that would not parse.
 *
 * Shown as a strip rather than as cards in a column, because an unparseable file
 * has no `status` to place it by — inventing one would be the same guess the
 * parser just refused to make. Never hidden: a task missing from the board is
 * indistinguishable from data loss, and the model will occasionally write bad
 * frontmatter.
 */
function BrokenStrip(): React.JSX.Element | null {
  const broken = useAtomValue(brokenTasksAtom)
  if (broken.length === 0) return null

  return (
    <div className="mx-3 mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs">
      <p className="mb-1 font-medium text-destructive">
        {broken.length} task {broken.length === 1 ? 'file' : 'files'} could not be read
      </p>
      {broken.map((b) => (
        <div key={b.path} data-broken-task={b.path} className="text-[11px] text-destructive/90">
          <span className="font-mono">{b.path}</span> — {b.error}
        </div>
      ))}
    </div>
  )
}

export function BoardView(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar />
      <BrokenStrip />
      <div className="flex min-h-0 flex-1">
        <Grid />
        <TaskDetailPanel />
      </div>
    </div>
  )
}

function Grid(): React.JSX.Element {
  const tasks = useAtomValue(tasksAtom)
  const setStatus = useSetAtom(setTaskStatusAtom)
  const patch = useSetAtom(patchTaskAtom)
  const move = useSetAtom(moveTaskAtom)
  const filter = useAtomValue(filterAtom)
  const now = useAtomValue(nowAtom)
  /** Which column is currently showing its quick-add row, if any. */
  const [adding, setAdding] = useState<TaskStatus | null>(null)
  /** The cell under a drag, `status:lane`. With the cells' own borders and fill
   *  gone, this is the only thing that says where a card would land. */
  const [over, setOver] = useState<string | null>(null)
  /** `path:before` / `path:after` — where a same-cell drop would insert. Drawn
   *  as a rule on the card being aimed at, because a card cannot show a gap
   *  that is not there yet. */
  const [overCard, setOverCard] = useState<string | null>(null)

  const everything = [...tasks.values()]
  const all = everything.filter((t) => matchesFilter(t, filter, now))
  const lanes = laneOrder(all.map(laneOf))

  // "hide done" drops the whole Done column, not just its cards — an empty
  // column that can never fill reads as a layout bug, not a filter.
  const columns = filter.hideDone ? COLUMNS.filter((c) => c.status !== 'done') : COLUMNS
  // The lane column is sized to be read, not to hold a path: the label wraps
  // rather than truncating, so a long folder name costs a second line instead of
  // an ellipsis and a tooltip.
  const gridTemplateColumns = `5rem repeat(${columns.length}, minmax(0, 1fr))`

  const cell = (lane: string, status: TaskStatus) =>
    sortCell(all.filter((t) => t.status === status && laneOf(t) === lane))

  // Both axes are live now: a same-lane drop rewrites status, a cross-lane drop
  // moves the file (+ link rewrite), and a diagonal does both in one call. The
  // dragged task is looked up by path, so the drop knows its current lane/status.
  const drop = (e: React.DragEvent, lane: string, status: TaskStatus) => {
    setOver(null)
    setOverCard(null)
    const path = e.dataTransfer.getData('text/plain')
    const task = tasks.get(path)
    if (!task) return

    // Dropped ON a card, in the cell it already lives in: this is a reorder, and
    // the axes are unchanged. A drop that crosses a cell falls through to the
    // status/move intent below and keeps whatever rank it had — the card lands
    // where its rank puts it in the new column, which is the honest answer
    // without asking the user to aim twice.
    const onCard = (e.target as HTMLElement).closest?.('[data-task]')
    const targetPath = onCard?.getAttribute('data-task') ?? null
    if (targetPath !== null && task.status === status && laneOf(task) === lane) {
      const box = onCard!.getBoundingClientRect()
      const rank = reorderRank(
        cell(lane, status),
        path,
        targetPath,
        e.clientY < box.top + box.height / 2,
      )
      if (rank !== null) void patch(path, { order: rank })
      return
    }

    const intent = dropIntent(task, lane, status)
    if (intent.kind === 'status') void setStatus(path, intent.status)
    else if (intent.kind === 'move') void move(path, intent.folder, intent.status)
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      <div className="grid gap-2" style={{ gridTemplateColumns }}>
        <div />
        {columns.map((c) => (
          // The column's add control lives here, at the head of what it adds to,
          // instead of once per cell down the whole column.
          <div
            key={c.status}
            className="flex items-center gap-1 px-1 pb-1 text-xs font-semibold text-foreground"
          >
            {c.label}
            <Tooltip content={`add to ${c.label}`}>
              <Button
                variant="ghost"
                size="icon-xs"
                data-add-column={c.status}
                aria-label={`Add to ${c.label}`}
                className="ml-auto text-muted-foreground hover:text-foreground"
                onClick={() => setAdding((s) => (s === c.status ? null : c.status))}
              >
                <Plus />
              </Button>
            </Tooltip>
          </div>
        ))}

        {lanes.map((lane, laneIndex) => (
          <div key={lane || ROOT_LANE} className="contents">
            <div className="pt-2 text-xs font-medium break-words text-muted-foreground">
              {laneLabel(lane)}
            </div>
            {columns.map((c) => (
              // Every cell is a drop target: both axes are real writes now. The
              // cell draws nothing at rest — only while a card is over it.
              <div
                key={c.status}
                data-cell={`${c.status}:${lane}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(`${c.status}:${lane}`)
                  const el = (e.target as HTMLElement).closest?.('[data-task]')
                  if (!el) return setOverCard(null)
                  const box = el.getBoundingClientRect()
                  const half = e.clientY < box.top + box.height / 2 ? 'before' : 'after'
                  setOverCard(`${el.getAttribute('data-task')}:${half}`)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                  setOver((o) => (o === `${c.status}:${lane}` ? null : o))
                  setOverCard(null)
                }}
                onDrop={(e) => drop(e, lane, c.status)}
                className={cn(
                  'min-h-16 space-y-1.5 rounded-md p-1.5',
                  over === `${c.status}:${lane}` && 'bg-primary/10',
                )}
              >
                {cell(lane, c.status).map((t) => (
                  <Card
                    key={t.path}
                    task={t}
                    cue={
                      overCard === `${t.path}:before`
                        ? 'before'
                        : overCard === `${t.path}:after`
                          ? 'after'
                          : null
                    }
                  />
                ))}
                {adding === c.status && (
                  <QuickAdd
                    status={c.status}
                    folder={lane}
                    autoFocus={laneIndex === 0}
                    onCancel={() => setAdding(null)}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {all.length === 0 && (
        // The empty state distinguishes "no tasks yet" from "nothing matches your
        // filters" — there is no "N excluded" count anywhere, because nothing is hidden
        // into unselected buckets.
        <p className="mt-6 text-center text-xs text-muted-foreground">
          {everything.length === 0
            ? 'No tasks yet. Add one above — or ask Claude to.'
            : 'Nothing matches your filters.'}
        </p>
      )}
    </div>
  )
}
