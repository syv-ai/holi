/** Materialize tasks.reminder into the reminders table (PRD §reminders):
 * recompute on any mutation touching reminder/due/status/recurrence. */
import { eq } from 'drizzle-orm'
import { pendingFireTime } from '@holi/shared'
import { config } from '../config'
import type { Db } from '../db/client'
import { reminders, type tasks } from '../db/schema'
import { localToUtc, utcToLocal } from './tz'

export async function recomputeReminder(
  db: Db,
  task: typeof tasks.$inferSelect,
  zone: string = config.timezone,
): Promise<void> {
  const remindedAtLocal = task.remindedAt ? utcToLocal(task.remindedAt, zone) : undefined
  const fire = pendingFireTime(task.status, task.reminder ?? undefined, task.due ?? undefined, remindedAtLocal)
  if (fire === null) {
    await db.delete(reminders).where(eq(reminders.taskId, task.id))
    return
  }
  const fireAt = localToUtc(fire, zone)
  await db
    .insert(reminders)
    .values({ taskId: task.id, vaultId: task.vaultId, fireAt, computedFrom: task.reminder })
    .onConflictDoUpdate({
      target: reminders.taskId,
      // Re-arming drops the old fire (firedAt: null). Load-bearing for catch-up (D47):
      // without it, a reconnecting client would replay a fire whose task has since
      // moved past it. A superseded fire is meant to be dropped — the task changed.
      set: { fireAt, firedAt: null, computedFrom: task.reminder },
    })
}
