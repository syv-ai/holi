/** The single server-side reminder loop (D19). tick() is separable for tests;
 * start() runs the sleep-until-earliest loop, woken by bus 'evaluator:wake'. */
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { Bus, ReminderFire } from '../bus'
import type { Db } from '../db/client'
import { reminders, tasks } from '../db/schema'
import { utcToLocal } from './tz'
import { config } from '../config'

const COALESCE_THRESHOLD = 5
const MAX_SLEEP_MS = 60_000 // re-check at least every minute (clock drift, missed wakes)

export function createReminderEvaluator(deps: { db: Db; bus: Bus }) {
  const { db, bus } = deps
  let timer: NodeJS.Timeout | undefined
  let running = false
  let stopped = false

  /** Fire everything due; returns when the projection is drained to now. */
  async function tick(now = new Date()): Promise<void> {
    const due = await db
      .select({ id: reminders.id, taskId: reminders.taskId, vaultId: reminders.vaultId, fireAt: reminders.fireAt, title: tasks.title })
      .from(reminders)
      .innerJoin(tasks, eq(tasks.id, reminders.taskId))
      .where(and(isNull(reminders.firedAt), lte(reminders.fireAt, now)))
    if (due.length === 0) return
    // `now` is the fire instant every fire in this batch shares — it is what the
    // per-user delivery watermark advances on (D47), so it rides the event too.
    await db.update(reminders).set({ firedAt: now }).where(inArray(reminders.id, due.map((d) => d.id)))
    await db.update(tasks).set({ remindedAt: now }).where(inArray(tasks.id, due.map((d) => d.taskId)))
    const byVault = new Map<string, ReminderFire[]>()
    for (const d of due) {
      const fires = byVault.get(d.vaultId) ?? []
      fires.push({ taskId: d.taskId, title: d.title, fireAt: utcToLocal(d.fireAt, config.timezone) })
      byVault.set(d.vaultId, fires)
    }
    for (const [vaultId, fires] of byVault) {
      bus.emitReminders(vaultId, {
        fires,
        coalesced: fires.length > COALESCE_THRESHOLD,
        firedAt: now.toISOString(),
      })
    }
  }

  async function schedule(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      await tick()
    } catch (err) {
      console.error('[reminders] tick failed', err)
    } finally {
      running = false
    }
    if (stopped) return
    const [next] = await db
      .select({ fireAt: reminders.fireAt })
      .from(reminders)
      .where(isNull(reminders.firedAt))
      .orderBy(asc(reminders.fireAt))
      .limit(1)
    const delay = next
      ? Math.min(Math.max(next.fireAt.getTime() - Date.now(), 0), MAX_SLEEP_MS)
      : MAX_SLEEP_MS
    clearTimeout(timer)
    timer = setTimeout(() => void schedule(), delay)
  }

  return {
    tick,
    /** Boot: first schedule() run doubles as the missed-reminder pass. */
    start(): void {
      bus.on('evaluator:wake', () => void schedule())
      void schedule()
    },
    stop(): void {
      stopped = true
      clearTimeout(timer)
    },
  }
}
