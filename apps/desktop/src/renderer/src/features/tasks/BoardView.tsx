/** The task board (docs/features/tasks.md).
 *
 * Todo / Doing / Done are three column surfaces; the folders are groups inside
 * each, because the folder IS the lane. A cell is `(column, lane)`, and every
 * cell is a drop target.
 *
 * **Both axes are writes, and a drop lands where it is aimed.** Between columns
 * rewrites `status`; between lanes moves the file into that folder and rewrites
 * every inbound `[[wiki-link]]` (`tasks.move`); a diagonal does both. The card's
 * rank in its new cell rides along, so every drag is one write.
 *
 * **Empty lane groups rest hidden** and spring open while a drag is on, so the
 * columns stay compact and still offer every cell.
 *
 * There is no "N excluded" count anywhere, because nothing is hidden into
 * unselected buckets. The empty state distinguishes "no tasks" from "nothing
 * matches".
 */
import type { Task, TaskStatus } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { IconButton, RollingCount, instant, settle } from '@/primitives'
import { cn } from '@/lib/cn'
import { useArrivals } from '@/lib/use-arrivals'
import { rankAt, sortCell } from '@/lib/board-order'
import {
  ROOT_LANE,
  brokenTasksAtom,
  createTaskAtom,
  filterAtom,
  laneOf,
  laneOrder,
  matchesFilter,
  moveTaskAtom,
  patchTaskAtom,
  rankTasksAtom,
  tasksAtom,
} from '@/state/tasks'
import { nowAtom } from '@/state/clock'
import { BoardCard, NewCard } from './BoardCard'
import { BoardDock } from './BoardDock'
import type { Parking } from './use-check-sequence'
import { useBoardDrag, withGap } from './use-board-drag'

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
]

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
    <div className="px-5 pt-3 text-xs">
      <p className="mb-1 font-medium text-destructive">
        {broken.length} task {broken.length === 1 ? 'file' : 'files'} could not be read
      </p>
      {broken.map((b) => (
        <div key={b.path} data-broken-task={b.path} className="text-[11px]">
          <span className="font-mono">{b.path}</span>: {b.error}
        </div>
      ))}
    </div>
  )
}

/** The gap a drag opens: springs open, springs shut. */
function Gap({ height }: { height: number }): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  return (
    <motion.div
      aria-hidden
      data-gap=""
      initial={{ height: 0, opacity: 0 }}
      animate={{ height, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={reduced ? instant : settle}
      className="rounded-xl bg-accent"
    />
  )
}

export function BoardView(): React.JSX.Element {
  const tasks = useAtomValue(tasksAtom)
  const patch = useSetAtom(patchTaskAtom)
  const move = useSetAtom(moveTaskAtom)
  const rankAll = useSetAtom(rankTasksAtom)
  const create = useSetAtom(createTaskAtom)
  const filter = useAtomValue(filterAtom)
  const now = useAtomValue(nowAtom)
  const reduced = useReducedMotion() ?? false

  /** Cards whose check is still playing: drawn in the column they came from
   *  until the sequence and the write are both done (`useCheckSequence`). */
  const [parked, setParked] = useState<ReadonlyMap<string, TaskStatus>>(new Map())
  const parking: Parking = {
    park: (path, status) => setParked((m) => new Map(m).set(path, status)),
    release: (path) =>
      setParked((m) => {
        const next = new Map(m)
        next.delete(path)
        return next
      }),
  }
  /** Which column's new card is open, and in which lane (an index). */
  const [adding, setAdding] = useState<{
    status: TaskStatus
    lane: number
    title: string
  } | null>(null)

  const everything = [...tasks.values()]
  const shown = (t: Task) => parked.get(t.path) ?? t.status
  const all = everything.filter((t) => matchesFilter({ ...t, status: shown(t) }, filter, now))
  const lanes = laneOrder(all.map(laneOf))
  const cell = (lane: string, status: TaskStatus) =>
    sortCell(all.filter((t) => shown(t) === status && laneOf(t) === lane))

  // "hide done" drops the whole Done column, not just its cards: an empty
  // column that can never fill reads as a layout bug.
  const columns = filter.hideDone ? COLUMNS.filter((c) => c.status !== 'done') : COLUMNS

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
  const drag = useBoardDrag(commit)

  /**
   * Cards new to the board animate in. Keyed by PATH and computed board-wide
   * rather than per cell, so a card moving between columns keeps its path and
   * does not replay an entrance.
   */
  const { arrivalProps } = useArrivals(all.map((t) => t.path))

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <BrokenStrip />
      <LayoutGroup>
        <div className="min-h-0 flex-1 overflow-auto">
          {/* At least the board's height, and as tall as its tallest column:
              the surfaces stretch to whichever is more. */}
          <div className="flex min-h-full gap-3 p-4">
            {columns.map((column) => (
              <section
                key={column.status}
                data-column={column.status}
                // Each surface runs to the foot of the board, full or not.
                // The foot keeps clear of the dock that floats over it.
                className="flex min-w-0 flex-1 flex-col rounded-[1.25rem] bg-card p-2 pb-16"
              >
                <h2 className="flex h-8 items-center gap-2 px-2 pb-1 text-xs font-semibold">
                  {column.label}
                  <RollingCount
                    value={all.filter((t) => shown(t) === column.status).length}
                    className="font-normal text-muted-foreground"
                  />
                  {adding?.status !== column.status && (
                    <motion.div
                      layoutId={reduced ? undefined : `new-${column.status}`}
                      transition={reduced ? instant : settle}
                      style={{ borderRadius: 999 }}
                      className="ml-auto"
                    >
                      <IconButton
                        icon={Plus}
                        label={`Add to ${column.label}`}
                        shape="round"
                        data-add-column={column.status}
                        onClick={() => setAdding({ status: column.status, lane: 0, title: '' })}
                      />
                    </motion.div>
                  )}
                </h2>

                {lanes.map((lane, laneIndex) => {
                  const cards = cell(lane, column.status)
                  const gap = drag.gap(lane, column.status)
                  const addingHere = adding?.status === column.status && adding.lane === laneIndex
                  // A lane group with cards is laid out plainly. An empty one is
                  // not there at rest, and springs open only while a drag is on,
                  // so every cell can take the drop. (Animating every group's
                  // height left stale pixel heights that clipped cards.)
                  const group = (
                    <div {...drag.target(lane, column.status)} className="mb-1.5 p-1">
                      {/* The vault root's lane has no name to show. The lane a
                          drag aims at lights its name, not its surface. */}
                      {lane ? (
                        <p
                          className={cn(
                            'px-1.5 pt-3 pb-2 text-xs font-medium break-words motion-respond',
                            gap ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {lane}
                        </p>
                      ) : (
                        <div className="h-2" />
                      )}
                      <div className="flex min-h-6 flex-col gap-2.5">
                        <AnimatePresence initial={false}>
                          {withGap(cards, drag.isFolded, gap?.index ?? null).map((item) =>
                            item.kind === 'gap' ? (
                              <Gap key="gap" height={gap!.height} />
                            ) : (
                              <BoardCard
                                key={item.task.path}
                                task={item.task}
                                shown={shown(item.task)}
                                drag={drag}
                                parking={parking}
                                arrival={
                                  drag.isFolded(item.task.path)
                                    ? undefined
                                    : arrivalProps(item.task.path)
                                }
                              />
                            ),
                          )}
                        </AnimatePresence>
                        {addingHere && (
                          <NewCard
                            status={column.status}
                            lane={lane}
                            layoutId={`new-${column.status}`}
                            title={adding.title}
                            onTitle={(title) => setAdding({ ...adding, title })}
                            onSubmit={(title) =>
                              void create({ title, status: column.status, folder: lane })
                            }
                            onLane={(step) =>
                              setAdding({
                                ...adding,
                                lane: (laneIndex + step + lanes.length) % lanes.length,
                              })
                            }
                            onClose={() => setAdding(null)}
                          />
                        )}
                      </div>
                    </div>
                  )
                  if (cards.length > 0 || addingHere)
                    return <div key={lane || ROOT_LANE}>{group}</div>
                  return (
                    <AnimatePresence key={lane || ROOT_LANE} initial={false}>
                      {drag.active && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={reduced ? instant : settle}
                          className="overflow-hidden"
                        >
                          {group}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  )
                })}
              </section>
            ))}
          </div>
        </div>
      </LayoutGroup>

      {all.length === 0 && (
        // "No tasks yet" versus "nothing matches your filters".
        <p className="absolute inset-x-0 top-1/3 text-center text-xs text-muted-foreground">
          {everything.length === 0
            ? 'No tasks yet. Add one with ⌘T, or ask Claude to.'
            : 'Nothing matches your filters.'}
        </p>
      )}

      {/* The dock floats over the board's foot; its box is just wide enough
          for its icons, so it never catches clicks meant for the cards.
          Centred by flex, not a transform: a transformed ancestor would
          become the open menu's containing block and drag its fixed pin. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <div className="pointer-events-auto w-40">
          <BoardDock />
        </div>
      </div>
    </div>
  )
}
