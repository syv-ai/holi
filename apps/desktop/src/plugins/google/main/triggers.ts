/**
 * Google as a trigger source for scheduled agents
 * (docs/features/scheduled-agents.md, Triggers): the next day's timed events
 * as moments, and new mail in the threads a schedule's Gmail query finds.
 *
 * **It polls only while an approved schedule listens**, and only for what it
 * listens for: the agent says so at every check (`interest`), and with
 * nothing listening there is no timer and no request. Every few minutes then:
 * the agenda (one request per calendar), and each query through the mail
 * cache's `history.list` delta, one request when nothing is new.
 *
 * **Mail is what changed while Holi watched.** A query's first look is the
 * baseline, so a restart does not fire on the mail already there; what
 * arrived while Holi was closed is a cron schedule's to catch. A thread
 * fires when it is new to the query or its latest message is, and not when
 * that message is yours (`answered`): a reply sent from a run must not start
 * the next one.
 *
 * Only identifiers leave here, as structured fields: a thread id and the
 * sender's address, an event id and its start. Subjects, snippets and titles
 * are third-party text, and a run fetches them itself through `holi google`;
 * the trigger router builds the run's line and checks the address again.
 *
 * **Its calendar list never outlives what it knows.** No account, or this
 * plugin stopping, tells an empty list; and interest not told again for
 * `INTEREST_MS` (the agent stopped without saying so) is no interest, so the
 * polling stops with it.
 */
import type { CalendarOverrides } from './calendar'
import type { GoogleData } from './data'
import type { Disposer, PluginCtx } from '../../../main/plugin-api'
import { NO_INTEREST, type Moment, type TriggerInterest } from '@holi/shared'

/** How often to look while something listens. */
const POLL_MS = 5 * 60_000
/** How far ahead the agenda is read: a trigger's longest lead, and an hour
 *  back for an event that has just started. */
const AHEAD_MS = 25 * 3_600_000
const BEHIND_MS = 3_600_000
/** Threads read per query: the newest. */
const THREADS = 25
/** The agent tells its interest every half minute; this long without it,
 *  nothing listens any more. */
const INTEREST_MS = 3 * 60_000

export interface GoogleTriggerDeps {
  /** The open vault's Google data, or null when it has no account. */
  data(): Promise<GoogleData | null>
  overrides(): Promise<CalendarOverrides>
  pollMs?: number
  now?: () => Date
  log?: (msg: string) => void
}

export function startGoogleTriggers(ctx: PluginCtx, deps: GoogleTriggerDeps): Disposer {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((msg: string) => console.log(`[google triggers] ${msg}`))
  let interest: TriggerInterest = NO_INTEREST
  let toldAt = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false
  let stopped = false
  /** Per query, each thread's version as last seen. */
  const seen = new Map<string, Map<string, string>>()

  async function calendar(data: GoogleData): Promise<void> {
    const at = now().getTime()
    const events = await data.fetchAgenda(
      {
        timeMin: new Date(at - BEHIND_MS).toISOString(),
        timeMax: new Date(at + AHEAD_MS).toISOString(),
      },
      await deps.overrides(),
    )
    const moments: Moment[] = events
      .filter((e) => !e.allDay)
      .map((e) => ({ id: e.id, kind: 'starts', at: new Date(e.start).toISOString() }))
    if (!stopped) ctx.events.emit({ type: 'upcoming', source: 'calendar', moments })
  }

  async function mail(data: GoogleData, query: string): Promise<void> {
    const page = await data.threads({ query, limit: THREADS })
    const before = seen.get(query)
    const after = new Map<string, string>()
    for (const t of page.threads) {
      const version = `${t.messageCount}:${t.date}`
      after.set(t.id, version)
      if (before === undefined || before.get(t.id) === version || t.answered || stopped) continue
      ctx.events.emit({
        type: 'happened',
        source: 'mail',
        kind: 'new',
        id: t.id,
        version,
        query,
        from: t.from.email,
      })
    }
    seen.set(query, after)
  }

  async function poll(): Promise<void> {
    if (polling || stopped) return
    if (now().getTime() - toldAt > INTEREST_MS) {
      quiet()
      return
    }
    polling = true
    try {
      const data = await deps.data()
      if (data === null) {
        if (interest.calendar && !stopped) {
          ctx.events.emit({ type: 'upcoming', source: 'calendar', moments: [] })
        }
        return
      }
      if (interest.calendar) {
        await calendar(data).catch((err: unknown) => log(`agenda: ${String(err)}`))
      }
      for (const query of interest.mail) {
        await mail(data, query).catch((err: unknown) => log(`mail ${query}: ${String(err)}`))
      }
    } finally {
      polling = false
    }
  }

  /** Nothing listens: no timer, no baselines. */
  function quiet(): void {
    interest = NO_INTEREST
    seen.clear()
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  const unhear = ctx.events.on((event) => {
    if (event.type !== 'interest') return
    const was = interest
    interest = event.interest
    toldAt = now().getTime()
    for (const query of seen.keys()) if (!interest.mail.includes(query)) seen.delete(query)
    const wants = interest.calendar || interest.mail.length > 0
    if (!wants) {
      quiet()
      return
    }
    const fresh =
      timer === null ||
      (interest.calendar && !was.calendar) ||
      interest.mail.some((q) => !was.mail.includes(q))
    if (timer === null) timer = setInterval(() => void poll(), deps.pollMs ?? POLL_MS)
    if (fresh) void poll()
  })

  return () => {
    // What it told of the calendar goes with it.
    if (interest.calendar) ctx.events.emit({ type: 'upcoming', source: 'calendar', moments: [] })
    stopped = true
    unhear()
    if (timer !== null) clearInterval(timer)
    timer = null
  }
}
