import { and, eq, isNull } from 'drizzle-orm'
import type { RemindersEvent } from '../bus'
import { listVaultIdsForUser } from '../auth/membership'
import { reminders } from '../db/schema'
import { catchUpDeliveries } from '../reminders/delivery'
import { authedProcedure, router, vaultProcedure } from '../trpc'

export const remindersRouter = router({
  /** Introspection/debug (PRD). */
  listPending: vaultProcedure.query(({ ctx }) =>
    ctx.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.vaultId, ctx.vaultId), isNull(reminders.firedAt))),
  ),

  /**
   * Fires this member missed while disconnected, across **every vault they are in** —
   * raised on connect and after a stream gap (D47). A mutation, not a query: it advances
   * the delivery watermark. Not a client missed-pass — the server owns the ledger and
   * answers the question.
   *
   * There is no per-vault `catchUp` any more. It had exactly one caller, the desktop,
   * which knew its vault because the stream was per-vault; with one stream carrying all
   * of them (D50) a gap means *every* vault missed fires, and a client loop would need
   * the vault list plus N round trips to do worse.
   *
   * Grouped by vault, in the same `{ vaultId, event }` envelope the stream uses, because
   * the notifier needs a vaultId per fire to make the notification clickable (D52) — a
   * flat concat throws away the only thing that could supply it. Vaults with nothing
   * missed are omitted rather than returned empty.
   */
  catchUpAll: authedProcedure.mutation(async ({ ctx }) => {
    const out: Array<{ vaultId: string; event: RemindersEvent }> = []
    for (const vaultId of await listVaultIdsForUser(ctx.db, ctx.user.id)) {
      const event = await catchUpDeliveries(ctx.db, vaultId, ctx.user.id)
      if (event) out.push({ vaultId, event })
    }
    return out
  }),
})
