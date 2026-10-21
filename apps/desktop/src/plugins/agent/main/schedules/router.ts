/**
 * The trigger router (docs/features/scheduled-agents.md, Triggers): between
 * the events the vault's plugins tell each other and the runs of the
 * schedules that listen for them. Pure: no IO, no timers; the scheduler
 * calls it on its half-minute check with the clock.
 *
 * - **Dedupe.** An occurrence is heard once per schedule for its source, id
 *   and version (a file's path and mtime, a thread and its latest message)
 *   within `DEDUPE_MS`, however often it is told.
 * - **Moments fire once.** A timed source's moment fires when its time minus
 *   the trigger's lead falls after the schedule's watermark and not after
 *   now; the watermark then moves to now and is kept with the schedule's
 *   state, so a restart does not fire it again, and moments that passed while
 *   Holi was closed collapse into the next run, like missed cron moments.
 * - **Batch.** What one schedule hears is held from its first event for
 *   `BATCH_MS`, and goes to one run together, keyed by source and id so a
 *   file saved five times is one line.
 * - **Spacing.** A batch waits until `MIN_SCHEDULE_GAP_MINUTES` after the
 *   schedule's previous run started, the floor cron schedules have.
 * - **A follow-up, not a pile.** While the previous run works, the batch keeps
 *   growing and is the one run that follows (the scheduler leaves it here).
 *
 * Not durable: a held batch and the dedupe memory live in memory, so a
 * restart loses events heard and not yet run (moments excepted, by the
 * watermark). docs/not-built.md.
 */
import {
  MIN_SCHEDULE_GAP_MINUTES,
  momentFireAt,
  triggerHears,
  type Moment,
  type Trigger,
  type VaultEvent,
  type VaultSnapshot,
} from '@holi/shared'

/** How long a batch gathers before it runs. */
export const BATCH_MS = 60_000
/** How long an occurrence's id and version are remembered. */
export const DEDUPE_MS = 60 * 60_000
/** At most this many causes are named in a run's line; the rest are counted. */
const NAMED = 5
const LABEL_MAX = 160

export interface RoutedSchedule {
  path: string
  on: readonly Trigger[]
}

export interface Batch {
  /** One label per source and id, in the order first heard. */
  labels: string[]
}

export type MomentSource = 'task' | 'calendar'

export interface TriggerRouter {
  /** Hear an event: an occurrence is held for each schedule that listens for
   *  it; a timed source's list replaces the last one. */
  hear(event: VaultEvent, schedules: readonly RoutedSchedule[], now: number): void
  /**
   * Hold the moments that came due for `schedule` after each source's
   * watermark `since(source)`. Returns the watermarks that move to now: only
   * those of the timed sources that have spoken since the router started.
   * One that has not (Google not connected, a source not started yet) keeps
   * its watermark, so its moments are not lost by moving past them unknown.
   */
  sweep(
    schedule: RoutedSchedule,
    since: (source: MomentSource) => number,
    now: number,
  ): Partial<Record<MomentSource, number>>
  /** The batch due for `path` now, if any, left held; `take` removes it. */
  due(path: string, now: number, lastStarted: number | null): Batch | null
  take(path: string): void
  /** Forget every schedule but these: turned off, changed, deleted. */
  keep(paths: ReadonlySet<string>): void
}

/** One line, bounded: a label never carries a line break into a prompt. */
const clean = (label: string): string => {
  const one = label.replace(/[\r\n\t]+/g, ' ').trim()
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1)}…` : one
}

export function createTriggerRouter(): TriggerRouter {
  const held = new Map<string, { first: number; labels: Map<string, string> }>()
  const seen = new Map<string, number>()
  const moments = new Map<MomentSource, Moment[]>()

  function hold(path: string, key: string, label: string, now: number): void {
    let batch = held.get(path)
    if (batch === undefined) {
      batch = { first: now, labels: new Map() }
      held.set(path, batch)
    }
    batch.labels.set(key, clean(label))
  }

  return {
    hear(event, schedules, now) {
      if (event.type === 'upcoming') {
        moments.set(event.source, event.moments)
        return
      }
      if (event.type !== 'happened') return
      for (const [key, until] of seen) if (until <= now) seen.delete(key)
      for (const s of schedules) {
        if (!s.on.some((t) => triggerHears(t, event))) continue
        const key = `${s.path}\u0000${event.source}\u0000${event.id}\u0000${event.version}`
        if (seen.has(key)) continue
        seen.set(key, now + DEDUPE_MS)
        hold(s.path, `${event.source}\u0000${event.id}`, event.label, now)
      }
    },

    sweep(schedule, since, now) {
      const moved: Partial<Record<MomentSource, number>> = {}
      for (const source of ['task', 'calendar'] as const) {
        const list = moments.get(source)
        if (list === undefined || !schedule.on.some((t) => t.source === source)) continue
        const from = since(source)
        for (const m of list) {
          for (const t of schedule.on) {
            const at = momentFireAt(t, source, m)
            if (at === null || at <= from || at > now) continue
            hold(schedule.path, `${source}\u0000${m.id}\u0000${m.kind}`, m.label, now)
          }
        }
        moved[source] = now
      }
      return moved
    },

    due(path, now, lastStarted) {
      const batch = held.get(path)
      if (batch === undefined || now - batch.first < BATCH_MS) return null
      if (lastStarted !== null && now - lastStarted < MIN_SCHEDULE_GAP_MINUTES * 60_000) {
        return null
      }
      return { labels: [...batch.labels.values()] }
    },

    take(path) {
      held.delete(path)
    },

    keep(paths) {
      for (const path of held.keys()) if (!paths.has(path)) held.delete(path)
      for (const key of seen.keys()) {
        if (!paths.has(key.slice(0, key.indexOf('\u0000')))) seen.delete(key)
      }
    },
  }
}

/** What a batch says in the run's one line: "file inbox/a.pdf added; task
 *  t.md overdue; and 3 more". */
export function describeBatch(batch: Batch): string {
  const named = batch.labels.slice(0, NAMED).join('; ')
  const more = batch.labels.length - NAMED
  return more > 0 ? `${named}; and ${more} more` : named
}

/**
 * The file events between two scans of the vault: a note or file whose path
 * is new is `added`, one whose mtime moved is `changed`. Files a plugin
 * claims (tasks) are not in either list, and have their own source. The
 * first scan after a start has nothing to compare with and says nothing:
 * a file added while Holi was closed is not an event.
 */
export function fileEvents(
  before: VaultSnapshot,
  after: VaultSnapshot,
): (VaultEvent & { type: 'happened' })[] {
  const was = new Map<string, string>()
  for (const f of [...before.docs, ...before.files]) was.set(f.path, f.updatedAt)
  const out: (VaultEvent & { type: 'happened' })[] = []
  for (const f of [...after.docs, ...after.files]) {
    const prior = was.get(f.path)
    if (prior === f.updatedAt) continue
    const kind = prior === undefined ? 'added' : 'changed'
    out.push({
      type: 'happened',
      source: 'file',
      kind,
      id: f.path,
      version: f.updatedAt,
      label: `file ${f.path} ${kind}`,
    })
  }
  return out
}
