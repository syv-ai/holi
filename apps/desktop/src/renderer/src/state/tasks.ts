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
import { privateTaskPath, sharedTaskPath, snapshotTasks } from '@holi/shared'
import { atom } from 'jotai'
import { capClient, type UiCapability } from '@/lib/cap-client'
import { isClosedAtom } from './planning'
import { activeRemoteAtom, loadSnapshotAtom, renameNoteAtom, snapshotAtom } from './vaults'

/** The snapshot's claimed task files: the tasks, and those that would not
 *  parse. */
export const snapshotTasksAtom = atom((get) => snapshotTasks(get(snapshotAtom)))

/** Tasks by path. The path is the identity, so this needs no id and no join. */
export const tasksAtom = atom<Map<string, Task>>(
  (get) => new Map(get(snapshotTasksAtom).items.map((t) => [t.path, t])),
)

/** Task files that would not parse, rendered as error cards. Never hidden:
 * omitting one from the board is indistinguishable from data loss. */
/** Every tag used by a task, sorted: what a tags field suggests. */
export const taskTagsAtom = atom((get) =>
  [...new Set(get(snapshotTasksAtom).items.flatMap((t) => t.tags))].sort((a, b) =>
    a.localeCompare(b),
  ),
)

export const brokenTasksAtom = atom((get) => get(snapshotTasksAtom).broken)

/** How many tasks are still open, by the vault's own statuses (any status
 *  not filed under `completed`): the badge on the sidebar's Board. */
export const openTaskCountAtom = atom((get) => {
  const isClosed = get(isClosedAtom)
  return get(snapshotTasksAtom).items.filter((t) => !isClosed(t.status)).length
})

/** Quick add (⌘T) is open: one dialog near the top, wherever it was asked for. */
const quickAddAtom = atom(false)

export const openQuickAddAtom = atom(null, (_get, set) => set(quickAddAtom, true))

// ------------------------------------------------------------------- writes
//
// Every write re-reads the vault. No optimistic patching and no
// mutation-result-as-truth: the file on disk is the only truth.

/** The tasks capabilities the renderer calls (`tasks.create`). */
/**
 * The tasks plugin's verbs Planning uses (`plugins/tasks/main/capabilities.ts`),
 * typed by hand because core never imports a plugin. Dispatch checks the
 * params at runtime.
 */
type TaskVerbs = {
  'tasks.create': UiCapability<
    {
      title: string
      folder?: string
      shared?: boolean
      status?: string
      description?: string
      extra?: Record<string, unknown>
    },
    { path: string }
  >
  'tasks.update': UiCapability<{ path: string; patch: Record<string, unknown> }, Task>
  'tasks.move': UiCapability<
    { path: string; folder: string; status?: string; order?: number },
    Task
  >
  'tasks.delete': UiCapability<{ path: string }, unknown>
}

const tasksCap = capClient<TaskVerbs>('tasks')

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
      /** Committed and synced; private by default, a `.local.` file on this
       *  machine only (docs/features/tasks.md). */
      shared?: boolean
      /** Set before the task exists (quick add, full create): written with
       *  the create, one file, one write. */
      extra?: Partial<
        Pick<
          Task,
          | 'due'
          | 'start'
          | 'priority'
          | 'estimate'
          | 'tags'
          | 'assignees'
          | 'reminder'
          | 'recurrence'
        >
      >
    },
  ) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return null
    const { path } = await tasksCap.create(remote, input)
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
    await tasksCap.update(remote, { path, patch })
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
      ranks.map(({ path, order }) => tasksCap.update(remote, { path, patch: { order } })),
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
    const moved = await tasksCap.move(remote, {
      path,
      folder,
      ...(status === undefined ? {} : { status }),
      ...(order === undefined ? {} : { order }),
    })
    await set(loadSnapshotAtom)
    return moved.path
  },
)

/**
 * Sharing is a rename (docs/features/tasks.md): a private task is
 * `task.<name>.local.md`, on this machine only, and sharing drops the marker,
 * so the file is committed and synced. Inbound links follow. Resolves to the
 * task's new path, or null when nothing moved.
 */
export const shareTaskAtom = atom(null, async (_get, set, path: string) => {
  const to = sharedTaskPath(path)
  if (to === null) return null
  await set(renameNoteAtom, { from: path, to })
  return to
})

/**
 * The other way: the marker added, so the task leaves every teammate's board
 * on their next sync. Only this machine's local files have their links
 * rewritten: a shared note must not be committed pointing at a file the
 * others will never have. Git history keeps the shared version.
 */
export const makeTaskPrivateAtom = atom(null, async (_get, set, path: string) => {
  const to = privateTaskPath(path)
  if (to === null) return null
  await set(renameNoteAtom, { from: path, to, localLinksOnly: true })
  return to
})
