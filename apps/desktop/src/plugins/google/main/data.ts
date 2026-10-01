/**
 * A vault's Google data: the one place caching is decided.
 *
 * Every door reads and writes through here (`capabilities.ts`): the views,
 * an app and the agent. Nothing it answers is stale: mail is the cache brought
 * up to date by a delta, and the agenda is always fetched. A write calls
 * Google first and then moves the cache, so a thread the agent archived
 * leaves the list the view paints from at the same moment it leaves Gmail.
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
  deleteDraft,
  listSendAs,
  fetchMessageAttachments,
  saveDraft as saveGmailDraft,
  sendDraft,
  sendInThread,
  sendMessage,
  setThreadRead,
  setThreadStarred,
  trashThread,
  type ListThreadsOptions,
  type MailAddress,
  type MailPage,
} from './gmail'
import type { MailPart, OutgoingMail } from './mime'
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
   * In memory rather than on disk, and single-flighted: the renderer asks on
   * every `MailView` mount, and each ask costs up to four People requests
   * against a rate-limited API. Cleared on disconnect.
   */
  contacts(): Promise<MailAddress[]>
  /**
   * The label writes. Each calls Google **first** and touches the cache
   * only once Google has agreed: see the note above `write`.
   */
  setRead(id: string, read: boolean): Promise<void>
  setStarred(id: string, starred: boolean): Promise<void>
  archive(id: string): Promise<void>
  trash(id: string): Promise<void>
  /**
   * The composer's writes, on the same Google-first ordering.
   *
   * A sent *message* is not a label delta, but a draft appearing and
   * disappearing **is** one, which lets the thread's *Continue draft* chip
   * arrive and leave without a refetch.
   */
  sendMail(input: ComposeWrite): Promise<{ id: string | null }>
  saveDraft(input: ComposeWrite): Promise<{ id: string | null }>
  discardDraft(input: { draftId: string; threadId?: string }): Promise<void>
  /**
   * Every address this account may send from, memoized like `contacts()`.
   * Needed by reply-all, which has to exclude every alias and not merely the
   * connected address.
   */
  sendAs(): Promise<string[]>
  /** Wipe if the cached row shape predates this release. Call before first use.
   *  One `GoogleData` serves one account, so its file and memos are that
   *  account's by construction rather than by a check. */
  ensureShape(): void
  /** Disconnect. Leaves no file on disk. */
  forget(): void
}

/**
 * One shape for send and save, because the composer treats them as one act:
 * `draftId` present means an existing draft, `threadId` present means it
 * belongs to a conversation, and either may be absent.
 */
export interface ComposeWrite {
  mail: OutgoingMail
  draftId?: string
  threadId?: string
  /**
   * Forward the attachments of this message.
   *
   * A message id rather than the files themselves: main fetches the bytes and
   * hands them to `buildRfc822`, so nothing base64 crosses the IPC seam.
   */
  forwardOf?: { messageId: string }
}

export interface GoogleDataDeps {
  /** Built per call: a held client outlives a disconnect. */
  api: () => GoogleApi
  cache: GoogleCache
}

export function createGoogleData({ api, cache }: GoogleDataDeps): GoogleData {
  /** The in-flight or settled address book. A promise rather than a value, so
   *  two mounts racing produce one request. `listContacts` never rejects, so
   *  this can never latch a failure. */
  let addressBook: Promise<MailAddress[]> | null = null
  /**
   * The send-as aliases, held the same way. Unlike `listContacts`, `listSendAs`
   * *can* reject (a missing scope is a 403), and a memoised rejection would
   * keep every reply-all copying the user on their own messages. So a failure
   * clears the memo.
   */
  let aliases: Promise<string[]> | null = null

  /**
   * The most recently forwarded message's bytes, held so the autosave does not
   * fetch them again every two seconds.
   *
   * **One slot, not a map.** A composer forwards exactly one message, and the
   * bytes are the largest thing in this module. A rejection is never latched,
   * same rule as `aliases`.
   */
  let forwarded: { messageId: string; bytes: Promise<MailPart[]> } | null = null

  /**
   * The mail, with a forwarded message's attachments fetched and attached.
   *
   * The fetch is memoised because autosave rebuilds the whole message on every
   * 2s of idle typing; without it a 20MB forward is re-downloaded per pause.
   * The bytes cannot change while the source message id does not.
   */
  const resolved = async (input: ComposeWrite): Promise<OutgoingMail> => {
    if (input.forwardOf === undefined) return input.mail
    const { messageId } = input.forwardOf
    if (forwarded === null || forwarded.messageId !== messageId) {
      forwarded = { messageId, bytes: fetchMessageAttachments(api(), messageId) }
    }
    const pending = forwarded
    let attachments: MailPart[]
    try {
      attachments = await pending.bytes
    } catch (error) {
      if (forwarded === pending) forwarded = null
      throw error
    }
    // An empty list stays absent, so forwarding a message with nothing attached
    // takes the multipart/alternative path rather than building an empty
    // multipart/mixed, which displays as a mysteriously missing attachment.
    if (attachments.length === 0) return input.mail
    return { ...input.mail, attachments }
  }

  /** `DRAFT` is one of the four patchable labels, so a draft arriving or
   *  leaving is expressible as a delta on the cached thread. */
  const draftDelta = (threadId: string | undefined, present: boolean): void => {
    if (threadId === undefined) return
    cache.patchThread(threadId, {
      added: present ? ['DRAFT'] : [],
      removed: present ? [] : ['DRAFT'],
    })
  }

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

    sendMail(input) {
      const { draftId, threadId } = input
      return write(
        async () => {
          // A draft is sent through `drafts.send` so Gmail removes it
          // atomically; anything else would leave an orphan draft behind a
          // message the user has already sent.
          if (draftId !== undefined) return await sendDraft(api(), draftId)
          const mail = await resolved(input)
          if (threadId !== undefined) return await sendInThread(api(), threadId, mail)
          return await sendMessage(api(), mail)
        },
        // Whatever the route, the thread no longer has an unsent draft in it.
        () => draftDelta(threadId, false),
      )
    },

    saveDraft(input) {
      const { draftId, threadId } = input
      return write(
        async () => saveGmailDraft(api(), await resolved(input), { draftId, threadId }),
        () => draftDelta(threadId, true),
      )
    },

    discardDraft({ draftId, threadId }) {
      return write(
        () => deleteDraft(api(), draftId),
        () => draftDelta(threadId, false),
      )
    },

    sendAs() {
      return (aliases ??= listSendAs(api()).catch((error: unknown) => {
        aliases = null
        throw error
      }))
    },

    ensureShape() {
      cache.ensureShape()
    },

    forget() {
      addressBook = null
      aliases = null
      cache.destroy()
    },
  }
}

/**
 * A write, and the ordering that keeps the cache honest.
 *
 * **Google first; the cache only once Google has agreed.** Patching
 * optimistically is wrong here: a cache that records a write Google refused is
 * the one divergence a delta sync can never repair. `history.list` reports
 * what changed *at Gmail*, and for a refused request nothing did, so the wrong
 * value would survive every refresh and every restart.
 *
 * Optimism belongs in the renderer, where a revert costs a re-render and
 * nothing is persisted. It does not belong on disk.
 */
async function write<T>(send: () => Promise<T>, record: () => void): Promise<T> {
  const result = await send()
  record()
  return result
}

/**
 * Which agenda a cached list is.
 *
 * The window **and** the calendar choices: showing yesterday's events, or a
 * colleague's calendar the user has since switched off, would both be a cache
 * answering a question it was not asked.
 *
 * Keyed on the *overrides* rather than the resolved calendar ids on purpose:
 * resolving ids costs a request, and the key must be computable offline.
 */
export function agendaKey(window: AgendaWindow, overrides: CalendarOverrides): string {
  const choices = Object.keys(overrides)
    .sort()
    .map((id) => `${id}=${overrides[id]! ? '1' : '0'}`)
    .join(',')
  return `${window.timeMin}|${window.timeMax}|${choices}`
}

export { cacheKey as threadsCacheKey }
