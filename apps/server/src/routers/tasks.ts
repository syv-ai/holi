import { and, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { on } from 'node:events'
import { z } from 'zod'
import { nextDueCatchup, shiftForRollover, type Task } from '@holi/shared'
import type { Bus, TasksEvent } from '../bus'
import { config } from '../config'
import type { Db } from '../db/client'
import { toTask } from '../db/mappers'
import { tasks } from '../db/schema'
import { recomputeReminder } from '../reminders/projection'
import { todayLocal } from '../reminders/tz'
import { router, vaultProcedure } from '../trpc'

const relatedRef = z.object({ kind: z.enum(['note', 'task', 'email', 'event']), id: z.string() })
const recurrence = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1),
  weekdays: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional(),
  endDate: z.string().optional(),
})
const taskFields = {
  title: z.string().min(1),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  area: z.string().uuid().optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  tags: z.array(z.string()).optional(),
  reminder: z.string().optional(),
  recurrence: recurrence.optional(),
  related: z.array(relatedRef).optional(),
}

type TaskRow = typeof tasks.$inferSelect

/** Fetch + vault-scope a task row or 404. */
async function taskInVault(db: Db, vaultId: string, taskId: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.vaultId, vaultId)))
  if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
  return row
}

/** Persist → recompute projection → emit → wake evaluator: every mutation
 * funnels through here so nothing forgets a step. */
async function finishMutation(ctx: { db: Db; bus: Bus }, row: TaskRow): Promise<Task> {
  await recomputeReminder(ctx.db, row)
  const task = toTask(row)
  ctx.bus.emitTasks(row.vaultId, { type: 'upserted', task })
  ctx.bus.wakeEvaluator()
  return task
}

export const tasksRouter = router({
  list: vaultProcedure
    .input(z.object({ filter: z.object({ status: z.enum(['todo', 'doing', 'done']).optional() }).optional() }))
    .query(async ({ ctx, input }) => {
      const where = input.filter?.status
        ? and(eq(tasks.vaultId, ctx.vaultId), eq(tasks.status, input.filter.status))
        : eq(tasks.vaultId, ctx.vaultId)
      return (await ctx.db.select().from(tasks).where(where)).map(toTask)
    }),

  get: vaultProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => toTask(await taskInVault(ctx.db, ctx.vaultId, input.taskId))),

  create: vaultProcedure
    .input(z.object(taskFields))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(tasks)
        .values({ ...input, vaultId: ctx.vaultId, tags: input.tags ?? [], related: input.related ?? [] })
        .returning()
      return finishMutation(ctx, row!)
    }),

  /** Last-writer-wins per field (D4 — tasks are not CRDTs). */
  update: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), patch: z.object(taskFields).partial() }))
    .mutation(async ({ ctx, input }) => {
      await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      const [row] = await ctx.db
        .update(tasks)
        .set({ ...input.patch, updatedAt: new Date() })
        .where(eq(tasks.id, input.taskId))
        .returning()
      return finishMutation(ctx, row!)
    }),

  /** Transition to done + server-side recurrence roll-forward (D19). */
  complete: vaultProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
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
            updatedAt: now,
          }
        : { status: 'done' as const, completedAt: now, updatedAt: now }
      const [updated] = await ctx.db.update(tasks).set(patch).where(eq(tasks.id, row.id)).returning()
      return finishMutation(ctx, updated!)
    }),

  link: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), related: relatedRef }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      const next = row.related.some((r) => r.kind === input.related.kind && r.id === input.related.id)
        ? row.related
        : [...row.related, input.related]
      const [updated] = await ctx.db
        .update(tasks)
        .set({ related: next, updatedAt: new Date() })
        .where(eq(tasks.id, row.id))
        .returning()
      return finishMutation(ctx, updated!)
    }),

  unlink: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), related: relatedRef }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      const next = row.related.filter((r) => !(r.kind === input.related.kind && r.id === input.related.id))
      const [updated] = await ctx.db
        .update(tasks)
        .set({ related: next, updatedAt: new Date() })
        .where(eq(tasks.id, row.id))
        .returning()
      return finishMutation(ctx, updated!)
    }),

  delete: vaultProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      await ctx.db.delete(tasks).where(eq(tasks.id, row.id)) // reminders row cascades
      ctx.bus.emitTasks(ctx.vaultId, { type: 'deleted', taskId: row.id })
      return { ok: true }
    }),

  /** (S) Live board updates for every member (architecture §5). */
  watch: vaultProcedure.subscription(async function* ({ ctx, signal }) {
    for await (const [event] of on(ctx.bus, `tasks:${ctx.vaultId}`, { signal })) {
      yield event as TasksEvent
    }
  }),
})
