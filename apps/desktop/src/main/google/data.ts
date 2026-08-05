/**
 * The **UI's** Google data — the one place caching is decided.
 *
 * **The agent does not come through here to read, and does to write** (D70).
 * The two halves point in opposite directions on purpose.
 *
 * It must never be handed a stale *answer* (D67, "Do not cache"), so the ops
 * server in `main/index.ts` is wired straight to `listAgenda` / `listThreads` —
 * functions that take no cache and therefore cannot read one.
 *
 * Its *writes* go through the four methods below, because a thread the agent
 * archived has to leave the list the UI is painting from at the same moment it
 * leaves Gmail. A write that skipped this would leave Holi showing a thread
 * that is no longer in the inbox until the next delta sync noticed.
 *
 * `main/index.ts` passes those four methods, never this object — so the
 * structural exclusion D68 §6 built survives: the ops server still has no way
 * to read a cached anything.
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
import {
  archiveThread,
  setThreadRead,
  setThreadStarred,
  trashThread,
  type ListThreadsOptions,
  type MailAddress,
  type MailPage,
} from './gmail'
import { cacheKey, syncThreads } from './mail-sync'
import { listContacts } from './people'

export interface GoogleData {
  /** The agenda, fetched and then cached for the next launch's first paint. */
  agenda(window: AgendaWindow, overrides: CalendarOverrides): Promise<CalendarEvent[]>
  /** The last agenda for this exact question, or `null`. Never a request. */
  cachedAgenda(window: AgendaWindow, overrides: CalendarOverrides): CalendarEvent[] | null
  /** Threads, served from the cache and brought up to date by a delta. */
  threads(options: ListThreadsOptions): Promise<MailPage>
  /**
   * The address book, fetched **once per connected account**.
   *
   * In memory rather than on disk, and single-flighted like the token refresh:
   * the renderer asks on every `MailView` mount, and without this each mount
   * cost up to four People requests against a rate-limited API to populate a
   * dropdown. An address book is also the least time-sensitive thing this
   * connector holds — a contact added today is not why completion missed
   * someone. Cleared when the account changes.
   */
  contacts(): Promise<MailAddress[]>
  /**
   * The four writes (D68). Each calls Google **first** and touches the cache
   * only once Google has agreed — see the note above `write`.
   */
  setRead(id: string, read: boolean): Promise<void>
  setStarred(id: string, starred: boolean): Promise<void>
  archive(id: string): Promise<void>
  trash(id: string): Promise<void>
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
  /** The in-flight or settled address book. A promise rather than a value, so
   *  two mounts racing produce one request instead of two. `listContacts` never
   *  rejects, so this can never latch a failure permanently — a refusal caches
   *  `[]` until the account changes, which is the same answer it would give. */
  let addressBook: Promise<MailAddress[]> | null = null

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

    contacts() {
      return (addressBook ??= listContacts(api()))
    },

    setRead(id, read) {
      return write(
        () => setThreadRead(api(), id, read),
        () =>
          cache.patchThread(id, {
            added: read ? [] : ['UNREAD'],
            removed: read ? ['UNREAD'] : [],
          }),
      )
    },

    setStarred(id, starred) {
      return write(
        () => setThreadStarred(api(), id, starred),
        () =>
          cache.patchThread(id, {
            added: starred ? ['STARRED'] : [],
            removed: starred ? [] : ['STARRED'],
          }),
      )
    },

    archive(id) {
      // Dropped from every cached list, including a search that might still
      // legitimately match it. That over-reach is deliberate and self-healing:
      // the next `syncThreads` refetches, and this is a cache, not a mirror.
      return write(
        () => archiveThread(api(), id),
        () => cache.dropThread(id),
      )
    },

    trash(id) {
      return write(
        () => trashThread(api(), id),
        () => cache.dropThread(id),
      )
    },

    useAccount(sub) {
      // The address book belongs to whoever was connected, exactly as the
      // cached mail does — and unlike the mail it is not keyed by account, so
      // dropping it here is what stops one account completing to another's
      // contacts. `cache.useAccount` no-ops on an unchanged account; this does
      // not, and the cost of being wrong that way is one extra request.
      addressBook = null
      cache.useAccount(sub)
    },

    forget() {
      addressBook = null
      cache.destroy()
    },
  }
}

/**
 * A write, and the ordering that keeps the cache honest.
 *
 * **Google first; the cache only once Google has agreed.** The reverse — patch
 * optimistically, undo on failure — is tempting because it paints faster, and
 * it is wrong here: a cache that records a write Google refused is the one
 * divergence a delta sync can never repair. `history.list` reports what changed
 * *at Gmail*, and for a refused request nothing did, so there is no event to
 * correct it and the wrong value survives every refresh and every restart.
 *
 * Optimism belongs in the renderer, where a revert costs a re-render and
 * nothing is persisted. It does not belong on disk.
 */
async function write(send: () => Promise<void>, record: () => void): Promise<void> {
  await send()
  record()
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
