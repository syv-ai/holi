/** The board's state (`docs/features/tasks.md`).
 *
 * Tasks are **derived from the vault snapshot**, not held in a store of their
 * own: the board is a view of it. A write goes to the router and then re-reads;
 * glob-and-parse is imperceptible at a vault's scale, so there is no index.
 *
 * Deliberately absent: **presence** (two people on one task file is an ordinary
 * git conflict) and **`related[]`** (a task links by writing wiki-links in its
 * body; backrefs are a grep).
 */
import type { Task, TaskStatus } from '@holi/shared'
import { allLabels, dailyNoteFilename, parseWikiLinks, taskArea, virtualLabels } from '@holi/shared'
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { nowAtom, todayAtom } from './clock'
import { activeTab, closeTabsForPaths, workspaceAtom } from './panes'
import { activeRemoteAtom, loadSnapshotAtom, snapshotAtom } from './vaults'

/** The vault root's lane. The lane IS the containing folder, and the root
 * folder's path is the empty string. */
export const ROOT_LANE = ''

/** Tasks by path. The path is the identity, so this needs no id and no join. */
export const tasksAtom = atom<Map<string, Task>>(
  (get) => new Map(get(snapshotAtom).tasks.map((t) => [t.path, t])),
)

/** Task files that would not parse, rendered as error cards. Never hidden:
 * omitting one from the board is indistinguishable from data loss. */
/** Every tag used by a task, sorted: what a tags field suggests. */
export const taskTagsAtom = atom((get) =>
  [...new Set(get(snapshotAtom).tasks.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b)),
)

export const brokenTasksAtom = atom((get) => get(snapshotAtom).broken)

/** How many tasks are still open (not done): the badge on the board button. */
export const openTaskCountAtom = atom(
  (get) => get(snapshotAtom).tasks.filter((t) => t.status !== 'done').length,
)

/** How many open tasks are overdue, by the board's own `overdue` label: what
 *  turns the board badge red. Follows `nowAtom`, so it turns over on the minute. */
export const overdueTaskCountAtom = atom((get) => {
  const now = get(nowAtom)
  return get(snapshotAtom).tasks.filter((t) => virtualLabels(t, now).includes('overdue')).length
})

/** Open (not-done) tasks whose body links to `notePath`. A task counts once no
 * matter how many times it links. */
export function countOpenTasksLinking(tasks: Iterable<Task>, notePath: string): number {
  let n = 0
  for (const t of tasks) {
    if (t.status === 'done') continue
    if (parseWikiLinks(t.description).some((l) => l.target === notePath)) n += 1
  }
  return n
}

/** The badge on the sidebar "Today" entry: how many open tasks link to today's note
 * (`docs/features/daily-notes.md`). Zero → the Shell renders no badge. */
export const todayLinkCountAtom = atom((get) =>
  countOpenTasksLinking(get(snapshotAtom).tasks, dailyNoteFilename(get(todayAtom))),
)

/**
 * Quick add (⌘T), open, and where it shows: in the board's dock when the
 * focused pane is on the board, otherwise centred at the top like the
 * palette. The board's dock takes its request and clears it at once; the
 * centred one stays set while it is open.
 */
export const quickAddAtom = atom<{ where: 'board' | 'centre' } | null>(null)

export const openQuickAddAtom = atom(null, (get, set) =>
  set(quickAddAtom, {
    where: activeTab(get(workspaceAtom))?.kind === 'board' ? 'board' : 'centre',
  }),
)

/** The folder quick add opens in, asked for by a board lane's +. Taken once:
 *  quick add fills its Lane from it and clears it. */
export const quickAddFolderAtom = atom<string | null>(null)

/** Quick add, opened in `folder`. */
export const openQuickAddInAtom = atom(null, (_get, set, folder: string) => {
  set(quickAddFolderAtom, folder)
  set(openQuickAddAtom)
})

// ------------------------------------------------------------------ reducers
// Pure, exported, and tested directly.

/** The vault-root lane first, then alphabetical by path.
 *
 * The root lane is always present, even with nothing filed there: quick-add
 * needs a cell to land in, and a vault whose every task lives in a folder would
 * otherwise offer nowhere to add a root-level one. */
export function laneOrder(lanes: Iterable<string>): string[] {
  const rest = [...new Set(lanes)].filter((l) => l !== ROOT_LANE).sort((a, b) => a.localeCompare(b))
  return [ROOT_LANE, ...rest]
}

/** A lane's heading. Only the root needs naming: its path is the empty string. */
export function laneLabel(lane: string): string {
  return lane === ROOT_LANE ? '(vault root)' : lane
}

// ------------------------------------------------------------------- filter

export type Filter = {
  search: string
  /** Matched against virtual labels AND real tags alike: one vocabulary. */
  tags: string[]
  /** Lanes (a task's folder, `ROOT_LANE` for the vault root): any of them. */
  folders: string[]
  hideDone: boolean
}

export const EMPTY_FILTER: Filter = { search: '', tags: [], folders: [], hideDone: false }
export const filterAtom = atom<Filter>(EMPTY_FILTER)

/** Lane groups folded shut on the board, by cell key (`status:lane`): one
 *  column's lane folds without the others. A view convenience, so memory only. */
export const collapsedLanesAtom = atom<ReadonlySet<string>>(new Set<string>())

/** The board's only narrowing. Three controls, deliberately: the bar is a
 * search-and-narrow aid, not a second configuration surface. The filter
 * narrows by folder and by tag: a task in any chosen folder, carrying every
 * chosen tag.
 *
 * The tag filter matches `overdue`/`p1`… exactly as it matches a real tag: computing
 * the labels is what makes "show me the overdue p1s" a tag query rather than two
 * bespoke controls. Selected tags are ANDed, as an issue tracker does.
 */
export function matchesFilter(task: Task, filter: Filter, now: string): boolean {
  if (filter.hideDone && task.status === 'done') return false

  const needle = filter.search.trim().toLowerCase()
  if (needle) {
    const hay = `${task.title}\n${task.description}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }

  if (filter.folders.length > 0 && !filter.folders.includes(laneOf(task))) return false

  if (filter.tags.length > 0) {
    const labels = new Set(allLabels(task, now))
    if (!filter.tags.every((t) => labels.has(t))) return false
  }
  return true
}

/** Every label in play, for the bar's tag picker, virtual ones included. */
export function availableLabels(tasks: Iterable<Task>, now: string): string[] {
  const all = new Set<string>()
  for (const t of tasks) for (const l of allLabels(t, now)) all.add(l)
  return [...all].sort((a, b) => a.localeCompare(b))
}

/** The lane a task sits in, in the board's vocabulary. */
export function laneOf(task: Task): string {
  return taskArea(task)
}

/** Every folder that exists in the vault, for the create-task dialog's folder
 * picker: the ancestor folders of every file, unique and sorted, with the root
 * excluded (it is offered separately as "(vault root)"). */
export function taskCreateFolders(paths: Iterable<string>): string[] {
  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  return [...folders].sort((a, b) => a.localeCompare(b))
}

/** What a drop onto `(targetLane, targetStatus)` means for `task`.
 *
 * - same lane, same column → `noop`
 * - same lane, new column → `status` (the vertical axis)
 * - new lane → `move` (the horizontal axis: a file move + link rewrite), and if
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
// Every write re-reads the vault. No optimistic patching and no
// mutation-result-as-truth: the file on disk is the only truth (D60).

export const createTaskAtom = atom(
  null,
  async (
    get,
    set,
    input: {
      title: string
      status: TaskStatus
      folder: string
      description?: string
      /** Set before the task exists (quick add, full create): written with
       *  the create, one file, one write. */
      extra?: Partial<Pick<Task, 'due' | 'priority' | 'tags' | 'reminder' | 'recurrence'>>
    },
  ) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return null
    const { path } = await trpc.tasks.create.mutate({ remote, ...input })
    await set(loadSnapshotAtom)
    return path
  },
)

/** A field edit from the detail view.
 *
 * **No `version` token.** Between machines git arbitrates. */
export const patchTaskAtom = atom(
  null,
  async (get, set, path: string, patch: Record<string, unknown>) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return
    await trpc.tasks.update.mutate({ remote, path, patch })
    await set(loadSnapshotAtom)
  },
)

/** Ranks several cards in one pass and one re-read: the unranked cards a drop
 * pins above itself (`rankAt`). */
export const rankTasksAtom = atom(
  null,
  async (get, set, ranks: { path: string; order: number }[]) => {
    const remote = get(activeRemoteAtom)
    if (!remote || ranks.length === 0) return
    await Promise.all(
      ranks.map(({ path, order }) => trpc.tasks.update.mutate({ remote, path, patch: { order } })),
    )
    await set(loadSnapshotAtom)
  },
)

/** Moves a card between columns: the vertical axis, and the card's checkbox.
 * Done is completion, which main applies to any status write, so a recurring
 * task rolls to its next occurrence (`completeTask`). The horizontal axis is
 * `moveTaskAtom`, because it moves the file and rewrites inbound wiki-links. */
export const setTaskStatusAtom = atom(null, (_get, set, path: string, status: TaskStatus) =>
  set(patchTaskAtom, path, { status }),
)

/** The horizontal axis: moves a card to another lane, which moves the file into
 * that folder and rewrites inbound wiki-links in one pass (`tasks.move`). A
 * `status` rides along for a diagonal drop, so it is never half-dropped, and
 * `order` for where in the cell it was dropped. Returns the moved path. */
export const moveTaskAtom = atom(
  null,
  async (
    get,
    set,
    path: string,
    folder: string,
    status?: TaskStatus,
    order?: number,
  ): Promise<string | null> => {
    const remote = get(activeRemoteAtom)
    if (!remote) return null
    // The rank rides along too, so a drop lands where it was aimed in one write.
    const moved = await trpc.tasks.move.mutate({ remote, path, folder, status, order })
    await set(loadSnapshotAtom)
    return moved.path
  },
)

/** Deletes several tasks in one pass and one re-read: emptying Done. Git still
 *  has them. */
export const deleteTasksAtom = atom(null, async (get, set, paths: string[]) => {
  const remote = get(activeRemoteAtom)
  if (!remote || paths.length === 0) return
  await Promise.all(paths.map((path) => trpc.tasks.delete.mutate({ remote, path })))
  set(workspaceAtom, closeTabsForPaths(get(workspaceAtom), paths))
  await set(loadSnapshotAtom)
})

export const deleteTaskAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.tasks.delete.mutate({ remote, path })
  // The file goes, then its tab: an open one would leave a tab pointing at bytes
  // that are gone, and a live buffer that would write the file back.
  set(workspaceAtom, closeTabsForPaths(get(workspaceAtom), [path]))
  await set(loadSnapshotAtom)
})
