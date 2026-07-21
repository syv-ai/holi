/** The stripped board (prd/tasks.md §Board UX).
 *
 * One layout. Todo / Doing / Done, fixed; one swim lane per folder, because the
 * folder IS the lane. A cell is `(column, lane)`.
 *
 * **Only the vertical axis is a write.** Dragging between columns rewrites
 * `status`; dragging between lanes would move the file, and a move has to
 * rewrite every inbound `[[wiki-link]]` in the same pass or it silently breaks
 * them. Until that pass exists, a cross-lane cell simply is not a drop target —
 * the drag shows "no drop" rather than half-applying.
 *
 * There is no "N excluded" count anywhere, because nothing is hidden into
 * unselected buckets. The empty state distinguishes "no tasks" from "nothing
 * matches".
 */
import type { Task, TaskStatus } from '@holi/shared'
import { virtualLabels } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { FilterBar } from './FilterBar'
import { TaskDetailPanel } from './TaskDetail'
import {
  ROOT_LANE,
  brokenTasksAtom,
  completeTaskAtom,
  createTaskAtom,
  filterAtom,
  laneLabel,
  laneOf,
  laneOrder,
  matchesFilter,
  selectedTaskPathAtom,
  setTaskStatusAtom,
  tasksAtom,
  todayAtom,
} from '../state/tasks'

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
]

/** Virtual labels get a colour; a task's own tags stay neutral. The chip is the same
 * shape either way — they read as one vocabulary. */
const CHIP: Record<string, string> = {
  overdue: 'bg-red-950 text-red-300 border-red-900',
  p1: 'bg-orange-950 text-orange-300 border-orange-900',
  p2: 'bg-amber-950/70 text-amber-300 border-amber-900',
  p3: 'bg-neutral-800 text-neutral-400 border-neutral-700',
}

function Card({
  task,
  onDragStart,
}: {
  task: Task
  onDragStart: (task: Task) => void
}): React.JSX.Element {
  const today = useAtomValue(todayAtom)
  const complete = useSetAtom(completeTaskAtom)
  const select = useSetAtom(selectedTaskPathAtom)

  const labels = virtualLabels(task, today)

  return (
    <div
      draggable
      data-task={task.path}
      // The dragged path rides the drag itself, not React state. State would mean the
      // drop handler only learns what is being dragged once a re-render has happened
      // between the two events. dataTransfer IS the payload. (The lane goes through
      // state as well as here, because dataTransfer is unreadable during dragover and
      // that is where lane validity has to be decided.)
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.path)
        onDragStart(task)
      }}
      onClick={() => select(task.path)}
      className="cursor-grab rounded border border-neutral-800 bg-neutral-900 p-2 text-xs active:cursor-grabbing"
    >
      <div className="flex items-start gap-2">
        {/* The card's ONE affordance. Completion goes through tasks.complete, so a
            recurring task ROLLS FORWARD rather than persisting `done`. */}
        <input
          type="checkbox"
          checked={task.status === 'done'}
          onChange={() => void complete(task.path)}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 shrink-0"
          aria-label={`Complete ${task.title}`}
        />
        <span className={task.status === 'done' ? 'text-neutral-500 line-through' : ''}>
          {task.title}
        </span>
      </div>

      {(labels.length > 0 || task.tags.length > 0 || task.due) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6">
          {task.due && <span className="text-[10px] text-neutral-500">due {task.due}</span>}
          {labels.map((l) => (
            <span key={l} className={`rounded border px-1 text-[10px] ${CHIP[l]}`}>
              {l}
            </span>
          ))}
          {task.tags.map((t) => (
            <span
              key={t}
              className="rounded border border-neutral-700 bg-neutral-800 px-1 text-[10px] text-neutral-400"
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const t = title.trim()
        if (!t) return
        setTitle('')
        void create({ title: t, status, folder })
      }}
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="+ add"
        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-neutral-300 placeholder:text-neutral-600 hover:border-neutral-800 focus:border-neutral-700 focus:outline-none"
      />
    </form>
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
    <div className="mx-3 mt-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs">
      <p className="mb-1 font-medium text-red-300">
        {broken.length} task {broken.length === 1 ? 'file' : 'files'} could not be read
      </p>
      {broken.map((b) => (
        <div key={b.path} data-broken-task={b.path} className="text-[11px] text-red-400/90">
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
  const filter = useAtomValue(filterAtom)
  const today = useAtomValue(todayAtom)

  // The lane the in-flight drag started in. dataTransfer cannot be read during
  // dragover, and that is where a cross-lane cell has to refuse the drop.
  const [dragLane, setDragLane] = useState<string | null>(null)

  const everything = [...tasks.values()]
  const all = everything.filter((t) => matchesFilter(t, filter, today))
  const lanes = laneOrder(all.map(laneOf))

  const cell = (lane: string, status: TaskStatus) =>
    all.filter((t) => t.status === status && laneOf(t) === lane)

  const drop = (e: React.DragEvent, lane: string, status: TaskStatus) => {
    setDragLane(null)
    const path = e.dataTransfer.getData('text/plain')
    if (!path || laneOf({ path } as Task) !== lane) return
    void setStatus(path, status)
  }

  return (
    <div className="flex-1 overflow-auto p-3" onDragEnd={() => setDragLane(null)}>
      <div className="grid grid-cols-[8rem_repeat(3,minmax(0,1fr))] gap-2">
        <div />
        {COLUMNS.map((c) => (
          <div key={c.status} className="px-1 pb-1 text-xs font-medium text-neutral-400">
            {c.label}
          </div>
        ))}

        {lanes.map((lane) => (
          <div key={lane || ROOT_LANE} className="contents">
            <div className="truncate pt-2 text-xs text-neutral-500" title={laneLabel(lane)}>
              {laneLabel(lane)}
            </div>
            {COLUMNS.map((c) => {
              // Only the lane the drag started in accepts it: the horizontal axis is
              // a file move, and that needs the link rewrite it does not have yet.
              const accepts = dragLane === null || dragLane === lane
              return (
                <div
                  key={c.status}
                  data-cell={`${c.status}:${lane}`}
                  onDragOver={(e) => accepts && e.preventDefault()}
                  onDrop={(e) => drop(e, lane, c.status)}
                  className={`min-h-16 space-y-1.5 rounded border border-neutral-900 bg-neutral-950/60 p-1.5 ${
                    accepts ? '' : 'opacity-40'
                  }`}
                >
                  {cell(lane, c.status).map((t) => (
                    <Card key={t.path} task={t} onDragStart={(d) => setDragLane(laneOf(d))} />
                  ))}
                  <QuickAdd status={c.status} folder={lane} />
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {all.length === 0 && (
        // The empty state distinguishes "no tasks yet" from "nothing matches your
        // filters" — there is no "N excluded" count anywhere, because nothing is hidden
        // into unselected buckets.
        <p className="mt-6 text-center text-xs text-neutral-600">
          {everything.length === 0
            ? 'No tasks yet. Add one above — or ask Claude to.'
            : 'Nothing matches your filters.'}
        </p>
      )}
    </div>
  )
}
