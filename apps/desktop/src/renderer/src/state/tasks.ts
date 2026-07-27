/** The board's state (prd/tasks.md §Board UX).
 *
 * Tasks are **derived from the vault snapshot**, not held in a store of their own.
 * There is no server, so there is no push channel and nothing to reconcile a
 * second cache against: `scanVault` reads the files, the snapshot holds the
 * result, and the board is a view of it. A write goes to the router and then
 * re-reads — glob-and-parse is imperceptible at a vault's scale, and buying an
 * index before a measurement asks for one is what the PRD rejects outright.
 *
 * Gone with the server, and worth naming so they are not re-added by habit:
 * **presence** (its heartbeat needed a push channel, and two people on one task
 * file is now an ordinary git conflict), and **`related[]`** (a task links by
 * writing wiki-links in its body — backrefs are a grep).
 */
import type { Task, TaskStatus } from '@holi/shared'
import { allLabels, taskArea } from '@holi/shared'
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom, loadSnapshotAtom, snapshotAtom } from './vaults'

/** The vault root's lane. The lane IS the containing folder, and the root
 * folder's path is the empty string — there is no "(no area)" any more because
 * there is no `area` field to be missing. */
export const ROOT_LANE = ''

/** Tasks by path. The path is the identity, so this needs no id and no join. */
export const tasksAtom = atom<Map<string, Task>>(
  (get) => new Map(get(snapshotAtom).tasks.map((t) => [t.path, t])),
)

/** Task files that would not parse, rendered as error cards. Never hidden:
 * omitting one from the board is indistinguishable from data loss. */
export const brokenTasksAtom = atom((get) => get(snapshotAtom).broken)

/** Today, as YYYY-MM-DD. Held in state so virtual labels stay pure and testable
 * and the board re-renders when the day turns rather than reading the clock
 * inline. Local, not UTC — the same frame the roll-forward uses. */
export const todayAtom = atom<string>(
  `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`,
)

/** The task open in the detail view, by path. */
export const selectedTaskPathAtom = atom<string | null>(null)

/** The create-task dialog's mode, or `null` when closed. `quick` (⌘T) captures a
 * task and stays where you are; `full` (⌘⇧T) captures it and drops you into the
 * detail editor to flesh it out. A single global atom: the dialog is mounted once
 * in the shell, and each entry point sets the mode rather than owning a copy. */
export type CreateTaskMode = 'quick' | 'full'
export const createTaskDialogAtom = atom<CreateTaskMode | null>(null)

// ------------------------------------------------------------------ reducers
// Pure, exported, and tested directly — the atoms are just where they live.

/** The vault-root lane first, then alphabetical by path (prd/tasks.md §Board UX).
 *
 * The root lane is always present, even with nothing filed there: quick-add
 * needs a cell to land in, and a vault whose every task lives in a folder would
 * otherwise offer nowhere to add a root-level one. */
export function laneOrder(lanes: Iterable<string>): string[] {
  const rest = [...new Set(lanes)].filter((l) => l !== ROOT_LANE).sort((a, b) => a.localeCompare(b))
  return [ROOT_LANE, ...rest]
}

/** A lane's heading. Only the root needs naming — its path is the empty string,
 * which would render as a blank row. */
export function laneLabel(lane: string): string {
  return lane === ROOT_LANE ? '(vault root)' : lane
}

// ------------------------------------------------------------------- filter

export type Filter = {
  search: string
  /** Matched against virtual labels AND real tags alike — one vocabulary. */
  tags: string[]
  hideDone: boolean
}

export const EMPTY_FILTER: Filter = { search: '', tags: [], hideDone: false }
export const filterAtom = atom<Filter>(EMPTY_FILTER)

/** The board's only narrowing. Three controls, deliberately (prd/tasks.md §Board UX) —
 * the bar is a search-and-narrow aid, not a second configuration surface.
 *
 * The tag filter matches `overdue`/`p1`… exactly as it matches a real tag: computing
 * the labels is what makes "show me the overdue p1s" a tag query rather than two
 * bespoke controls. Selected tags are ANDed, as an issue tracker does.
 */
export function matchesFilter(task: Task, filter: Filter, today: string): boolean {
  if (filter.hideDone && task.status === 'done') return false

  const needle = filter.search.trim().toLowerCase()
  if (needle) {
    const hay = `${task.title}\n${task.description}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }

  if (filter.tags.length > 0) {
    const labels = new Set(allLabels(task, today))
    if (!filter.tags.every((t) => labels.has(t))) return false
  }
  return true
}

/** Every label in play, for the bar's tag picker — virtual ones included, so they are
 * selectable exactly like tags. */
export function availableLabels(tasks: Iterable<Task>, today: string): string[] {
  const all = new Set<string>()
  for (const t of tasks) for (const l of allLabels(t, today)) all.add(l)
  return [...all].sort((a, b) => a.localeCompare(b))
}

/** The lane a task sits in. A one-liner over `taskArea`, kept so the board reads
 * in lane vocabulary rather than reaching for a domain helper mid-render. */
export function laneOf(task: Task): string {
  return taskArea(task)
}

/** Every folder that exists in the vault, for the create-task dialog's folder
 * picker — the ancestor folders of every file, unique and sorted, with the root
 * excluded (it is offered separately as "(vault root)"). This lets a new task be
 * filed into any existing folder without retyping, and — because a folder is a
 * lane — into any existing lane. */
export function taskCreateFolders(paths: Iterable<string>): string[] {
  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  return [...folders].sort((a, b) => a.localeCompare(b))
}

/** What a drop onto `(targetLane, targetStatus)` means for `task` — the branch a
 * card's drop takes, factored out of the board so it is pure and tested (a
 * diagonal is the subtle one: lane AND column change, and both must land as one
 * action).
 *
 * - same lane, same column → `noop` (a card dropped where it already sits)
 * - same lane, new column → `status` (the vertical axis — a plain status change)
 * - new lane → `move` (the horizontal axis — a file move + link rewrite), and if
 *   the column also changed, the new `status` rides along so the diagonal is one
 *   `tasks.move` call rather than a move then a separate status write. */
export type DropIntent =
  | { kind: 'noop' }
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'move'; folder: string; status?: TaskStatus }

export function dropIntent(task: Task, targetLane: string, targetStatus: TaskStatus): DropIntent {
  const sameLane = laneOf(task) === targetLane
  const sameStatus = task.status === targetStatus
  if (sameLane) return sameStatus ? { kind: 'noop' } : { kind: 'status', status: targetStatus }
  return sameStatus
    ? { kind: 'move', folder: targetLane }
    : { kind: 'move', folder: targetLane, status: targetStatus }
}

// ------------------------------------------------------------------- writes
//
// Every write re-reads the vault. There is no optimistic patching and no
// mutation-result-as-truth: the file on disk is the only truth there is, and a
// second representation of a task is exactly what D60 deleted.

export const createTaskAtom = atom(
  null,
  async (get, set, input: { title: string; status: TaskStatus; folder: string }) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return null
    const { path } = await trpc.tasks.create.mutate({ remote, ...input })
    await set(loadSnapshotAtom)
    return path
  },
)

/** A field edit from the detail view.
 *
 * **No `version`.** There is nothing to race with on this machine — the file is
 * the single writer target — and between machines git arbitrates, not a token. */
export const patchTaskAtom = atom(
  null,
  async (get, set, path: string, patch: Record<string, unknown>) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return
    await trpc.tasks.update.mutate({ remote, path, patch })
    await set(loadSnapshotAtom)
  },
)

/** The card's ONE affordance, and the status select's `done` branch.
 *
 * Goes through `tasks.complete`, never a `status: 'done'` patch: complete is the
 * single roll-forward path, so a recurring task rolls to its next occurrence
 * instead of persisting `done`. A patch would silently end the series. */
export const completeTaskAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.tasks.complete.mutate({ remote, path })
  await set(loadSnapshotAtom)
})

/** Moves a card between columns — the vertical axis. The horizontal axis (moving
 * a card to another lane) lives in `moveTaskAtom`, because it moves the file and
 * must rewrite inbound wiki-links in the same pass. */
export const setTaskStatusAtom = atom(null, async (get, set, path: string, status: TaskStatus) => {
  if (status === 'done') return set(completeTaskAtom, path)
  return set(patchTaskAtom, path, { status })
})

/** The horizontal axis: moves a card to another lane, which moves the file into
 * that folder and rewrites inbound wiki-links in one pass (`tasks.move`). A
 * `status` rides along for a diagonal drop, so lane + column land as one call —
 * one write burst, one autosave commit, never a half-dropped card. */
export const moveTaskAtom = atom(
  null,
  async (get, set, path: string, folder: string, status?: TaskStatus) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return
    await trpc.tasks.move.mutate({ remote, path, folder, status })
    await set(loadSnapshotAtom)
  },
)

export const deleteTaskAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  set(selectedTaskPathAtom, null)
  await trpc.tasks.delete.mutate({ remote, path })
  await set(loadSnapshotAtom)
})
