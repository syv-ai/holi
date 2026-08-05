/**
 * The cached inbox, brought up to date.
 *
 * A mail refresh is `threads.list` plus one `threads.get` per thread — **26
 * requests for 25 threads**, nearly all of them re-downloading mail that has
 * not changed. `history.list` asks Gmail what happened since a cursor instead,
 * and an unchanged refresh collapses to **one request**.
 *
 * **Calendar has no equivalent, and that is a decision rather than an
 * omission.** `events.list`'s `syncToken` cannot be combined with `timeMin` or
 * `timeMax` (Google's own reference lists both among the parameters that
 * "cannot be specified together with nextSyncToken"), so incremental calendar
 * sync would mean mirroring every event at every date, per calendar, to serve
 * an agenda that shows seven days. Refused. See D67.
 *
 * Two failure modes are **normal outcomes**, not errors:
 * - `history.list` 404s when `startHistoryId` is older than Gmail keeps
 *   (roughly a week). That means full resync.
 * - Nothing cached, or no cursor held, means full resync too.
 */
import { GoogleApiError, type GoogleApi } from './api'
import type { GoogleCache } from './cache'
import {
  applyLabelDelta,
  fetchThreadSummaries,
  listThreads,
  PATCHABLE_LABELS,
  type ListThreadsOptions,
  type MailPage,
  type MailThreadSummary,
} from './gmail'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Which labels a cached summary can be repatched from, rather than refetched.
 *
 * Read/unread is the most common delta there is, and paying a request for it
 * would spend the whole saving. The set and the mapping that applies it live in
 * `gmail.ts` beside `MailThreadSummary`, because the cache needs the same
 * answer for a write this app just made — see `applyLabelDelta`.
 */
const PATCHABLE = PATCHABLE_LABELS

/**
 * Labels whose movement means a thread **left the inbox** rather than merely
 * changed inside it.
 *
 * This is the distinction `messagesDeleted` does not cover and that nothing
 * covered before: archive is `INBOX` removed, trash and spam are a label added,
 * and none of the three is a deletion. Without it a refetched summary comes
 * back through `merge`'s "new mail" branch and the thread reappears at the top
 * of the list it was just archived out of — permanently, because the cursor
 * advances past the event that would have explained it.
 */
const LEFT_WHEN_REMOVED = 'INBOX'
const LEFT_WHEN_ADDED = new Set(['TRASH', 'SPAM'])

interface RawHistoryMessage {
  id?: string
  threadId?: string
}

interface RawHistoryRecord {
  messagesAdded?: { message?: RawHistoryMessage }[]
  messagesDeleted?: { message?: RawHistoryMessage }[]
  labelsAdded?: { message?: RawHistoryMessage; labelIds?: string[] }[]
  labelsRemoved?: { message?: RawHistoryMessage; labelIds?: string[] }[]
}

interface RawHistoryPage {
  history?: RawHistoryRecord[]
  historyId?: string
}

/**
 * The cached list brought up to date.
 *
 * Falls back to a full `listThreads` when there is no cache, no history id, or
 * Google has expired the id.
 */
export async function syncThreads(
  api: GoogleApi,
  cache: GoogleCache,
  options: ListThreadsOptions = {},
): Promise<MailPage> {
  // "Load more" asks for what is past the tail — by definition the one thing a
  // last-N cache does not hold, so it never consults it.
  if (options.pageToken !== undefined) return listThreads(api, options)

  const key = cacheKey(options)
  const cached = cache.readThreads(key)
  // The cursor THIS list was written at. Gmail's cursor is mailbox-wide, but
  // each cached list was written at a different moment — asking "what changed
  // since 200?" against a list last written at 100 loses everything between.
  const since = cache.historyId(key)

  if (cached === null || since === null) return fullSync(api, cache, options, key)

  let page: RawHistoryPage
  try {
    page = await api.get<RawHistoryPage>(`${BASE}/history`, {
      startHistoryId: since,
      // Scoped to the inbox: everything else that happens in a mailbox — a
      // label on an archived thread, a message in Spam — is noise to this list.
      labelId: 'INBOX',
    })
  } catch (error) {
    // Gmail keeps roughly a week. Older than that is a resync, not a failure,
    // and must never reach the user as one.
    if (error instanceof GoogleApiError && error.status === 404) {
      return fullSync(api, cache, options, key)
    }
    throw error
  }

  const { changed, deleted, left, patches } = readHistory(page.history ?? [])

  /**
   * "Left the inbox" only means "left this list" for a list that IS the inbox.
   *
   * A search (`from:jane`) may still legitimately match an archived thread, so
   * there the same event becomes a **refetch** instead — which is what it was
   * before departures existed, and it keeps the row while bringing it up to
   * date. The category and unread lists are inbox-scoped, so they get the
   * removal; only an explicit query opts out.
   */
  const inbox = scopedToInbox(options)
  const gone = inbox ? new Set([...deleted, ...left]) : deleted
  if (!inbox) for (const id of left) changed.add(id)

  // Only the threads that actually moved, and never one we already know has
  // gone — refetching a thread in order to drop it is a request spent on
  // nothing. This is the win: two changed threads cost two requests, not 25.
  const refetched = await fetchThreadSummaries(api, [...changed].filter((id) => !gone.has(id)))

  const threads = merge(cached, refetched, gone, patches)
  cache.writeThreads(key, threads)
  if (page.historyId !== undefined) cache.setHistoryId(key, page.historyId)

  // A delta IS a sync: these threads are current as of this moment, even
  // though most of them were served from disk rather than refetched.
  return { threads, nextPageToken: null, syncedAt: new Date().toISOString() }
}

/**
 * Fetch the list outright, and take a fresh cursor.
 *
 * The cursor is read **before** the list, not after: a change landing mid-fetch
 * is then replayed by the next delta, which is harmless because applying it
 * twice changes nothing. Taking it afterwards would silently drop that change.
 */
async function fullSync(
  api: GoogleApi,
  cache: GoogleCache,
  options: ListThreadsOptions,
  key: string,
): Promise<MailPage> {
  const cursor = currentHistoryId(api)
  const page = await listThreads(api, options)
  cache.writeThreads(key, page.threads)
  const historyId = await cursor
  if (historyId !== null) cache.setHistoryId(key, historyId)
  return page
}

/** The mailbox's current cursor. A failure costs the *next* refresh its delta,
 *  never this one its mail. */
async function currentHistoryId(api: GoogleApi): Promise<string | null> {
  try {
    const profile = await api.get<{ historyId?: string }>(`${BASE}/profile`)
    return profile.historyId ?? null
  } catch {
    return null
  }
}

interface Changes {
  /** Threads to refetch. */
  changed: Set<string>
  /** Permanently gone from the mailbox. */
  deleted: Set<string>
  /**
   * Still in the mailbox, but no longer in the inbox — archived, trashed or
   * marked spam. Distinct from `deleted` because `threads.get` still answers
   * for these, which is exactly how they used to come back as "new mail".
   */
  left: Set<string>
  /** threadId → the label ids now on it, as far as history says. */
  patches: Map<string, { added: Set<string>; removed: Set<string> }>
}

/**
 * What history says happened, sorted into "refetch this", "patch this" and
 * "this is no longer here".
 *
 * A thread that is both patched and refetched is only refetched — the fetched
 * summary is authoritative and a patch on top of it could only be older.
 *
 * Records arrive in chronological order, so a thread archived and then moved
 * back within one window resolves to whichever happened last: the `INBOX`
 * label being added again removes it from `left` rather than leaving both
 * facts recorded and letting the caller guess.
 */
function readHistory(records: RawHistoryRecord[]): Changes {
  const changed = new Set<string>()
  const deleted = new Set<string>()
  const left = new Set<string>()
  const patches = new Map<string, { added: Set<string>; removed: Set<string> }>()

  const patchFor = (threadId: string) => {
    const existing = patches.get(threadId)
    if (existing !== undefined) return existing
    const fresh = { added: new Set<string>(), removed: new Set<string>() }
    patches.set(threadId, fresh)
    return fresh
  }

  for (const record of records) {
    for (const entry of record.messagesAdded ?? []) {
      const threadId = entry.message?.threadId
      if (threadId !== undefined) changed.add(threadId)
    }
    for (const entry of record.messagesDeleted ?? []) {
      const threadId = entry.message?.threadId
      if (threadId !== undefined) deleted.add(threadId)
    }
    for (const [entries, side] of [
      [record.labelsAdded ?? [], 'added'],
      [record.labelsRemoved ?? [], 'removed'],
    ] as const) {
      for (const entry of entries) {
        const threadId = entry.message?.threadId
        if (threadId === undefined) continue
        for (const labelId of entry.labelIds ?? []) {
          // Left the inbox, or came back to it. Checked before `PATCHABLE`
          // because these are not flags on a row — they decide whether the row
          // belongs to the list at all. Each label reads in both directions:
          // INBOX removed is an archive and INBOX added is an un-archive; TRASH
          // added is a trashing and TRASH removed is a restore.
          const inbox = labelId === LEFT_WHEN_REMOVED
          const banished = LEFT_WHEN_ADDED.has(labelId)
          if (inbox || banished) {
            const leaving = side === (inbox ? 'removed' : 'added')
            if (leaving) left.add(threadId)
            else {
              // Back in the inbox. Refetched rather than patched: the summary
              // in hand is from before it left, if it is held at all.
              left.delete(threadId)
              changed.add(threadId)
            }
            continue
          }
          // A label this cannot reconstruct locally — a user label, whose NAME
          // the cache holds and whose id says nothing — means refetch.
          if (!PATCHABLE.has(labelId)) changed.add(threadId)
          else patchFor(threadId)[side].add(labelId)
        }
      }
    }
  }

  // A deleted thread is not worth a request to look at.
  for (const id of deleted) changed.delete(id)
  return { changed, deleted, left, patches }
}

/**
 * Is this list the inbox?
 *
 * `composeQuery` defaults to `in:inbox` when there is no explicit query, and
 * ANDs the category and unread filters onto it — so every list except an
 * explicit search is inbox-scoped, and only those may treat "archived" as
 * "gone from this list".
 */
function scopedToInbox(options: ListThreadsOptions): boolean {
  return options.query === undefined || options.query === ''
}

/** The cached list with the deltas applied: departures removed, patches
 *  applied, refetched summaries replacing their stale twins, newest first. */
function merge(
  cached: MailThreadSummary[],
  refetched: MailThreadSummary[],
  gone: Set<string>,
  patches: Changes['patches'],
): MailThreadSummary[] {
  const replacements = new Map(refetched.map((thread) => [thread.id, thread]))

  const kept = cached
    .filter((thread) => !gone.has(thread.id))
    .map((thread) => replacements.get(thread.id) ?? patch(thread, patches.get(thread.id)))

  // A thread whose first message just arrived is not in the cached list at all.
  //
  // **`gone` is filtered here too, not only above.** Filtering `kept` alone is
  // what let an archived thread return: the cache had already dropped it (this
  // app's own write), so it failed the "is it cached?" test and arrived through
  // this branch as new mail — at the top of the list, since the sort is by date.
  const added = refetched.filter(
    (thread) => !gone.has(thread.id) && !cached.some((c) => c.id === thread.id),
  )

  return [...added, ...kept].sort((a, b) => b.date.localeCompare(a.date))
}

function patch(
  thread: MailThreadSummary,
  change: { added: Set<string>; removed: Set<string> } | undefined,
): MailThreadSummary {
  return change === undefined ? thread : applyLabelDelta(thread, change)
}

/**
 * Which question a cached list answers.
 *
 * **Every option that narrows the list, or the key is a lie.** The query, the
 * category and the unread filter all become part of the Gmail query
 * (`composeQuery`), so all three belong here. `unread` was missing, and the
 * consequence was not a stale list but a wrong one: flipping "unread only" with
 * a warm cache served the whole inbox back unfiltered, and a cold one wrote the
 * unread-only list under the plain inbox's key so the unfiltered list then
 * showed only unread threads.
 *
 * `pageToken` is deliberately absent — a later page never consults the cache
 * (see `syncThreads`), so it has no key to belong to.
 */
export function cacheKey(options: ListThreadsOptions): string {
  return `${options.query ?? ''}|${options.category ?? ''}|${options.unread === true ? 'unread' : ''}`
}
