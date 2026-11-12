/**
 * The whole fire decision, pure. Given every vault's tasks, the current local
 * wall-clock moment, and a per-vault delivery watermark reader, decide which
 * reminders fire this sweep and what to write back so they never fire twice.
 *
 * No IO, no timers, no Electron — deterministic in `(vaults, now, delivered,
 * viewer)`. A task with assignees reminds only them: `viewer` is the login
 * this machine is signed in as, and someone else's reminder is neither fired
 * nor marked here, so it still fires if the task is handed to this person.
 * `pendingFireTime` (@holi/shared) owns the per-task predicate *including* the
 * fire-once watermark comparison; `sweep` composes it across all vaults and
 * decides coalescing.
 */
import {
  DEFAULT_STATUSES,
  isClosedStatus,
  isOverdue,
  pendingFireTime,
  remindsViewer,
  stampDate,
  stampTime,
} from '@holi/shared'
import type { StatusDef, Task } from '@holi/shared'
import type { ReminderFire, RemindersEvent } from './types'

export interface VaultTasks {
  remote: string
  tasks: Task[]
  /** Null means status lookup failed: explicit reminders still run, fallback does not. */
  statuses?: readonly StatusDef[] | null
}

/** taskPath → last-fired local time, per vault — the `remindedAtLocal` watermark. */
export type Delivered = Record<string, string>

/** Above this many fires in one sweep, `notificationsFor` shows a summary instead. */
const COALESCE_THRESHOLD = 3

export interface SweepMark {
  remote: string
  path: string
  fireAt: string
}

export interface FallbackReceipt {
  has(remote: string, path: string, due: string): boolean
}

/** Stable occurrence key retains whether due names a day or a precise minute. */
export function dueOccurrence(due: string): string | null {
  const date = stampDate(due)
  if (date === null) return null
  const time = stampTime(due)
  return time === null ? date : `${date}T${time}`
}

/** `YYYY-MM-DDTHH:MM` in the machine's own timezone — the frame `pendingFireTime`
 * returns fire times in. `new Date().toISOString()` would be UTC, a different
 * wall-clock, and would mis-fire by the timezone offset. Mirrors `localDate`. */
export function localNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function sweep(
  vaults: VaultTasks[],
  now: string,
  delivered: (remote: string) => Delivered,
  viewer: string | null = null,
  fallbackDelivered: FallbackReceipt = { has: () => false },
): { event: RemindersEvent | null; marks: SweepMark[]; fallbackMarks: SweepMark[] } {
  const fires: ReminderFire[] = []
  const marks: SweepMark[] = []
  const fallbackMarks: SweepMark[] = []

  for (const { remote, tasks, statuses } of vaults) {
    const read = delivered(remote)
    for (const t of tasks) {
      if (!remindsViewer(t, viewer)) continue
      const fire = pendingFireTime(t.status, t.reminder, read[t.path])
      // Both `fire` and `now` are local `YYYY-MM-DDTHH:MM`, so lexicographic
      // compare is chronological — a fire whose time has arrived (or passed,
      // for launch catch-up) is selected.
      if (fire !== null && fire <= now) {
        fires.push({ remote, path: t.path, title: t.title, fireAt: fire })
        marks.push({ remote, path: t.path, fireAt: fire })
        continue
      }

      const due = t.reminder === undefined ? t.due : undefined
      if (due === undefined || t.reminder !== undefined || fire !== null) continue
      const occurrence = dueOccurrence(due)
      if (
        occurrence === null ||
        statuses === null ||
        isClosedStatus(statuses ?? DEFAULT_STATUSES, t.status) ||
        !isOverdue(occurrence, now) ||
        fallbackDelivered.has(remote, t.path, occurrence)
      )
        continue
      fires.push({
        remote,
        path: t.path,
        title: t.title,
        fireAt: now,
        due: occurrence,
        overdue: true,
      })
      fallbackMarks.push({ remote, path: t.path, fireAt: occurrence })
    }
  }

  if (fires.length === 0) return { event: null, marks: [], fallbackMarks: [] }
  return {
    event: { fires, coalesced: fires.length > COALESCE_THRESHOLD, firedAt: now },
    marks,
    fallbackMarks,
  }
}
