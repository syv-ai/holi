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
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  AnimatePresence,
  LayoutGroup,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type MotionValue,
} from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, ConfirmInPlace, Icon, RollingCount, instant, settle } from '@/primitives'
import { cn } from '@/lib/cn'
import { useArrivals } from '@/lib/use-arrivals'
import { rankAt, sortCell } from '@/lib/board-order'
import {
  ROOT_LANE,
  brokenTasksAtom,
  collapsedLanesAtom,
  deleteTasksAtom,
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
import { BoardCard } from './BoardCard'
import { BoardDock, FilterChips } from './BoardDock'
import type { Parking } from './use-check-sequence'
import { cellKey, useBoardDrag, withGap } from './use-board-drag'

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

/** The gap a drag opens: springs open, springs shut. It carries the space
 *  below it, as a card does, so nothing is left behind when it shuts. */
function Gap({ height }: { height: number }): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  return (
    <motion.div
      aria-hidden
      data-gap=""
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: height + GAP_BELOW, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={reduced ? instant : settle}
      className="overflow-hidden"
    >
      <div className="rounded-xl bg-accent" style={{ height }} />
    </motion.div>
  )
}

/** The space under every card (`pb-2.5` in `BoardCard`), in pixels. */
const GAP_BELOW = 10

/**
 * The board's width, following its scroller's on `settle`. A pane opening
 * beside the board, or closing, changes the scroller in one frame; driving the
 * content's real width from one spring reflows columns, headers, cards and the
 * dock together, with nothing scaled (a `layout` animation would squash text).
 *
 * A window resize or a splitter drag jumps instead: the width follows the
 * pointer, and a spring would trail behind it. A drag moves a few pixels per
 * frame, a pane opening moves hundreds.
 */
function useBoardWidth(
  scroller: React.RefObject<HTMLDivElement | null>,
  reduced: boolean,
): MotionValue<number> | undefined {
  const width = useMotionValue(0)
  const [measured, setMeasured] = useState(false)
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    let windowWidth = window.innerWidth
    const observer = new ResizeObserver(([entry]) => {
      const next = entry!.contentRect.width
      const resized = window.innerWidth !== windowWidth
      windowWidth = window.innerWidth
      if (reduced || resized || Math.abs(next - width.get()) < 48) width.jump(next)
      else animate(width, next, settle)
      setMeasured(true)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scroller, reduced, width])
  return measured ? width : undefined
}

/**
 * Which cards a filter or search is showing again: tasks the board already
 * had, that it did not show last time. A card that only moved cells was shown,
 * and a new task was not had. The last render's sets are committed in an
 * effect, as `useArrivals` does, so StrictMode's second render compares
 * against the real previous one.
 */
function useReveals(
  tasks: ReadonlyMap<string, Task>,
  visible: ReadonlySet<string>,
): (path: string) => boolean {
  const last = useRef<{ had: ReadonlySet<string>; shown: ReadonlySet<string> } | null>(null)
  useEffect(() => {
    last.current = { had: new Set(tasks.keys()), shown: visible }
  })
  const previous = last.current
  return (path) => previous !== null && previous.had.has(path) && !previous.shown.has(path)
}

/** How a column comes and goes (Hide done): it grows from nothing beside its
 *  neighbours, which give it room, rather than appearing in one frame. The
 *  negative margin takes back the flex gap it would leave behind. */
const columnPresence = {
  initial: { flexGrow: 0, opacity: 0, marginLeft: -12, paddingLeft: 0, paddingRight: 0 },
  animate: { flexGrow: 1, opacity: 1, marginLeft: 0, paddingLeft: 8, paddingRight: 8 },
  exit: { flexGrow: 0, opacity: 0, marginLeft: -12, paddingLeft: 0, paddingRight: 0 },
}

export function BoardView(): React.JSX.Element {
  const tasks = useAtomValue(tasksAtom)
  const patch = useSetAtom(patchTaskAtom)
  const move = useSetAtom(moveTaskAtom)
  const rankAll = useSetAtom(rankTasksAtom)
  const removeAll = useSetAtom(deleteTasksAtom)
  const filter = useAtomValue(filterAtom)
  const now = useAtomValue(nowAtom)
  const reduced = useReducedMotion() ?? false
  const scroller = useRef<HTMLDivElement>(null)
  const width = useBoardWidth(scroller, reduced)

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
  const [collapsed, setCollapsed] = useAtom(collapsedLanesAtom)
  const toggleLane = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const everything = [...tasks.values()]
  const shown = (t: Task) => parked.get(t.path) ?? t.status
  const all = everything.filter((t) => matchesFilter({ ...t, status: shown(t) }, filter, now))
  const lanes = laneOrder(all.map(laneOf))
  const cell = (lane: string, status: TaskStatus) =>
    sortCell(all.filter((t) => shown(t) === status && laneOf(t) === lane))

  const finished = all.filter((t) => shown(t) === 'done')

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
   * Tasks new to the vault fade in (sync, the agent, quick add). Keyed by PATH
   * over every task, not only the shown ones, so a card moving between
   * columns, or one a filter shows again, does not replay it.
   */
  const { arrivalProps } = useArrivals(everything.map((t) => t.path))
  /**
   * A filter or search moves the board on one spring, all at once: a card it
   * shows again opens (`reveal`), a card it hides folds away, and a lane that
   * comes or goes carries its cards with it. No stagger.
   */
  const visible = new Set(all.map((t) => t.path))
  const revealed = useReveals(tasks, visible)
  const hiddenByFilter = (path: string) => tasks.has(path) && !visible.has(path)

  return (
    <div data-morph-stage="" className="relative flex min-h-0 flex-1 flex-col">
      <BrokenStrip />
      <LayoutGroup>
        <div ref={scroller} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {/* At least the board's height, and as tall as its tallest column:
              the surfaces stretch to whichever is more. */}
          <motion.div className="flex min-h-full gap-3 px-8 py-4" style={{ width }}>
            <AnimatePresence initial={false}>
              {columns.map((column) => (
                <motion.section
                  key={column.status}
                  data-column={column.status}
                  {...columnPresence}
                  transition={reduced ? instant : settle}
                  // Each surface runs to the foot of the board, full or not.
                  // The foot keeps clear of the dock that floats over it.
                  className="flex min-w-0 flex-1 flex-col rounded-[1.25rem] bg-card/25 p-2 pb-16"
                >
                  <h2 className="flex h-8 items-center gap-2 px-2 pb-1 text-xs font-semibold">
                    {column.label}
                    <RollingCount
                      value={all.filter((t) => shown(t) === column.status).length}
                      className="font-normal text-muted-foreground"
                    />
                    {column.status === 'done' && finished.length > 0 && (
                      // Empties what the column shows, once confirmed; left
                      // unanswered, the question folds away. Git keeps them.
                      <ConfirmInPlace
                        label="Delete every done task"
                        confirmLabel="Delete"
                        fuse={4000}
                        size="md"
                        onConfirm={() => void removeAll(finished.map((t) => t.path))}
                        className="ml-auto font-normal"
                      />
                    )}
                  </h2>

                  {/* One presence for the column's lane groups, keyed by lane: a
                      group that empties, fills, or whose folder leaves the
                      board entirely keeps its element and slides, rather than
                      remounting under a new wrapper and jumping. */}
                  <AnimatePresence initial={false}>
                    {lanes.map((lane) => {
                      const cards = cell(lane, column.status)
                      const gap = drag.gap(lane, column.status)
                      const key = cellKey(column.status, lane)
                      // The root lane has no name, so nothing to fold it by.
                      const open = !lane || !collapsed.has(key)
                      // An empty lane group is not there at rest, and springs open
                      // only while a drag is on, so every cell can take the drop.
                      if (cards.length === 0 && !drag.active) return null
                      return (
                        <motion.div
                          key={lane || ROOT_LANE}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={reduced ? instant : settle}
                          // Clip only what spills well past the group, so a
                          // card's flick is not cut.
                          className="overflow-clip [overflow-clip-margin:8px]"
                        >
                          <div {...drag.target(lane, column.status)} className="px-1 pt-1">
                            {/* The vault root's lane has no name to show. The lane a
                          drag aims at lights its name, not its surface. A
                          folded lane still takes a drop, at its top. */}
                            {lane ? (
                              <div className="pt-2 pb-1">
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  aria-expanded={open}
                                  data-lane-toggle={key}
                                  onClick={() => toggleLane(key)}
                                  className={cn(
                                    'group/lane h-6 max-w-full justify-start gap-1 px-1.5 font-medium active:scale-100 hover:bg-transparent dark:hover:bg-transparent',
                                    gap ? 'text-foreground' : 'text-muted-foreground',
                                  )}
                                >
                                  <span className="truncate">{lane}</span>
                                  {!open && <span className="font-normal">{cards.length}</span>}
                                  <Icon
                                    icon={ChevronRight}
                                    size="sm"
                                    className={cn(
                                      'motion-respond',
                                      open && 'rotate-90 opacity-0 group-hover/lane:opacity-100',
                                    )}
                                  />
                                </Button>
                              </div>
                            ) : (
                              <div className="h-2" />
                            )}
                            <AnimatePresence initial={false}>
                              {open && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  transition={reduced ? instant : settle}
                                  // Clip only what spills well past the cell, so a
                                  // card's flick is not cut while the lane folds.
                                  className="overflow-clip [overflow-clip-margin:8px]"
                                >
                                  <div className="flex min-h-6 flex-col pt-1">
                                    <AnimatePresence initial={false} custom={hiddenByFilter}>
                                      {withGap(cards, drag.isFolded, gap?.index ?? null).map(
                                        (item) =>
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
                                              reveal={!reduced && revealed(item.task.path)}
                                            />
                                          ),
                                      )}
                                    </AnimatePresence>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </motion.div>
                      )
                    })}
                  </AnimatePresence>
                </motion.section>
              ))}
            </AnimatePresence>
          </motion.div>
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
      <motion.div
        className="pointer-events-none absolute bottom-4 left-0 flex w-full flex-col items-center gap-2"
        style={{ width }}
      >
        <div className="pointer-events-auto">
          <FilterChips />
        </div>
        <div className="pointer-events-auto w-40">
          <BoardDock />
        </div>
      </motion.div>
    </div>
  )
}
