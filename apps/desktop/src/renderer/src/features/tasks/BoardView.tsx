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
import { useState } from 'react'
import { Checkbox, Input, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'
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
  selectedTaskPathAtom,
  setTaskStatusAtom,
  tasksAtom,
  todayAtom,
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

function Card({ task }: { task: Task }): React.JSX.Element {
  const today = useAtomValue(todayAtom)
  const complete = useSetAtom(completeTaskAtom)
  const select = useSetAtom(selectedTaskPathAtom)

  const labels = virtualLabels(task, today)

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
      className="cursor-grab rounded-md border border-border bg-card p-2 text-xs text-card-foreground shadow-sm hover:border-ring active:cursor-grabbing"
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
          {task.due && <span className="text-[10px] text-muted-foreground">due {task.due}</span>}
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

function QuickAdd({
  status,
  folder,
}: {
  status: TaskStatus
  folder: string
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
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
      }}
      placeholder="+ add"
      className="h-auto border-transparent bg-transparent px-1 py-0.5 text-xs shadow-none hover:border-input focus-visible:border-ring focus-visible:ring-0"
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
  const move = useSetAtom(moveTaskAtom)
  const filter = useAtomValue(filterAtom)
  const today = useAtomValue(todayAtom)

  const everything = [...tasks.values()]
  const all = everything.filter((t) => matchesFilter(t, filter, today))
  const lanes = laneOrder(all.map(laneOf))

  // "hide done" drops the whole Done column, not just its cards — an empty
  // column that can never fill reads as a layout bug, not a filter.
  const columns = filter.hideDone ? COLUMNS.filter((c) => c.status !== 'done') : COLUMNS
  const gridTemplateColumns = `8rem repeat(${columns.length}, minmax(0, 1fr))`

  const cell = (lane: string, status: TaskStatus) =>
    all.filter((t) => t.status === status && laneOf(t) === lane)

  // Both axes are live now: a same-lane drop rewrites status, a cross-lane drop
  // moves the file (+ link rewrite), and a diagonal does both in one call. The
  // dragged task is looked up by path, so the drop knows its current lane/status.
  const drop = (e: React.DragEvent, lane: string, status: TaskStatus) => {
    const path = e.dataTransfer.getData('text/plain')
    const task = tasks.get(path)
    if (!task) return
    const intent = dropIntent(task, lane, status)
    if (intent.kind === 'status') void setStatus(path, intent.status)
    else if (intent.kind === 'move') void move(path, intent.folder, intent.status)
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      <div className="grid gap-2" style={{ gridTemplateColumns }}>
        <div />
        {columns.map((c) => (
          <div key={c.status} className="px-1 pb-1 text-xs font-semibold text-foreground">
            {c.label}
          </div>
        ))}

        {lanes.map((lane) => (
          <div key={lane || ROOT_LANE} className="contents">
            <Tooltip content={laneLabel(lane)}>
              <div className="truncate pt-2 text-xs font-medium text-muted-foreground">
                {laneLabel(lane)}
              </div>
            </Tooltip>
            {columns.map((c) => (
              // Every cell is a drop target: both axes are real writes now.
              <div
                key={c.status}
                data-cell={`${c.status}:${lane}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e, lane, c.status)}
                className="min-h-16 space-y-1.5 rounded-md border border-border bg-muted/40 p-1.5"
              >
                {cell(lane, c.status).map((t) => (
                  <Card key={t.path} task={t} />
                ))}
                <QuickAdd status={c.status} folder={lane} />
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
