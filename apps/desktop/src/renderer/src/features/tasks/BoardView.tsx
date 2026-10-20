/** The task board (docs/features/tasks.md), on ReUI's kanban.
 *
 * Todo / Doing / Done are three column surfaces; inside each, the cards are
 * grouped by folder, because the folder IS the lane: a lane's name heads its
 * cards (the vault root's lane has none).
 *
 * **A drop lands where it is aimed, and it is one write.** Between columns it
 * rewrites `status`; dropped among another lane's cards it moves the file into
 * that folder and rewrites every inbound `[[wiki-link]]` (`tasks.move`); a
 * diagonal does both. The card's rank in its new cell rides along. Writes
 * re-read the vault (no optimistic data), so the board keeps the dropped
 * arrangement until the re-read lands.
 *
 * There is no "N excluded" count anywhere, because nothing is hidden into
 * unselected buckets. An empty column says whether there are no tasks at all
 * or nothing matches the filters.
 */
import type { Task, TaskStatus } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Ellipsis, Plus } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanOverlay,
  type KanbanCommitMeta,
} from '@/primitives'
import { cn } from '@/lib/cn'
import { rankAt, sortCell } from '@/lib/board-order'
import {
  brokenTasksAtom,
  deleteTasksAtom,
  filterAtom,
  laneOf,
  laneOrder,
  matchesFilter,
  moveTaskAtom,
  openQuickAddInAtom,
  openQuickAddInColumnAtom,
  patchTaskAtom,
  rankTasksAtom,
  tasksAtom,
} from '@/state/tasks'
import { useAgentService } from '@/state/agent-service'
import { nowAtom } from '@/state/clock'
import { BoardCard, CardFace } from './BoardCard'
import { BoardToolbar } from './BoardToolbar'
import { ConfirmDelete } from './ConfirmDelete'

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
]

type Columns = Record<string, Task[]>

/**
 * Task files that would not parse. A strip rather than cards, because an
 * unparseable file has no `status` to place it by. Never hidden: a task missing
 * from the board is indistinguishable from data loss, and the model will
 * occasionally write bad frontmatter.
 */
function BrokenStrip(): React.JSX.Element | null {
  const broken = useAtomValue(brokenTasksAtom)
  if (broken.length === 0) return null

  return (
    <div className="flex flex-col gap-1 px-4 pt-4 text-xs">
      <p className="font-medium text-destructive">
        {broken.length} task {broken.length === 1 ? 'file' : 'files'} could not be read
      </p>
      {broken.map((b) => (
        <div key={b.path} data-broken-task={b.path} className="text-muted-foreground">
          <span className="font-mono">{b.path}</span>: {b.error}
        </div>
      ))}
    </div>
  )
}

/**
 * The lane each card of a column is in, as drawn: its own folder, except the
 * card being dragged, which takes the lane of the card above it (or below it,
 * at the top), since that is where a drop would put it.
 */
function lanesAsDrawn(cards: Task[], dragged: string | null): string[] {
  return cards.map((task, index) => {
    if (task.path !== dragged) return laneOf(task)
    const near = cards[index - 1] ?? cards[index + 1]
    return near ? laneOf(near) : laneOf(task)
  })
}

export function BoardView(): React.JSX.Element {
  const tasks = useAtomValue(tasksAtom)
  const agent = useAgentService()
  const patch = useSetAtom(patchTaskAtom)
  const move = useSetAtom(moveTaskAtom)
  const rankAll = useSetAtom(rankTasksAtom)
  const removeAll = useSetAtom(deleteTasksAtom)
  const openQuickAddIn = useSetAtom(openQuickAddInAtom)
  const openQuickAddInColumn = useSetAtom(openQuickAddInColumnAtom)
  const filter = useAtomValue(filterAtom)
  const now = useAtomValue(nowAtom)
  const [confirmingDone, setConfirmingDone] = useState(false)
  /** The kanban's arrangement while a drag is on, and after a drop until its
   *  writes have landed; null at rest, when the board is the vault's. */
  const [preview, setPreview] = useState<Columns | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const committing = useRef(false)

  const everything = [...tasks.values()]
  const all = everything.filter((t) => matchesFilter(t, filter, now))
  /** A filter or search is hiding some task. */
  const filtered = all.length !== everything.length
  const lanes = laneOrder(all.map(laneOf))
  const cell = (lane: string, status: TaskStatus) =>
    sortCell(all.filter((t) => t.status === status && laneOf(t) === lane))
  // "hide done" drops the whole Done column, not just its cards: an empty
  // column that can never fill reads as a layout bug.
  const columns = filter.hideDone ? COLUMNS.filter((c) => c.status !== 'done') : COLUMNS

  const resting = useMemo<Columns>(
    () =>
      Object.fromEntries(
        columns.map(({ status }) => [status, lanes.flatMap((lane) => cell(lane, status))]),
      ),
    // `cell` reads `all`, which follows the tasks, the filter and the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, filter, now],
  )
  const value = preview ?? resting
  const finished = (resting.done ?? []).map((t) => t.path)

  /** A drop's write: status and rank in place, or a move carrying both. The
   *  first drop below unranked cards ranks them first (`rankAt`). */
  const commit = async (path: string, lane: string, status: TaskStatus, index: number) => {
    const task = tasks.get(path)
    if (!task) return
    const ranks = rankAt(cell(lane, status), path, index)
    const rank = ranks?.at(-1)?.order ?? null
    const newStatus = status !== task.status ? status : undefined
    if (laneOf(task) === lane && newStatus === undefined && rank === null) return
    if (ranks && ranks.length > 1) await rankAll(ranks.slice(0, -1))
    if (laneOf(task) === lane) {
      await patch(path, {
        ...(newStatus ? { status: newStatus } : {}),
        ...(rank !== null ? { order: rank } : {}),
      })
    } else {
      await move(path, lane, newStatus, rank ?? undefined)
    }
  }

  /** Where a drop landed, as a cell and an index among that cell's other
   *  cards, read off the final arrangement. */
  const onCommit = (final: Columns, meta: KanbanCommitMeta<Task>) => {
    if (meta.kind !== 'item') return
    committing.current = true
    const status = meta.overContainer as TaskStatus
    const path = String(meta.event.active.id)
    const cards = final[status] ?? []
    const drawn = lanesAsDrawn(cards, path)
    const lane = drawn[meta.overIndex] ?? laneOf(tasks.get(path)!)
    const index = cards
      .slice(0, meta.overIndex)
      .filter((t, i) => drawn[i] === lane && t.path !== path).length
    void commit(path, lane, status, index).finally(() => {
      committing.current = false
      setPreview(null)
    })
  }

  const empty = (status: TaskStatus) =>
    status === 'todo' ? (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">{filtered ? 'Nothing matches' : 'No tasks'}</p>
          <p className="text-xs text-muted-foreground">
            {filtered
              ? 'No task in Todo matches your filters.'
              : `Add one with ⌘T${agent === null ? '.' : `, or ask ${agent.name} to.`}`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => openQuickAddInColumn('todo')}>
          <Icon icon={Plus} size="sm" />
          Add task
        </Button>
      </div>
    ) : (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">Nothing here</p>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardToolbar />
      <BrokenStrip />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Kanban<Task>
          value={value}
          onValueChange={setPreview}
          getItemValue={(task) => task.path}
          onValueCommit={onCommit}
          onDragStart={(event) => setDragged(String(event.active.id))}
          onDragEnd={() => {
            setDragged(null)
            // A drop that moved nothing commits nothing: back to the vault's
            // arrangement. A drop that did keeps its preview until it lands.
            setTimeout(() => {
              if (!committing.current) setPreview(null)
            })
          }}
          onDragCancel={() => {
            setDragged(null)
            setPreview(null)
          }}
          restoreOnCancel
          className="h-full"
        >
          <KanbanBoard
            className={cn(
              'h-full min-h-full auto-rows-auto gap-4',
              columns.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3',
            )}
          >
            {columns.map((column) => {
              const cards = value[column.status] ?? []
              const drawn = lanesAsDrawn(cards, dragged)
              return (
                <KanbanColumn
                  key={column.status}
                  value={column.status}
                  data-column={column.status}
                  className="min-h-0 gap-2 rounded-xl bg-muted/40 p-2"
                >
                  <div className="flex h-8 items-center gap-2 px-1.5">
                    <h2 className="text-sm font-medium">{column.label}</h2>
                    <Badge variant="secondary">{cards.length}</Badge>
                    <div className="ml-auto flex items-center gap-1">
                      {column.status === 'done' && finished.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton icon={Ellipsis} label="Done column actions" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setConfirmingDone(true)}
                            >
                              Delete every done task…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <IconButton
                        icon={Plus}
                        label={`New task in ${column.label}`}
                        data-column-add={column.status}
                        onClick={() => openQuickAddInColumn(column.status)}
                      />
                    </div>
                  </div>
                  <KanbanColumnContent
                    value={column.status}
                    className="min-h-24 flex-1 overflow-y-auto"
                  >
                    {cards.length === 0 && empty(column.status)}
                    {cards.map((task, index) => {
                      const lane = drawn[index]!
                      // A lane's name heads its first card; the root lane has none.
                      const heads = lane !== '' && lane !== drawn[index - 1]
                      return (
                        <div key={task.path} className="flex flex-col gap-1">
                          {heads && (
                            <div className="group/lane flex h-6 items-center gap-1 px-1.5 pt-1">
                              <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                                {lane}
                              </span>
                              <IconButton
                                icon={Plus}
                                label={`New task in ${lane}`}
                                size="sm"
                                data-lane-add={lane}
                                onClick={() => openQuickAddIn(lane)}
                                className="ml-auto opacity-0 group-hover/lane:opacity-100 focus-visible:opacity-100"
                              />
                            </div>
                          )}
                          <BoardCard task={task} />
                        </div>
                      )
                    })}
                  </KanbanColumnContent>
                </KanbanColumn>
              )
            })}
          </KanbanBoard>
          <KanbanOverlay>
            {({ value: path }) => {
              const task = tasks.get(String(path))
              return task ? <CardFace task={task} filled={task.status === 'done'} /> : null
            }}
          </KanbanOverlay>
        </Kanban>
      </div>
      <ConfirmDelete
        open={confirmingDone}
        title={`Delete ${finished.length} done ${finished.length === 1 ? 'task' : 'tasks'}?`}
        onCancel={() => setConfirmingDone(false)}
        onConfirm={() => void removeAll(finished)}
      />
    </div>
  )
}
