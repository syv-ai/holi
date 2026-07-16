/** The stripped board (prd/tasks.md §Board UX).
 *
 * One layout. Todo / Doing / Done, fixed; one swim lane per `area`. Both drag axes are
 * real writes, and a cell is `(column, lane)` — so one drop is one patch (D42).
 *
 * There is no "N excluded" count anywhere, because nothing is hidden into unselected
 * buckets. The empty state distinguishes "no tasks" from "nothing matches".
 */
import type { Task, TaskStatus } from '@holi/shared'
import { virtualLabels } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { FilterBar } from './FilterBar'
import { TaskDetailPanel } from './TaskDetail'
import {
  NO_AREA,
  completeTaskAtom,
  createTaskAtom,
  foldersAtom,
  laneFor,
  laneOrder,
  filterAtom,
  matchesFilter,
  moveTaskAtom,
  presenceAtom,
  selectedTaskIdAtom,
  tasksAtom,
  todayAtom,
} from '../state/tasks'

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
]

/** Virtual labels get a colour; a task's own tags stay neutral. The chip is the same
 * shape either way — that is the point of D41: they read as one vocabulary. */
const CHIP: Record<string, string> = {
  overdue: 'bg-red-950 text-red-300 border-red-900',
  p1: 'bg-orange-950 text-orange-300 border-orange-900',
  p2: 'bg-amber-950/70 text-amber-300 border-amber-900',
  p3: 'bg-neutral-800 text-neutral-400 border-neutral-700',
}

function Card({ task }: { task: Task }): React.JSX.Element {
  const today = useAtomValue(todayAtom)
  const presence = useAtomValue(presenceAtom)
  const complete = useSetAtom(completeTaskAtom)
  const select = useSetAtom(selectedTaskIdAtom)

  const labels = virtualLabels(task, today)
  const watching = presence.get(task.id) ?? []

  return (
    <div
      draggable
      data-task={task.id}
      // The dragged id rides the drag itself, not React state. State would mean the drop
      // handler only learns what is being dragged once a re-render has happened between
      // the two events — true in a browser, but a dependency on frame timing for what is
      // really just a payload. dataTransfer IS the payload.
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      onClick={() => select(task.id)}
      className="cursor-grab rounded border border-neutral-800 bg-neutral-900 p-2 text-xs active:cursor-grabbing"
    >
      <div className="flex items-start gap-2">
        {/* The card's ONE affordance. Completion goes through tasks.complete, so a
            recurring task ROLLS FORWARD rather than persisting `done`. */}
        <input
          type="checkbox"
          checked={task.status === 'done'}
          onChange={() => void complete(task.id)}
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

      {watching.length > 0 && (
        // "Nicolai is editing this task" — true when Nicolai's *Claude* is editing it
        // too: a user and their agent are one identity (D37), so there is no actor to
        // distinguish and the board must not try.
        <div className="mt-1.5 flex items-center gap-1 pl-6 text-[10px] text-sky-400">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
          {watching.map((p) => p.name).join(', ')} editing…
        </div>
      )}
    </div>
  )
}

function QuickAdd({ status, area }: { status: TaskStatus; area: string | null }): React.JSX.Element {
  const create = useSetAtom(createTaskAtom)
  const [title, setTitle] = useState('')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const t = title.trim()
        if (!t) return
        setTitle('')
        void create({ title: t, status, area })
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

export function BoardView(): React.JSX.Element {
  // The feed is Shell's now (state/task-feed.ts): the notes editor needs tasks too, and
  // the board is not always mounted.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar />
      <div className="flex min-h-0 flex-1">
        <Grid />
        <TaskDetailPanel />
      </div>
    </div>
  )
}

function Grid(): React.JSX.Element {
  const tasks = useAtomValue(tasksAtom)
  const folders = useAtomValue(foldersAtom)
  const move = useSetAtom(moveTaskAtom)
  const filter = useAtomValue(filterAtom)
  const today = useAtomValue(todayAtom)

  const everything = [...tasks.values()]
  const all = everything.filter((t) => matchesFilter(t, filter, today))
  // Lane ids by path, so a drop can turn a lane back into the folder id the record stores.
  const folderIdByPath = new Map([...folders].map(([id, path]) => [path, id]))
  const lanes = laneOrder(all.map((t) => laneFor(t, folders)))

  const areaOf = (lane: string) =>
    lane === NO_AREA ? null : (folderIdByPath.get(lane) ?? null)

  const cell = (lane: string, status: TaskStatus) =>
    all.filter((t) => t.status === status && laneFor(t, folders) === lane)

  const drop = (e: React.DragEvent, lane: string, status: TaskStatus) => {
    const taskId = e.dataTransfer.getData('text/plain')
    if (!taskId) return
    // A cell is (column, lane), so ONE drop is ONE patch carrying both axes (D42).
    void move(taskId, { status, area: areaOf(lane) })
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      <div className="grid grid-cols-[8rem_repeat(3,minmax(0,1fr))] gap-2">
        <div />
        {COLUMNS.map((c) => (
          <div key={c.status} className="px-1 pb-1 text-xs font-medium text-neutral-400">
            {c.label}
          </div>
        ))}

        {lanes.map((lane) => (
          <div key={lane} className="contents">
            <div className="truncate pt-2 text-xs text-neutral-500" title={lane}>
              {lane}
            </div>
            {COLUMNS.map((c) => (
              <div
                key={c.status}
                data-cell={`${c.status}:${lane}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e, lane, c.status)}
                className="min-h-16 space-y-1.5 rounded border border-neutral-900 bg-neutral-950/60 p-1.5"
              >
                {cell(lane, c.status).map((t) => (
                  <Card key={t.id} task={t} />
                ))}
                <QuickAdd status={c.status} area={areaOf(lane)} />
              </div>
            ))}
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
