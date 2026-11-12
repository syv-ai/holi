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
 * `timeMax`, so incremental calendar sync would mean mirroring every event at
 * every date, per calendar, to serve an agenda that shows seven days.
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
  listThreadIds,
  mailboxLabel,
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
 * would spend the whole saving. The set lives in `gmail.ts` beside
 * `applyLabelDelta`, because the cache needs the same answer for a write this
 * app just made.
 */
const PATCHABLE = PATCHABLE_LABELS

/**
 * Labels whose movement means a thread **left the mailbox** rather than merely
 * changed inside it.
 *
 * `messagesDeleted` does not cover this: archive is `INBOX` removed, trash and
 * spam are a label added, and none of the three is a deletion. Without it a
 * refetched summary comes back through `merge`'s "new mail" branch and the
 * thread reappears at the top of the list it was just archived out of,
 * permanently, because the cursor advances past the event.
 *
 * **Which label counts as "removed" depends on the mailbox**, so it is a
 * parameter. For the inbox it is `INBOX`; for Sent it is `SENT`, a label a
 * message never loses, so in Sent the only departures are the two below.
 */
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
  nextPageToken?: string
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
  knownAddresses?: string[],
): Promise<MailPage> {
  // "Load more" asks for what is past the tail: the one thing a last-N cache
  // does not hold.
  if (options.pageToken !== undefined) return listThreads(api, options, knownAddresses)

  // Recipient classification depends on the resolved account identities. Keep
  // summaries from an outage/previous identity from becoming authoritative once
  // send-as addresses recover or change.
  const identityKey =
    knownAddresses === undefined
      ? ''
      : `|identity:${
          [...knownAddresses]
            .map((address) => address.trim().toLowerCase())
            .sort()
            .join(',') || 'unknown'
        }`
  const key = `${cacheKey(options)}${identityKey}`
  const cached = cache.readThreads(key)
  // The cursor THIS list was written at. Gmail's cursor is mailbox-wide, but
  // each cached list was written at a different moment.
  const since = cache.historyId(key)

  if (cached === null || since === null) return fullSync(api, cache, options, key, knownAddresses)

  // The mailbox this list is of, as Gmail labels it: the scope of the delta,
  // and the label whose removal means a thread has left.
  const label = mailboxLabel(options.mailbox)

  const history: RawHistoryRecord[] = []
  let historyId: string | undefined
  let pageToken: string | undefined
  try {
    do {
      const page = await api.get<RawHistoryPage>(`${BASE}/history`, {
        startHistoryId: since,
        pageToken,
        // Gmail's labelId filter omits cross-label updates to existing threads:
        // a SENT-only reply to an inbox thread is precisely such an update. Read
        // mailbox history unfiltered, then restrict refetches to cached threads
        // (plus explicit arrivals into this mailbox) below.
      })
      history.push(...(page.history ?? []))
      historyId = page.historyId ?? historyId
      pageToken = page.nextPageToken
    } while (pageToken !== undefined)
  } catch (error) {
    // Gmail keeps roughly a week. Older than that is a resync, not a failure,
    // and must never reach the user as one.
    if (error instanceof GoogleApiError && error.status === 404) {
      return fullSync(api, cache, options, key, knownAddresses)
    }
    throw error
  }

  const { changed, deleted, left, patches } = readHistory(history, label)
  const cachedIds = new Set(cached.map((thread) => thread.id))
  // History's label changes describe individual messages, while Gmail's list
  // membership is decided across the whole conversation. Confirm every
  // departure with the active query before removing a cached thread.
  for (const id of left) if (cachedIds.has(id)) changed.add(id)
  const candidates = new Set([...changed, ...left, ...deleted])
  const candidatesToConfirm = [...candidates].filter(
    (id) => !cachedIds.has(id) || left.has(id) || deleted.has(id),
  )
  const confirmedIds = new Set(candidatesToConfirm)
  const queryMatches =
    candidatesToConfirm.length === 0
      ? []
      : await findQueryMatches(api, options, knownAddresses, confirmedIds)
  const admitted = new Set(queryMatches.map((thread) => thread.id))
  for (const id of changed) {
    if (!cachedIds.has(id) && !admitted.has(id)) changed.delete(id)
  }
  // A message-level archive/trash event is only a thread departure if Gmail's
  // current list query no longer returns the conversation.
  const gone = new Set(
    [...new Set([...left, ...deleted])].filter((id) => cachedIds.has(id) && !admitted.has(id)),
  )
  for (const id of new Set([...left, ...deleted])) {
    if (admitted.has(id)) changed.add(id)
  }

  // Only the threads that actually moved, and never one we already know has
  // gone. Two changed threads cost two requests, not 25.
  const queryMatchIds = new Set(queryMatches.map((thread) => thread.id))
  const refetched = await fetchThreadSummaries(
    api,
    [...changed].filter((id) => !gone.has(id) && !queryMatchIds.has(id) && !confirmedIds.has(id)),
    knownAddresses,
  )
  const available = new Set([
    ...refetched.map((thread) => thread.id),
    ...queryMatches.map((thread) => thread.id),
  ])
  // A deleted message can be a draft, not a conversation. A thread disappears
  // only when refetch or the authoritative list query confirms it is gone.
  for (const id of deleted) if (!available.has(id)) gone.add(id)
  const refreshed = new Map(refetched.map((thread) => [thread.id, thread]))
  for (const thread of queryMatches) refreshed.set(thread.id, thread)

  const threads = merge(cached, [...refreshed.values()], gone, patches, options)
  cache.writeThreads(key, threads)
  if (historyId !== undefined) cache.setHistoryId(key, historyId)

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
  knownAddresses?: string[],
): Promise<MailPage> {
  const cursor = currentHistoryId(api)
  const page = await listThreads(api, options, knownAddresses)
  cache.writeThreads(key, page.threads)
  const historyId = await cursor
  if (historyId !== null) cache.setHistoryId(key, historyId)
  return page
}

async function findQueryMatches(
  api: GoogleApi,
  options: ListThreadsOptions,
  knownAddresses: string[] | undefined,
  candidates: Set<string>,
): Promise<MailThreadSummary[]> {
  const matches = new Set<string>()
  let pageToken: string | undefined

  do {
    const page = await listThreadIds(api, { ...options, pageToken })
    for (const id of page.ids) {
      if (candidates.has(id)) matches.add(id)
    }
    if (matches.size === candidates.size || page.nextPageToken === null) break
    pageToken = page.nextPageToken
  } while (true)

  return fetchThreadSummaries(api, [...matches], knownAddresses)
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
   * Still in the mailbox, but no longer in the inbox: archived, trashed or
   * marked spam. Distinct from `deleted` because `threads.get` still answers
   * for these, so they would otherwise come back as "new mail".
   */
  left: Set<string>
  /** threadId → the label ids now on it, as far as history says. */
  patches: Map<string, { added: Set<string>; removed: Set<string> }>
}

/**
 * What history says happened, sorted into "refetch this", "patch this" and
 * "this is no longer here".
 *
 * A thread that is both patched and refetched is only refetched: the fetched
 * summary is authoritative and a patch on top of it could only be older.
 *
 * Records arrive in chronological order, so a thread archived and then moved
 * back within one window resolves to whichever happened last: the `INBOX`
 * label being added again removes it from `left` rather than leaving both
 * facts recorded and letting the caller guess.
 */
function readHistory(records: RawHistoryRecord[], leftWhenRemoved: string): Changes {
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
      if (threadId !== undefined) {
        deleted.add(threadId)
        changed.add(threadId)
      }
    }
    for (const [entries, side] of [
      [record.labelsAdded ?? [], 'added'],
      [record.labelsRemoved ?? [], 'removed'],
    ] as const) {
      for (const entry of entries) {
        const threadId = entry.message?.threadId
        if (threadId === undefined) continue
        for (const labelId of entry.labelIds ?? []) {
          // Left the mailbox, or came back to it. Checked before `PATCHABLE`
          // because these decide whether the row belongs to the list at all.
          // Each label reads in both directions: INBOX removed is an archive and
          // INBOX added is an un-archive; TRASH added is a trashing and TRASH
          // removed is a restore.
          const home = labelId === leftWhenRemoved
          const banished = LEFT_WHEN_ADDED.has(labelId)
          if (home || banished) {
            const leaving = side === (home ? 'removed' : 'added')
            if (leaving) left.add(threadId)
            else {
              // Back in the inbox. Refetched rather than patched: the summary
              // in hand is from before it left, if it is held at all.
              left.delete(threadId)
              changed.add(threadId)
            }
            continue
          }
          // A label this cannot reconstruct locally (a user label, whose NAME
          // the cache holds and whose id says nothing) means refetch.
          if (!PATCHABLE.has(labelId)) changed.add(threadId)
          else patchFor(threadId)[side].add(labelId)
        }
      }
    }
  }

  // A deleted message may be a draft. Refetch before deciding the thread is gone.
  return { changed, deleted, left, patches }
}

/**
 * Does this thread still answer the question the list asked?
 *
 * **"Left the mailbox" and "left this list" are not the same thing.**
 * `LEFT_WHEN_ADDED` and the mailbox label handle a thread leaving the *place*;
 * this handles a thread falling out of the *filter*, because the filter is a
 * Gmail query and Gmail is not asked again on the delta path. E.g. opening a
 * thread marks it read, and without this "unread only" would keep the row.
 *
 * Local, and free: the summary already carries both flags. It is deliberately
 * only the filters this module can evaluate: an explicit user query is Gmail's
 * grammar and is not re-interpreted here.
 */
function stillMatches(thread: MailThreadSummary, options: ListThreadsOptions): boolean {
  if (options.unread === true && !thread.unread) return false
  if (options.category !== undefined && thread.category !== options.category) return false
  return true
}

/** The cached list with the deltas applied: departures removed, patches
 *  applied, refetched summaries replacing their stale twins, threads that no
 *  longer match this list's filter dropped, newest first. */
function merge(
  cached: MailThreadSummary[],
  refetched: MailThreadSummary[],
  gone: Set<string>,
  patches: Changes['patches'],
  options: ListThreadsOptions,
): MailThreadSummary[] {
  const replacements = new Map(refetched.map((thread) => [thread.id, thread]))

  const kept = cached
    .filter((thread) => !gone.has(thread.id))
    .map((thread) => replacements.get(thread.id) ?? patch(thread, patches.get(thread.id)))

  // A thread whose first message just arrived is not in the cached list at all.
  //
  // **`gone` is filtered here too, not only above.** The cache may already have
  // dropped an archived thread (this app's own write), so it would fail the "is
  // it cached?" test and arrive through this branch as new mail.
  const added = refetched.filter(
    (thread) => !gone.has(thread.id) && !cached.some((c) => c.id === thread.id),
  )

  // AFTER the patches and the replacements, never before: what decides is the
  // thread as it is now, not as the cache last saw it.
  return [...added, ...kept]
    .filter((thread) => stillMatches(thread, options))
    .sort((a, b) => b.date.localeCompare(a.date))
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
 * (`composeQuery`), so all of them belong here; a missing one serves one
 * list's answer under another list's key.
 *
 * `pageToken` is deliberately absent: a later page never consults the cache
 * (see `syncThreads`), so it has no key to belong to.
 */
export function cacheKey(options: ListThreadsOptions): string {
  const parts = [
    options.query ?? '',
    options.category ?? '',
    options.unread === true ? 'unread' : '',
    options.mailbox ?? '',
  ]
  return parts.join('|')
}
