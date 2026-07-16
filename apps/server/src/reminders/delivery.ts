/**
 * Per-member reminder delivery (D47).
 *
 * The evaluator fires centrally and pushes; that half was always right. What was missing
 * is that pushing is not delivering — `tick()` stamped the fire and emitted into a bare
 * EventEmitter, so with no SSE listener the fire evaporated while the row said it had
 * happened. This module is the ledger that makes "the app was closed" survivable.
 *
 * A watermark per `(vault, user)`, not a flag per reminder: a fire concerns every member
 * (a `Task` has no assignee), so "delivered" is a fact about a *person*, not about the
 * reminder. It lives here rather than in `per_user_state` — that table fits the shape but
 * is client-writable, and a client that can move its own watermark can silently switch off
 * its own reminders.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { RemindersEvent } from '../bus'
import { reminderDeliveries, reminders, tasks } from '../db/schema'
import { config } from '../config'
import { utcToLocal } from './tz'

/** Mirrors the evaluator's threshold — above this, clients raise one summary. */
const COALESCE_THRESHOLD = 5

/** Advance this member's watermark. Monotonic on purpose: a late or out-of-order call
 * must never rewind it and re-notify everything since. */
export async function markDelivered(
  db: Db,
  vaultId: string,
  userId: string,
  firedAt: string,
): Promise<void> {
  const seenAt = new Date(firedAt)
  await db
    .insert(reminderDeliveries)
    .values({ vaultId, userId, seenAt })
    .onConflictDoUpdate({
      target: [reminderDeliveries.vaultId, reminderDeliveries.userId],
      // `excluded` is the row we just tried to insert — greatest() against it keeps the
      // advance monotonic without rebinding the timestamp.
      set: { seenAt: sql`greatest(${reminderDeliveries.seenAt}, excluded.seen_at)` },
    })
}

/**
 * Fires this member missed, and the watermark advanced past exactly those.
 *
 * Returns null when there is nothing to raise — including the first-ever connect, which
 * starts the watermark at `now` rather than replaying the vault's whole history at
 * someone who just joined.
 */
export async function catchUpDeliveries(
  db: Db,
  vaultId: string,
  userId: string,
): Promise<RemindersEvent | null> {
  const [existing] = await db
    .select({ seenAt: reminderDeliveries.seenAt })
    .from(reminderDeliveries)
    .where(and(eq(reminderDeliveries.vaultId, vaultId), eq(reminderDeliveries.userId, userId)))

  if (!existing) {
    await db.insert(reminderDeliveries).values({ vaultId, userId, seenAt: new Date() })
    return null
  }

  const missed = await db
    .select({ taskId: reminders.taskId, title: tasks.title, fireAt: reminders.fireAt, firedAt: reminders.firedAt })
    .from(reminders)
    .innerJoin(tasks, eq(tasks.id, reminders.taskId))
    // `firedAt > seenAt` also excludes the pending and the re-armed for free: in SQL
    // `null > x` is null, never true. A superseded fire is meant to vanish — its task
    // moved past it.
    .where(and(eq(reminders.vaultId, vaultId), gt(reminders.firedAt, existing.seenAt)))
    .orderBy(asc(reminders.firedAt))
  if (missed.length === 0) return null

  // Advance to what we actually return, not to now(): a fire landing between the read
  // and the write would otherwise be stepped over and lost — the exact bug class this
  // module exists to close.
  const high = missed.reduce((max, m) => (m.firedAt! > max ? m.firedAt! : max), missed[0]!.firedAt!)
  await markDelivered(db, vaultId, userId, high.toISOString())

  return {
    fires: missed.map((m) => ({
      taskId: m.taskId,
      title: m.title,
      fireAt: utcToLocal(m.fireAt, config.timezone),
    })),
    coalesced: missed.length > COALESCE_THRESHOLD,
    firedAt: high.toISOString(),
  }
}
