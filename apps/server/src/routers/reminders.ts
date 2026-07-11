import { on } from 'node:events'
import { and, eq } from 'drizzle-orm'
import type { RemindersEvent } from '../bus'
import { reminders } from '../db/schema'
import { router, vaultProcedure } from '../trpc'

export const remindersRouter = router({
  /** Introspection/debug (PRD). */
  listPending: vaultProcedure.query(({ ctx }) =>
    ctx.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.vaultId, ctx.vaultId), eq(reminders.fired, false))),
  ),

  /** (S) Fire events → client raises the native notification (D19). */
  subscribe: vaultProcedure.subscription(async function* ({ ctx, signal }) {
    for await (const [event] of on(ctx.bus, `reminders:${ctx.vaultId}`, { signal })) {
      yield event as RemindersEvent
    }
  }),
})
