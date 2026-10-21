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
 *   the trigger's lead is not after now and falls after the schedule's floor:
 *   its watermark as this session first read it (kept with the schedule's
 *   state, so a restart does not fire a moment again), its approval, and
 *   `LATE_MS` back. Each fired moment is remembered for the session, so one
 *   a source tells late (a task made already overdue, a calendar list that
 *   came in after its time) still fires, once.
 * - **A stale list is no list.** A timed source repeats its list; one not
 *   repeated for `STALE_MS` (its plugin stopped, its account went) fires
 *   nothing and keeps the watermark where it was.
 * - **A run does not trigger itself.** While a schedule's run works, its file
 *   events are set aside, not heard: what the run writes is not news to it.
 *   When the run is done the scheduler settles them (`settle`) with the span
 *   the run could have written in, from its start to the end of its last
 *   recorded turn. A file last changed outside that span is someone else's
 *   change and goes to a follow-up batch; one changed inside it cannot be told
 *   from the run's own write and is dropped, as is everything set aside when
 *   no span is known.
 * - **Batch.** What one schedule hears is held from its first event for
 *   `BATCH_MS`, and goes to one run together, keyed by source and id so a
 *   file saved five times is one cause.
 * - **Spacing.** A batch waits until `MIN_SCHEDULE_GAP_MINUTES` after the
 *   schedule's previous run started, the floor cron schedules have.
 * - **A follow-up, not a pile.** While the previous run works, the batch keeps
 *   growing and is the one run that follows (the scheduler leaves it here).
 * - **Identifiers, not text.** The run's line is built here from each cause's
 *   source, kind and identifiers, each one stripped of control and line
 *   characters, cut short and quoted; a mail's sender only when it is a plain
 *   address. Nothing a source wrote as prose reaches a prompt.
 *
 * Not durable: a held batch and the dedupe memory live in memory, so a
 * restart loses events heard and not yet run (moments excepted, by the
 * watermark). docs/not-built.md.
 */
import {
  appBundleOf,
  isAppPrivatePath,
  isLocalOnlyPath,
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
/** How far back a moment told late may still fire. */
export const LATE_MS = 24 * 60 * 60_000
/** A timed source's list not told again for this long is ignored: two of the
 *  slowest source's (Google's) five-minute looks, and some. */
export const STALE_MS = 12 * 60_000
/** At most this many causes are named in a run's line; the rest are counted. */
const NAMED = 5
/** The longest an identifier is in the line, and the whole line. */
const ID_MAX = 100
const LINE_MAX = 800
/** Fired moments remembered per schedule, newest kept. */
const FIRED_MAX = 2_000
/** A sender address fit to name: nothing but an address's plain characters. */
const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/

export interface RoutedSchedule {
  path: string
  on: readonly Trigger[]
}

/** One thing that started a run, as structured fields. */
export type Cause =
  | { source: 'file'; kind: 'added' | 'changed'; id: string }
  | { source: 'mail'; id: string; from?: string }
  | { source: 'task'; kind: 'due' | 'overdue'; id: string }
  | { source: 'calendar'; id: string; at: number }

type FileCause = Extract<Cause, { source: 'file' }>

export interface Batch {
  /** One per source and id, in the order first heard. */
  causes: Cause[]
}

export type MomentSource = 'task' | 'calendar'

export interface MomentFloor {
  /** The persisted watermark per source. */
  since(source: MomentSource): number
  /** When the schedule was turned on. */
  approvedAt: number
}

export interface TriggerRouter {
  /** Hear an event: an occurrence is held for each schedule that listens for
   *  it; a timed source's list replaces the last one. */
  hear(event: VaultEvent, schedules: readonly RoutedSchedule[], now: number): void
  /**
   * Hold the moments that came due for `schedule` and have not fired. Returns
   * the watermarks that move to now: only those of the timed sources with a
   * fresh list. One that has none (Google not connected, a source not started
   * yet, one gone quiet) keeps its watermark, so its moments are not lost by
   * moving past them unknown.
   */
  sweep(
    schedule: RoutedSchedule,
    floor: MomentFloor,
    now: number,
  ): Partial<Record<MomentSource, number>>
  /** Whether `path`'s run is working: its file events are set aside. */
  running(path: string, working: boolean): void
  /**
   * The file events set aside while `path`'s run worked: those last changed
   * outside `span` (ms, inclusive bounds are the run's) are held as a batch,
   * the rest dropped; a null span drops them all. Returns how many were held.
   */
  settle(path: string, span: { from: number; to: number } | null, now: number): number
  /** The batch due for `path` now, if any, left held; `take` removes it. */
  due(path: string, now: number, lastStarted: number | null): Batch | null
  take(path: string): void
  /** Forget every schedule but these: turned off, changed, deleted. */
  keep(paths: ReadonlySet<string>): void
}

export function createTriggerRouter(): TriggerRouter {
  const held = new Map<string, { first: number; causes: Map<string, Cause> }>()
  const seen = new Map<string, number>()
  const moments = new Map<MomentSource, { heard: number; list: Moment[] }>()
  /** Per schedule and source, the watermark this session first read. */
  const floors = new Map<string, number>()
  /** Per schedule, each fired moment's key and fire time. */
  const fired = new Map<string, Map<string, number>>()
  const working = new Set<string>()
  /** Per working schedule, its file events set aside by source and id: the
   *  cause, the event's dedupe key, and when the file last changed. */
  const aside = new Map<string, Map<string, { cause: FileCause; seenKey: string; at: number }>>()

  function hold(path: string, key: string, cause: Cause, now: number): void {
    let batch = held.get(path)
    if (batch === undefined) {
      batch = { first: now, causes: new Map() }
      held.set(path, batch)
    }
    batch.causes.set(key, cause)
  }

  return {
    hear(event, schedules, now) {
      if (event.type === 'upcoming') {
        moments.set(event.source, { heard: now, list: event.moments })
        return
      }
      if (event.type !== 'happened') return
      for (const [key, until] of seen) if (until <= now) seen.delete(key)
      for (const s of schedules) {
        if (!s.on.some((t) => triggerHears(t, event))) continue
        const key = `${s.path}\u0000${event.source}\u0000${event.id}\u0000${event.version}`
        if (
          event.source === 'file' &&
          working.has(s.path) &&
          (event.kind === 'added' || event.kind === 'changed')
        ) {
          // The newest version of each file wins: it is the last change that
          // says whose it was.
          let set = aside.get(s.path)
          if (set === undefined) {
            set = new Map()
            aside.set(s.path, set)
          }
          // Added and then changed is still added.
          const kind = set.get(event.id)?.cause.kind ?? event.kind
          set.set(event.id, {
            cause: { source: 'file', kind, id: event.id },
            seenKey: key,
            at: Date.parse(event.version),
          })
          continue
        }
        if (event.source === 'file' && working.has(s.path)) continue
        if (seen.has(key)) continue
        seen.set(key, now + DEDUPE_MS)
        const cause: Cause | null =
          event.source === 'mail'
            ? { source: 'mail', id: event.id, ...(event.from ? { from: event.from } : {}) }
            : event.kind === 'added' || event.kind === 'changed'
              ? { source: 'file', kind: event.kind, id: event.id }
              : null
        if (cause !== null) hold(s.path, `${event.source}\u0000${event.id}`, cause, now)
      }
    },

    sweep(schedule, floor, now) {
      const moved: Partial<Record<MomentSource, number>> = {}
      let done = fired.get(schedule.path)
      if (done === undefined) {
        done = new Map()
        fired.set(schedule.path, done)
      }
      for (const source of ['task', 'calendar'] as const) {
        if (!schedule.on.some((t) => t.source === source)) continue
        const fkey = `${schedule.path}\u0000${source}`
        let first = floors.get(fkey)
        if (first === undefined) {
          first = floor.since(source)
          floors.set(fkey, first)
        }
        const from = Math.max(first, floor.approvedAt, now - LATE_MS)
        for (const [key, at] of done) if (at <= from) done.delete(key)
        const told = moments.get(source)
        if (told === undefined || now - told.heard > STALE_MS) continue
        for (const m of told.list) {
          for (const t of schedule.on) {
            const at = momentFireAt(t, source, m)
            if (at === null || at <= from || at > now) continue
            const key = `${source}\u0000${m.id}\u0000${m.kind}\u0000${at}`
            if (done.has(key)) continue
            done.set(key, at)
            const cause: Cause =
              source === 'task'
                ? { source, kind: m.kind === 'due' ? 'due' : 'overdue', id: m.id }
                : { source, id: m.id, at: Date.parse(m.at) }
            hold(schedule.path, `${source}\u0000${m.id}\u0000${m.kind}`, cause, now)
          }
        }
        moved[source] = now
      }
      // Bounded: the oldest go first.
      while (done.size > FIRED_MAX) done.delete(done.keys().next().value!)
      return moved
    },

    running(path, w) {
      if (w) working.add(path)
      else working.delete(path)
    },

    settle(path, span, now) {
      const set = aside.get(path)
      aside.delete(path)
      if (set === undefined || span === null) return 0
      let held = 0
      for (const [id, { cause, seenKey, at }] of set) {
        // An unreadable time is no proof it was someone else's.
        if (Number.isNaN(at) || (at >= span.from && at <= span.to)) continue
        if (seen.has(seenKey)) continue
        seen.set(seenKey, now + DEDUPE_MS)
        hold(path, `file\u0000${id}`, cause, now)
        held++
      }
      return held
    },

    due(path, now, lastStarted) {
      const batch = held.get(path)
      if (batch === undefined || now - batch.first < BATCH_MS) return null
      if (lastStarted !== null && now - lastStarted < MIN_SCHEDULE_GAP_MINUTES * 60_000) {
        return null
      }
      return { causes: [...batch.causes.values()] }
    },

    take(path) {
      held.delete(path)
    },

    keep(paths) {
      const keeps = (key: string): boolean => paths.has(key.slice(0, key.indexOf('\u0000')))
      for (const path of held.keys()) if (!paths.has(path)) held.delete(path)
      for (const path of fired.keys()) if (!paths.has(path)) fired.delete(path)
      for (const path of working) if (!paths.has(path)) working.delete(path)
      for (const path of aside.keys()) if (!paths.has(path)) aside.delete(path)
      for (const key of seen.keys()) if (!keeps(key)) seen.delete(key)
      for (const key of floors.keys()) if (!keeps(key)) floors.delete(key)
    },
  }
}

/** An identifier, fit for the line: no control, format or line characters,
 *  cut short, and quoted so it reads as a value and nothing more. */
function quote(id: string): string {
  const bare = id.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim()
  return JSON.stringify(bare.length > ID_MAX ? `${bare.slice(0, ID_MAX - 1)}…` : bare)
}

const pad = (n: number): string => String(n).padStart(2, '0')

function describeCause(c: Cause): string {
  switch (c.source) {
    case 'file':
      return `file ${quote(c.id)} ${c.kind}`
    case 'mail':
      return c.from !== undefined && ADDRESS.test(c.from)
        ? `mail thread ${quote(c.id)} from ${quote(c.from)}`
        : `mail thread ${quote(c.id)}`
    case 'task':
      return `task ${quote(c.id)} ${c.kind}`
    case 'calendar': {
      const at = new Date(c.at)
      const time = Number.isNaN(at.getTime())
        ? ''
        : ` at ${pad(at.getHours())}:${pad(at.getMinutes())}`
      return `calendar event ${quote(c.id)} starts${time}`
    }
  }
}

/** What a batch says in the run's line: `file "inbox/a.pdf" added; task
 *  "t.md" overdue; and 3 more`, never longer than `LINE_MAX`. */
export function describeBatch(batch: Batch): string {
  const parts: string[] = []
  let length = 0
  for (const c of batch.causes.slice(0, NAMED)) {
    const part = describeCause(c)
    if (length + part.length + 2 > LINE_MAX - 20) break
    parts.push(part)
    length += part.length + 2
  }
  const more = batch.causes.length - parts.length
  return more > 0 ? `${parts.join('; ')}; and ${more} more` : parts.join('; ')
}

/** Folders whose files are Holi's and the agent's own, never a trigger's:
 *  a run writes there (memory, schedules, settings) as a matter of course. */
const QUIET = ['.holi/', '.claude/']

/** Whether a file's change may be a trigger's event, and so be named in a
 *  run's line: not Holi's or the agent's own folders, not this machine's
 *  files (`.local.`) or a secret file, and not an app's records or log, which
 *  an app rewrites as it runs. A root `AGENTS.md`, `CLAUDE.md` or `MEMORY.md`
 *  is heard: it is fenced from apps, not from triggers. */
function heardFile(path: string): boolean {
  if (QUIET.some((dir) => path.startsWith(dir)) || isLocalOnlyPath(path)) return false
  const bundle = appBundleOf(path)
  return bundle === null || !isAppPrivatePath(path.slice(bundle.length + 1))
}

/**
 * The file events between two scans of the vault: a note or file whose path
 * is new is `added`, one whose mtime moved is `changed`. Files a plugin
 * claims (tasks) are not in either list, and have their own source; nor is
 * any file `heardFile` holds back. The
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
    if (!heardFile(f.path)) continue
    const prior = was.get(f.path)
    if (prior === f.updatedAt) continue
    const kind = prior === undefined ? 'added' : 'changed'
    out.push({
      type: 'happened',
      source: 'file',
      kind,
      id: f.path,
      version: f.updatedAt,
    })
  }
  return out
}
