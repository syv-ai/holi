/**
 * The whole fire decision, pure. Given every vault's tasks, the current local
 * wall-clock moment, and a per-vault delivery watermark reader, decide which
 * reminders fire this sweep and what to write back so they never fire twice.
 *
 * No IO, no timers, no Electron — deterministic in `(vaults, now, delivered)`.
 * `pendingFireTime` (@holi/shared) owns the per-task predicate *including* the
 * fire-once watermark comparison; `sweep` composes it across all vaults and
 * decides coalescing.
 */
import { pendingFireTime } from '@holi/shared'
import type { Task } from '@holi/shared'
import type { ReminderFire, RemindersEvent } from './types'

export interface VaultTasks {
  remote: string
  tasks: Task[]
}

/** taskPath → last-fired local time, per vault — the `remindedAtLocal` watermark. */
export type Delivered = Record<string, string>

/** Above this many fires in one sweep, `notificationsFor` shows a summary instead. */
export const COALESCE_THRESHOLD = 3

export interface SweepMark {
  remote: string
  path: string
  fireAt: string
}

/** `YYYY-MM-DDTHH:MM` in the machine's own timezone — the frame `pendingFireTime`
 * returns fire times in. `new Date().toISOString()` would be UTC, a different
 * wall-clock, and would mis-fire by the timezone offset. Mirrors `localToday`. */
export function localNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function sweep(
  vaults: VaultTasks[],
  now: string,
  delivered: (remote: string) => Delivered,
): { event: RemindersEvent | null; marks: SweepMark[] } {
  const fires: ReminderFire[] = []
  const marks: SweepMark[] = []

  for (const { remote, tasks } of vaults) {
    const read = delivered(remote)
    for (const t of tasks) {
      const fire = pendingFireTime(t.status, t.reminder, read[t.path])
      // Both `fire` and `now` are local `YYYY-MM-DDTHH:MM`, so lexicographic
      // compare is chronological — a fire whose time has arrived (or passed,
      // for launch catch-up) is selected.
      if (fire === null || fire > now) continue
      fires.push({ remote, path: t.path, title: t.title, fireAt: fire })
      marks.push({ remote, path: t.path, fireAt: fire })
    }
  }

  if (fires.length === 0) return { event: null, marks: [] }
  return {
    event: { fires, coalesced: fires.length > COALESCE_THRESHOLD, firedAt: now },
    marks,
  }
}
