/**
 * The **UI's** Google data — the one place caching is decided.
 *
 * The agent does not come through here, and that is the point. `holi-google`
 * asks for current data and must never be handed a stale answer (D67, "Do not
 * cache"), so the ops server in `main/index.ts` is wired straight to
 * `listAgenda` / `listThreads` — functions that take no cache and therefore
 * cannot read one. The exclusion is structural rather than remembered.
 *
 * The two surfaces are cached differently because the APIs differ:
 *
 * - **Mail** goes through `syncThreads`: cache plus a `history.list` delta, so
 *   the answer is both instant and current, for one request instead of 26.
 * - **Calendar** gets a cache for *paint*, and always refetches. Google's
 *   `syncToken` cannot be combined with `timeMin`/`timeMax`, so an incremental
 *   agenda would mean mirroring every event at every date to serve a 7-day
 *   view. `cachedAgenda` is what the panel paints while `agenda` is in flight.
 */
import type { GoogleApi } from './api'
import type { GoogleCache } from './cache'
import {
  listAgenda,
  type AgendaWindow,
  type CalendarEvent,
  type CalendarOverrides,
} from './calendar'
import type { ListThreadsOptions, MailPage } from './gmail'
import { cacheKey, syncThreads } from './mail-sync'

export interface GoogleData {
  /** The agenda, fetched and then cached for the next launch's first paint. */
  agenda(window: AgendaWindow, overrides: CalendarOverrides): Promise<CalendarEvent[]>
  /** The last agenda for this exact question, or `null`. Never a request. */
  cachedAgenda(window: AgendaWindow, overrides: CalendarOverrides): CalendarEvent[] | null
  /** Threads, served from the cache and brought up to date by a delta. */
  threads(options: ListThreadsOptions): Promise<MailPage>
  /** The account this cache belongs to. Called on connect; a different `sub`
   *  wipes everything before anything can be read. */
  useAccount(sub: string): void
  /** Disconnect. Leaves no file on disk. */
  forget(): void
}

export interface GoogleDataDeps {
  /** Built per call, like everywhere else — a held client outlives a
   *  disconnect. */
  api: () => GoogleApi
  cache: GoogleCache
}

export function createGoogleData({ api, cache }: GoogleDataDeps): GoogleData {
  return {
    async agenda(window, overrides) {
      const events = await listAgenda(api(), window, { overrides })
      cache.writeAgenda(agendaKey(window, overrides), events)
      return events
    },

    cachedAgenda(window, overrides) {
      return cache.readAgenda(agendaKey(window, overrides))
    },

    threads(options) {
      return syncThreads(api(), cache, options)
    },

    useAccount(sub) {
      cache.useAccount(sub)
    },

    forget() {
      cache.destroy()
    },
  }
}

/**
 * Which agenda a cached list is.
 *
 * The window **and** the calendar choices: showing yesterday's events, or a
 * colleague's calendar the user has since switched off, would both be a cache
 * answering a question it was not asked.
 *
 * Keyed on the *overrides* rather than the resolved calendar ids on purpose —
 * resolving ids costs a request, and a key that cannot be computed offline is
 * useless to a cache whose whole job is to answer before the network does.
 */
export function agendaKey(window: AgendaWindow, overrides: CalendarOverrides): string {
  const choices = Object.keys(overrides)
    .sort()
    .map((id) => `${id}=${overrides[id]! ? '1' : '0'}`)
    .join(',')
  return `${window.timeMin}|${window.timeMax}|${choices}`
}

export { cacheKey as threadsCacheKey }
