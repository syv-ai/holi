/** The task API. Input validation + a call into `tasks/mutations.ts`, which is the
 * one place a task actually changes — the git ingester is the other caller. */
import { and, eq } from 'drizzle-orm'
import { on } from 'node:events'
import { z } from 'zod'
import type { TasksEvent } from '../bus'
import { toTask } from '../db/mappers'
import { tasks } from '../db/schema'
import {
  completeTask,
  createTask,
  deleteTask,
  linkTask,
  patchTask,
  taskInVault,
  unlinkTask,
} from '../tasks/mutations'
import { router, vaultProcedure } from '../trpc'

const relatedRef = z.object({ kind: z.enum(['note', 'task', 'email', 'event']), id: z.string() })
const recurrence = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1),
  weekdays: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional(),
  endDate: z.string().optional(),
})
/** The nullable fields accept an explicit `null` to **clear** them.
 *
 * This is what lets a task file delete a field: removing `due:` from the
 * frontmatter has to reach the record as "clear it", and an `undefined` in the
 * patch is indistinguishable from "not mentioned" — Drizzle would drop it and
 * the due date would silently survive its own deletion. */
const taskFields = {
  title: z.string().min(1),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  area: z.string().uuid().nullable().optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.enum(['low', 'medium', 'high']).nullable().optional(),
  tags: z.array(z.string()).optional(),
  reminder: z.string().nullable().optional(),
  recurrence: recurrence.nullable().optional(),
  related: z.array(relatedRef).optional(),
  /** The task file's markdown body. */
  description: z.string().nullable().optional(),
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
    .mutation(({ ctx, input }) => createTask(ctx, ctx.vaultId, input)),

  update: vaultProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        patch: z.object(taskFields).partial(),
        version: z.number().int().optional(),
      }),
    )
    .mutation(({ ctx, input }) => patchTask(ctx, ctx.vaultId, input.taskId, input.patch, input.version)),

  complete: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), version: z.number().int().optional() }))
    .mutation(({ ctx, input }) => completeTask(ctx, ctx.vaultId, input.taskId, input.version)),

  link: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), related: relatedRef }))
    .mutation(({ ctx, input }) => linkTask(ctx, ctx.vaultId, input.taskId, input.related)),

  unlink: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), related: relatedRef }))
    .mutation(({ ctx, input }) => unlinkTask(ctx, ctx.vaultId, input.taskId, input.related)),

  delete: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), version: z.number().int().optional() }))
    .mutation(async ({ ctx, input }) => {
      await deleteTask(ctx, ctx.vaultId, input.taskId, input.version)
      return { ok: true }
    }),

  /** (S) Live board updates for every member (architecture §5). */
  watch: vaultProcedure.subscription(async function* ({ ctx, signal }) {
    for await (const [event] of on(ctx.bus, `tasks:${ctx.vaultId}`, { signal })) {
      yield event as TasksEvent
    }
  }),
})
