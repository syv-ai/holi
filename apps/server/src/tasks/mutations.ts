/**
 * The one place a task changes (server-data.md §"exactly one place").
 *
 * Until slice 2 this lived inside `routers/tasks.ts` and was that one place only
 * by accident — the router was simply the only caller. The git ingester is now a
 * second one, and it must not be able to write the `tasks` table directly:
 * `finishMutation` is where `recomputeReminder`, `bus.emitTasks` and
 * `wakeEvaluator` happen, so a mutation that bypassed it would produce a task that
 * fires no reminder and — because no SSE goes out — never rewrites its own file on
 * any connected desktop. A half-applied change that looks applied.
 *
 * So the mutations move here, taking `(db, bus)` explicitly rather than a tRPC
 * `ctx`, because the ingester has no `ctx`. The router keeps input validation; this
 * module takes already-validated values.
 */
import { and, eq, sql } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { nextDueCatchup, shiftForRollover, type Task } from '@holi/shared'
import type { Bus } from '../bus'
import { config } from '../config'
import type { Db } from '../db/client'
import { toTask } from '../db/mappers'
import { tasks } from '../db/schema'
import { recomputeReminder } from '../reminders/projection'
import { todayLocal } from '../reminders/tz'

export type TaskRow = typeof tasks.$inferSelect

/** The record-form fields a mutation can carry. `null` clears; absent means "not
 * mentioned" — the distinction the task file's per-field diff depends on. */
export interface TaskPatch {
  title?: string
  status?: 'todo' | 'doing' | 'done'
  area?: string | null
  due?: string | null
  priority?: 'low' | 'medium' | 'high' | null
  tags?: string[]
  reminder?: string | null
  recurrence?: TaskRow['recurrence'] | null
  related?: TaskRow['related']
  description?: string | null
}

export interface TaskCtx {
  db: Db
  bus: Bus
}

/** Fetch + vault-scope a task row or 404. */
export async function taskInVault(db: Db, vaultId: string, taskId: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.vaultId, vaultId)))
  if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
  return row
}

/** Spread into every mutation's SET clause. Bumping `version` here rather than at
 * each call site is what makes the optimistic-concurrency token trustworthy: a
 * mutation that forgot to bump would let a stale write win. */
function touch() {
  return { updatedAt: new Date(), version: sql`${tasks.version} + 1` }
}

/**
 * The optimistic-concurrency guard, folded into the WHERE clause so it is atomic —
 * a read-then-check would leave a window in which a write that went stale in between
 * still lands, which is the exact thing `version` exists to prevent. Zero rows
 * updated ⇒ the version moved ⇒ CONFLICT.
 *
 * `version` is **optional**: the board sends none and keeps plain last-writer-wins,
 * and git ingest sends none either (a commit carries its own base blob, so its diff
 * is already exact — see the slice-2 plan, D9). Only a *desktop file* write carries
 * one, because only it is based on a snapshot of the record that may have moved.
 *
 * `vaultId` is in here too, so the tenancy check is atomic with the version check
 * rather than resting on the SELECT that happens to precede it.
 */
function atVersion(vaultId: string, taskId: string, version: number | undefined) {
  const scoped = and(eq(tasks.id, taskId), eq(tasks.vaultId, vaultId))
  return version === undefined ? scoped : and(scoped, eq(tasks.version, version))
}

function staleConflict(version: number | undefined, row: TaskRow): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: `stale task write: file is at version ${version}, record is at ${row.version}`,
  })
}

/** Persist → recompute projection → emit → wake evaluator. Every mutation funnels
 * through here so nothing forgets a step. */
async function finishMutation(ctx: TaskCtx, row: TaskRow): Promise<Task> {
  await recomputeReminder(ctx.db, row)
  const task = toTask(row)
  ctx.bus.emitTasks(row.vaultId, { type: 'upserted', task })
  ctx.bus.wakeEvaluator()
  return task
}

export async function createTask(
  ctx: TaskCtx,
  vaultId: string,
  input: TaskPatch & { title: string },
): Promise<Task> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({ ...input, vaultId, tags: input.tags ?? [], related: input.related ?? [] })
    .returning()
  return finishMutation(ctx, row!)
}

/** Last-writer-wins per field (tasks are not CRDTs), with an optional version guard. */
export async function patchTask(
  ctx: TaskCtx,
  vaultId: string,
  taskId: string,
  patch: TaskPatch,
  version?: number,
): Promise<Task> {
  const current = await taskInVault(ctx.db, vaultId, taskId) // 404s if absent
  const [row] = await ctx.db
    .update(tasks)
    .set({ ...patch, ...touch() })
    .where(atVersion(vaultId, taskId, version))
    .returning()
  if (!row) staleConflict(version, current)
  return finishMutation(ctx, row)
}

/** Transition to done + server-side recurrence roll-forward (D19). The single
 * completion path: a file cannot express "roll it" vs "end the series", which is
 * why `task_set` survives as an op. */
export async function completeTask(
  ctx: TaskCtx,
  vaultId: string,
  taskId: string,
  version?: number,
): Promise<Task> {
  const row = await taskInVault(ctx.db, vaultId, taskId)
  const now = new Date()
  const rolledDue =
    row.recurrence && row.due
      ? nextDueCatchup(row.due, row.recurrence, todayLocal(config.timezone, now))
      : null
  const patch = rolledDue
    ? {
        status: 'todo' as const,
        due: rolledDue,
        reminder:
          row.reminder && row.due
            ? (shiftForRollover(row.reminder, row.due, rolledDue) ?? row.reminder)
            : row.reminder,
        remindedAt: null,
        completedAt: now,
        ...touch(),
      }
    : { status: 'done' as const, completedAt: now, ...touch() }
  const [updated] = await ctx.db
    .update(tasks)
    .set(patch)
    .where(atVersion(vaultId, row.id, version))
    .returning()
  if (!updated) staleConflict(version, row)
  return finishMutation(ctx, updated)
}

export async function deleteTask(
  ctx: TaskCtx,
  vaultId: string,
  taskId: string,
  version?: number,
): Promise<void> {
  const row = await taskInVault(ctx.db, vaultId, taskId)
  // the reminders row cascades
  const gone = await ctx.db.delete(tasks).where(atVersion(vaultId, row.id, version)).returning()
  if (gone.length === 0) staleConflict(version, row)
  ctx.bus.emitTasks(vaultId, { type: 'deleted', taskId: row.id })
}

/** Add a related ref if it isn't already there. */
export async function linkTask(
  ctx: TaskCtx,
  vaultId: string,
  taskId: string,
  ref: TaskRow['related'][number],
): Promise<Task> {
  const row = await taskInVault(ctx.db, vaultId, taskId)
  const next = row.related.some((r) => r.kind === ref.kind && r.id === ref.id)
    ? row.related
    : [...row.related, ref]
  const [updated] = await ctx.db
    .update(tasks)
    .set({ related: next, ...touch() })
    .where(atVersion(vaultId, row.id, undefined))
    .returning()
  return finishMutation(ctx, updated!)
}

export async function unlinkTask(
  ctx: TaskCtx,
  vaultId: string,
  taskId: string,
  ref: TaskRow['related'][number],
): Promise<Task> {
  const row = await taskInVault(ctx.db, vaultId, taskId)
  const next = row.related.filter((r) => !(r.kind === ref.kind && r.id === ref.id))
  const [updated] = await ctx.db
    .update(tasks)
    .set({ related: next, ...touch() })
    .where(atVersion(vaultId, row.id, undefined))
    .returning()
  return finishMutation(ctx, updated!)
}
