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
 * If history cannot be checked within one bounded read, the UI must
 * explicitly choose a new snapshot baseline and revalidate open readers.
 */
import { GoogleApiError, type GoogleApi } from './api'
import type { GoogleCache } from './cache'
import {
  applyLabelDelta,
  describeThreadList,
  fetchThreadMetadata,
  fetchThreadPage,
  listThreads,
  listThreadIds,
  PATCHABLE_LABELS,
  summarizeThreadMetadata,
  threadMetadataFailures,
  type ListThreadsOptions,
  type MailPage,
  type MailThreadSummary,
  type ThreadMetadataOutcome,
} from './gmail'
import { isGmailMessageId } from './gmail-thread'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

// History is mailbox-wide, including threads never returned to a Holi reader.
// Bound both its traversal and the work it can fan out into on one sync.
const MAX_HISTORY_PAGES = 20
const MAX_HISTORY_CHANGES = 10_000
const MAX_DELTA_READS = 500
const MAX_MEMBERSHIP_PAGES = 20

export interface MailListRead {
  freshPage?: boolean
  refresh?: boolean
  assertCurrent?: () => void
  /** Identical requests can share work within one live vault binding. */
  bindingRevision?: string
}

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
 * A cold list seeds a baseline. Replacing a baseline without replaying its
 * history requires an explicit refresh, even when Gmail has expired it.
 */
export async function syncThreads(
  api: GoogleApi,
  cache: GoogleCache,
  options: ListThreadsOptions = {},
  knownAddresses?: string[],
  context?: MailListRead,
): Promise<MailPage> {
  try {
    return await syncList(api, cache, options, knownAddresses, context)
  } catch (error) {
    if (!(error instanceof HistoryRecoveryRequired)) throw error
    context?.assertCurrent?.()
    return { threads: [], nextPageToken: null, syncedAt: '', historyRecoveryRequired: true }
  }
}

async function syncList(
  api: GoogleApi,
  cache: GoogleCache,
  options: ListThreadsOptions,
  knownAddresses?: string[],
  context?: MailListRead,
): Promise<MailPage> {
  const assertCurrent = context?.assertCurrent ?? (() => {})
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

  // "Load more" asks for what is past the tail: the one thing a last-N cache
  // does not hold. Explicit searches go to Gmail because mailbox history cannot
  // evaluate arbitrary Gmail query grammar or reproduce a current page token.
  // Needs-reply also always fetches one fresh Gmail page: filtering a cached
  // slice would lose a valid continuation when that slice has no matches. Ordinary
  // unfiltered/category/unread/mailbox lists remain delta-backed.
  if (options.needsReply === true || context?.freshPage === true)
    return listThreads(api, options, knownAddresses)
  // Keep unresolved reads across a pagination reset, including failures found
  // on continuation pages. This key is independent of send-as resolution:
  // a change in recipient classification does not resolve a metadata failure.
  const pendingKey = cacheKey(options)
  if (!context?.refresh && options.pageToken !== undefined) {
    const { page, outcomes } = await fetchThreadPage(api, options, knownAddresses)
    assertCurrent()
    return cache.updateMailList(() => recordReads(cache, pendingKey, page, outcomes))
  }
  const { mailboxLabel, excludes } = describeThreadList(options)
  const baselineKey = mailboxLabel === null ? null : cache.latestMailListKey(pendingKey)
  const fresh = () =>
    fullSync(
      api,
      cache,
      { ...options, pageToken: undefined },
      key,
      pendingKey,
      knownAddresses,
      assertCurrent,
      mailboxLabel !== null,
      baselineKey,
    )
  if (context?.refresh || mailboxLabel === null || baselineKey === null) return fresh()
  const cached = cache.readThreads(baselineKey)
  // The cursor belongs to the list, not to the send-as result. Reclassify its
  // rows when identities change, without skipping any mailbox history.
  const since = cache.historyId(baselineKey)
  if (cached === null || since === null) throw new HistoryRecoveryRequired()

  const history: RawHistoryRecord[] = []
  let historyId: string | undefined
  let pageToken: string | undefined
  let remainingChanges = MAX_HISTORY_CHANGES
  try {
    for (let pages = 0; ; pages++) {
      if (pages === MAX_HISTORY_PAGES) throw new HistoryRecoveryRequired()
      const page = await api.get<RawHistoryPage>(`${BASE}/history`, {
        startHistoryId: since,
        pageToken,
        maxResults: '100',
        // Gmail's labelId filter omits cross-label updates to existing threads:
        // a SENT-only reply to an inbox thread is precisely such an update. Read
        // mailbox history unfiltered, then resolve query rows and deletion probes below.
      })
      assertCurrent()
      for (const record of page.history ?? []) {
        remainingChanges -=
          1 +
          (record.messagesAdded?.length ?? 0) +
          (record.messagesDeleted?.length ?? 0) +
          (record.labelsAdded?.length ?? 0) +
          (record.labelsRemoved?.length ?? 0)
        if (remainingChanges < 0) throw new HistoryRecoveryRequired()
        history.push(record)
      }
      historyId = page.historyId ?? historyId
      pageToken = page.nextPageToken
      if (pageToken === undefined) break
    }
  } catch (error) {
    // Unlike threads.get, this 404 means continuity was lost, not that
    // there is evidence about any particular thread.
    if (error instanceof GoogleApiError && error.status === 404) throw new HistoryRecoveryRequired()
    throw error
  }

  const { changed, deleted, left, patches } = readHistory(history, mailboxLabel)
  const cachedIds = new Set(cached.map((thread) => thread.id))
  const departures = new Set([...left, ...[...deleted].filter((id) => cachedIds.has(id))])
  const candidates = new Set([...departures, ...[...changed].filter((id) => !cachedIds.has(id))])

  // Exact deletion probes include uncached Load more threads, even if they
  // cannot possibly match the list. A deleted message isn't a deleted thread.
  const reads = new Set([...candidates, ...changed, ...deleted])
  if (baselineKey !== key) for (const id of cachedIds) reads.add(id)
  if (reads.size > MAX_DELTA_READS) throw new HistoryRecoveryRequired()
  const metadata = await fetchThreadMetadata(api, reads, new Set([...candidates, ...deleted]))
  assertCurrent()

  // Use authoritative whole-thread labels to rule out clear nonmembers before
  // paging. Possible matches still need Gmail's query; unreadable resources
  // stay pending, and a real 404 needs no list check to prove absence.
  const unresolved = new Set(
    metadata.flatMap((thread) =>
      candidates.has(thread.id) && thread.kind === 'readable' && !excludes(thread)
        ? [thread.id]
        : [],
    ),
  )
  const admitted = await findQueryMatches(api, options, unresolved, assertCurrent)
  if (admitted === null) {
    assertCurrent()
    // Don't rebaseline or lose exact probe evidence just because membership
    // ran out of pages. No successful read completes pending work in this delta.
    return cache.updateMailList(() => ({
      ...recordReads(
        cache,
        pendingKey,
        { threads: [], nextPageToken: null, syncedAt: '' },
        metadata.filter(({ kind }) => kind !== 'readable'),
      ),
      historyRecoveryRequired: true,
    }))
  }
  const departed = new Set([...departures].filter((id) => !admitted.has(id)))
  const rows = metadata.filter(({ id }) =>
    candidates.has(id)
      ? admitted.has(id)
      : changed.has(id) || (baselineKey !== key && cachedIds.has(id)),
  )
  const refreshed = await summarizeThreadMetadata(api, rows, knownAddresses)
  const retain = new Set<string>()
  for (const { id, kind } of metadata) {
    // Exact absence overrides any previous list or cached row.
    if (kind === 'not-found') departed.add(id)
    // Keep the previous summary of an unreadable off-page probe in storage only.
    if (kind === 'unreadable' && departed.has(id)) retain.add(id)
  }
  const threads = merge(cached, refreshed, departed, patches, options)
  assertCurrent()
  return cache.updateMailList(() => {
    const result = recordReads(
      cache,
      pendingKey,
      { threads, nextPageToken: null, syncedAt: new Date().toISOString() },
      metadata,
    )
    // A partial result cannot leave a cursor that would skip unresolved work.
    cache.writeThreads(key, [...threads, ...cached.filter(({ id }) => retain.has(id))])
    cache.setHistoryId(key, result.unreadableThreadIds ? null : (historyId ?? since))
    return result
  })
}

class HistoryRecoveryRequired extends Error {}

function recordReads(
  cache: GoogleCache,
  key: string,
  snapshot: Pick<MailPage, 'threads' | 'nextPageToken' | 'syncedAt'>,
  outcomes: ThreadMetadataOutcome[],
): MailPage {
  // A 404 from threads.get invalidates every cached list for this account,
  // unlike a query departure. Return that evidence with this read; don't
  // depend on the cache or the visible rows to reconstruct it later.
  const { notFoundThreadIds, unreadableThreadIds } = threadMetadataFailures(outcomes)
  for (const id of notFoundThreadIds ?? []) cache.dropThread(id)
  // A failed read stays pending but moves to the end so repeated failures
  // cannot starve the rest of the bounded off-page probe queue.
  const pending = cache.updateUnreadableThreads(
    key,
    outcomes.map(({ id }) => id),
    unreadableThreadIds ?? [],
  )
  const page = { ...snapshot, ...(notFoundThreadIds ? { notFoundThreadIds } : {}) }
  if (!pending.length) return page
  const unreadable = new Set(pending)
  return {
    ...page,
    threads: page.threads.filter(({ id }) => !unreadable.has(id)),
    unreadableThreadIds: pending,
  }
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
  pendingKey: string,
  knownAddresses: string[] | undefined,
  assertCurrent: () => void,
  establishBaseline: boolean,
  baselineKey: string | null,
): Promise<MailPage> {
  // Searches always fetch independently of history and don't own a baseline.
  const cursor = establishBaseline
    ? (await api.get<{ historyId?: string }>(`${BASE}/profile`)).historyId
    : undefined
  assertCurrent()
  if (establishBaseline && (typeof cursor !== 'string' || !/^\d+$/.test(cursor)))
    throw new Error('Gmail did not return a history baseline')
  const { page, outcomes } = await fetchThreadPage(api, options, knownAddresses)
  assertCurrent()
  const onPage = new Set(outcomes.map(({ id }) => id))
  // A fresh first page is not proof that a failed thread outside it has
  // recovered or gone. Check at most 25 pending IDs per refresh, without
  // mixing off-page summaries into the snapshot that owns the new token.
  const probeIds = cache
    .unreadableThreads(pendingKey)
    .filter((id) => !onPage.has(id))
    .slice(0, 25)
  const probes = await fetchThreadMetadata(api, probeIds, new Set(probeIds))
  assertCurrent()
  return cache.updateMailList(() => {
    const result = recordReads(cache, pendingKey, page, [...outcomes, ...probes])
    if (!establishBaseline) return result
    const pending = new Set(result.unreadableThreadIds)
    // This is the new snapshot's baseline, not proof we replayed skipped
    // history or that any thread omitted by the snapshot is gone.
    // Pending rows survive in storage only, not in the page that owns the token.
    const retained =
      pending.size && baselineKey !== null
        ? (cache.readThreads(baselineKey) ?? []).filter(({ id }) => pending.has(id))
        : []
    cache.writeThreads(key, [...result.threads, ...retained])
    cache.setHistoryId(key, result.unreadableThreadIds ? null : (cursor ?? null))
    return result
  })
}

async function findQueryMatches(
  api: GoogleApi,
  options: ListThreadsOptions,
  candidates: Set<string>,
  assertCurrent: () => void,
) {
  const matches = new Set<string>()
  if (!candidates.size) return matches
  let pageToken: string | undefined

  for (let pages = 0; ; pages++) {
    if (pages === MAX_MEMBERSHIP_PAGES) return null
    const page = await listThreadIds(api, { ...options, pageToken })
    assertCurrent()
    for (const id of page.ids) {
      if (candidates.has(id)) matches.add(id)
    }
    if (matches.size === candidates.size || page.nextPageToken === null) break
    pageToken = page.nextPageToken
  }

  return matches
}

interface Changes {
  /** Threads to refetch. */
  changed: Set<string>
  /** Threads with at least one permanently deleted message. */
  deleted: Set<string>
  /** Threads with message-level departures: archive, trash or spam. */
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
      // Message and thread IDs have the same Gmail resource ID grammar.
      if (isGmailMessageId(threadId)) deleted.add(threadId)
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
 * this handles a cached row falling out of the *filter* without a membership
 * scan. E.g. opening a thread marks it read, and without this "unread only"
 * would keep the row.
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
  departed: Set<string>,
  patches: Changes['patches'],
  options: ListThreadsOptions,
): MailThreadSummary[] {
  const replacements = new Map(refetched.map((thread) => [thread.id, thread]))

  const kept = cached
    .filter((thread) => !departed.has(thread.id))
    .map((thread) => replacements.get(thread.id) ?? patch(thread, patches.get(thread.id)))

  // Admitted arrivals need not have a cached row yet.
  const added = refetched.filter(
    (thread) => !departed.has(thread.id) && !cached.some((c) => c.id === thread.id),
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
 * (`describeThreadList`), so all of them belong here; a missing one serves one
 * list's answer under another list's key.
 *
 * `pageToken` is deliberately absent: only first-page rows are cached, and
 * unresolved reads belong to the query, not to a particular continuation.
 */
export function cacheKey(options: ListThreadsOptions): string {
  const parts = [
    options.query ?? '',
    options.category ?? '',
    options.unread === true ? 'unread' : '',
    options.mailbox ?? '',
  ]
  return parts.join('|') + (options.limit === undefined ? '' : `|limit:${options.limit}`)
}
