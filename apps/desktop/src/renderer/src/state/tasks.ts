/** The board's state (prd/tasks.md §Board UX).
 *
 * Tasks reach the renderer by main **pushing** them: the SSE connection lives in
 * `main/vault/vault-manager.ts`, one per vault, and the board is a consumer of it.
 * The renderer never opens a second stream — that is the invariant, not an
 * implementation detail.
 *
 * Nothing here parses a task file. The board reads Postgres through tRPC like every
 * other query; the file projection is one-directional and is never an index.
 */
import type { Task } from '@holi/shared'
import { allLabels } from '@holi/shared'
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeVaultIdAtom, docsAtom } from './vaults'

/** Mirrors the server bus (apps/server/src/bus.ts). Do NOT widen it (D36). */
export type TasksEvent = { type: 'upserted'; task: Task } | { type: 'deleted'; taskId: string }

export type PresenceEvent = {
  taskId: string
  userId: string
  name: string
  /** ISO. The entry dies on its own — there is no "stopped editing" event. */
  expiresAt: string
}

export const NO_AREA = '(no area)'

export const tasksAtom = atom<Map<string, Task>>(new Map())
export const presenceAtom = atom<Map<string, PresenceEvent[]>>(new Map())

/** folderId -> path. Derived from the docs fetch, which already carries folders —
 * a second query would just be a second chance to disagree with it. */
export const foldersAtom = atom<Map<string, string>>(
  (get) => new Map(get(docsAtom).folders.map((f) => [f.id, f.path])),
)
/** Today, as YYYY-MM-DD. Held in state so virtual labels stay pure and testable and
 * the board re-renders when the day turns rather than reading the clock inline. */
export const todayAtom = atom<string>(new Date().toISOString().slice(0, 10))

// ------------------------------------------------------------------ reducers
// Pure, exported, and tested directly — the atoms are just where they live.

/** Read the union exactly as the projector does. A third variant would land in the
 * `else` — which in the projector *deletes the task's file* (D36). */
export function applyTasksEvent(tasks: Map<string, Task>, event: TasksEvent): Map<string, Task> {
  const next = new Map(tasks)
  if (event.type === 'upserted') next.set(event.task.id, event.task)
  else next.delete(event.taskId)
  return next
}

/** One live entry per user per task — a fresh heartbeat replaces the last, it does not
 * stack. Without this a user typing for a minute would grow six entries. */
export function applyPresence(
  presence: Map<string, PresenceEvent[]>,
  event: PresenceEvent,
): Map<string, PresenceEvent[]> {
  const next = new Map(presence)
  const others = (next.get(event.taskId) ?? []).filter((e) => e.userId !== event.userId)
  next.set(event.taskId, [...others, event])
  return next
}

/** Drop what has expired. **A heartbeat that stops arriving IS the release** — this is
 * the whole reason tasks need no locks: no acquire, no release, no stale holder from a
 * crashed client, no steal path. Do not add a "stopped editing" event. */
export function pruneExpired(
  presence: Map<string, PresenceEvent[]>,
  nowIso: string,
): Map<string, PresenceEvent[]> {
  const next = new Map<string, PresenceEvent[]>()
  for (const [taskId, entries] of presence) {
    const live = entries.filter((e) => e.expiresAt > nowIso)
    if (live.length > 0) next.set(taskId, live)
  }
  return next
}

/** The lane a task belongs to: its area's folder path, or "(no area)".
 *
 * A folder the renderer does not know yet (it appeared since we fetched, which happens
 * — folders are created as a side effect of note paths and have no channel of their
 * own) falls into "(no area)" rather than making the card vanish. A task the user
 * cannot see is worse than a task in the wrong lane. */
export function laneFor(task: Task, folders: Map<string, string>): string {
  if (task.area === undefined) return NO_AREA
  return folders.get(task.area) ?? NO_AREA
}

/** "(no area)" first, then alphabetical by path (prd/tasks.md §Board UX). */
export function laneOrder(lanes: Iterable<string>): string[] {
  const rest = [...new Set(lanes)].filter((l) => l !== NO_AREA).sort((a, b) => a.localeCompare(b))
  return [NO_AREA, ...rest]
}

// ------------------------------------------------------------------- filter

export type Filter = {
  search: string
  /** Matched against virtual labels AND real tags alike — one vocabulary (D41). */
  tags: string[]
  hideDone: boolean
}

export const EMPTY_FILTER: Filter = { search: '', tags: [], hideDone: false }
export const filterAtom = atom<Filter>(EMPTY_FILTER)

/** The board's only narrowing. Three controls, deliberately (prd/tasks.md §Board UX) —
 * the bar is a search-and-narrow aid, not a second configuration surface.
 *
 * The tag filter matches `overdue`/`p1`… exactly as it matches a real tag: computing
 * the labels (D41) is what makes "show me the overdue p1s" a tag query rather than two
 * bespoke controls. Selected tags are ANDed, as an issue tracker does.
 */
export function matchesFilter(task: Task, filter: Filter, today: string): boolean {
  if (filter.hideDone && task.status === 'done') return false

  const needle = filter.search.trim().toLowerCase()
  if (needle) {
    const hay = `${task.title}\n${task.description ?? ''}`.toLowerCase()
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

// ------------------------------------------------------------------- writes
// Optimistic: patch the atom, roll back on failure. The server push stays the ONE
// authoritative update — we do not treat a mutation's return value as truth by
// another name, we let the push land.

export const loadTasksAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  const tasks = await trpc.tasks.list.query({ vaultId })
  set(tasksAtom, new Map(tasks.map((t) => [t.id, t])))
})

/** One drop is ONE patch (D42). A board cell is `(column, lane)`, so a diagonal drag
 * moves both axes — as two mutations that would be two pushes, two file rewrites and
 * (mirrored) two commits, and a half-failed pair leaves the card somewhere nobody
 * dropped it. */
export const moveTaskAtom = atom(
  null,
  async (get, set, taskId: string, to: { status: Task['status']; area: string | null }) => {
    const vaultId = get(activeVaultIdAtom)
    const before = get(tasksAtom).get(taskId)
    if (!vaultId || !before) return

    set(tasksAtom, applyTasksEvent(get(tasksAtom), {
      type: 'upserted',
      task: { ...before, status: to.status, area: to.area ?? undefined },
    }))
    try {
      await trpc.tasks.update.mutate({
        vaultId,
        taskId,
        patch: { status: to.status, area: to.area },
      })
    } catch {
      set(tasksAtom, applyTasksEvent(get(tasksAtom), { type: 'upserted', task: before }))
    }
  },
)

/** The card's ONE affordance. It goes through `tasks.complete`, never a `status:'done'`
 * patch: complete is the single roll-forward path, so a recurring task rolls to its next
 * occurrence instead of persisting `done`. A patch would silently skip the roll. */
export const completeTaskAtom = atom(null, async (get, set, taskId: string) => {
  const vaultId = get(activeVaultIdAtom)
  const before = get(tasksAtom).get(taskId)
  if (!vaultId || !before) return
  // No optimistic status flip: for a recurring task the answer is not `done` but a NEW
  // due date, and only the server knows it. Guessing would show the wrong thing and then
  // correct itself a beat later.
  try {
    await trpc.tasks.complete.mutate({ vaultId, taskId })
  } catch {
    /* the push will not come; the board simply does not move */
  }
})

export const createTaskAtom = atom(
  null,
  async (get, set, input: { title: string; status: Task['status']; area: string | null }) => {
    const vaultId = get(activeVaultIdAtom)
    if (!vaultId) return
    await trpc.tasks.create.mutate({ vaultId, ...input })
    // no optimistic insert: the record's id is the server's to mint, and the push is
    // moments away
  },
)

/** The task open in the detail view. */
export const selectedTaskIdAtom = atom<string | null>(null)

/** A field edit from the detail view.
 *
 * **No `version`.** The board is plain last-writer-wins per field, exactly as the PRD
 * specifies — the concurrency token belongs to the *file* path, where the writer edited
 * a snapshot of a record that may have moved under them. Here the user is looking at
 * the live record.
 */
export const patchTaskAtom = atom(
  null,
  async (get, set, taskId: string, patch: Record<string, unknown>) => {
    const vaultId = get(activeVaultIdAtom)
    const before = get(tasksAtom).get(taskId)
    if (!vaultId || !before) return

    set(tasksAtom, applyTasksEvent(get(tasksAtom), {
      type: 'upserted',
      task: { ...before, ...(patch as Partial<Task>) },
    }))
    try {
      await trpc.tasks.update.mutate({ vaultId, taskId, patch })
    } catch {
      set(tasksAtom, applyTasksEvent(get(tasksAtom), { type: 'upserted', task: before }))
    }
  },
)

export const deleteTaskAtom = atom(null, async (get, set, taskId: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  set(selectedTaskIdAtom, null)
  await trpc.tasks.delete.mutate({ vaultId, taskId })
})

/** "Nicolai is editing this task" — the renderer half of presence.
 *
 * Fire-and-forget, and never awaited into a write path: presence failing must not cost
 * the user an edit. It touches no row and must never bump `version` — one that did
 * would rewrite every task file and, with the mirror on, commit it. */
export const heartbeatAtom = atom(null, (get, _set, taskId: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  void trpc.tasks.heartbeat.mutate({ vaultId, taskId }).catch(() => {})
})
