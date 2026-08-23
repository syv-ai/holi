/**
 * Incremental Gmail sync.
 *
 * The number that justifies this: a mail refresh is `threads.list` plus one
 * `threads.get` per thread — **26 requests for 25 threads** — and every one of
 * them is spent re-downloading mail that has not changed. `history.list`
 * collapses an unchanged refresh to **one**.
 *
 * The real cache is used rather than a fake one: the pair is the unit worth
 * testing, and a fake cache would pass whatever this file happened to assume.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { openGoogleCache, type GoogleCache } from '../src/main/google/cache'
import { cacheKey, syncThreads } from '../src/main/google/mail-sync'

let dir: string
let cache: GoogleCache

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-mail-sync-'))
  cache = openGoogleCache(join(dir, 'cache.db'))
  cache.ensureShape()
})

afterEach(async () => {
  cache.close()
  await rm(dir, { recursive: true, force: true })
})

function message(id: string, threadId: string, headers: [string, string][], labels: string[]) {
  return {
    id,
    threadId,
    internalDate: '1000000000000',
    labelIds: labels,
    payload: { headers: headers.map(([name, value]) => ({ name, value })) },
  }
}

/** A thread as `threads.get` answers it. */
function rawThread(id: string, subject: string, labels: string[] = ['INBOX']) {
  return {
    id,
    messages: [
      message(`${id}-m1`, id, [['Subject', subject], ['From', 'Jane <jane@x.com>']], labels),
    ],
  }
}

interface Routes {
  /** `threads.list` — the ids, newest first. */
  list?: { id: string }[]
  threads?: Record<string, unknown>
  /** `history.list`. A number means "answer this status instead". */
  history?: unknown | number
  profile?: { historyId?: string }
}

/** A fake Gmail covering list, get, history, labels and profile. */
function gmail(routes: Routes) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const path = new URL(url).pathname
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })

    if (path.endsWith('/labels')) return ok({ labels: [] })
    if (path.endsWith('/profile')) return ok(routes.profile ?? { historyId: '5000' })
    if (path.endsWith('/history')) {
      if (typeof routes.history === 'number') {
        // Gmail answers 404 when `startHistoryId` is older than it keeps —
        // roughly a week. A NORMAL outcome, not an error.
        return { ok: false, status: routes.history, text: async () => '{}', json: async () => ({}) }
      }
      return ok(routes.history ?? { historyId: '5000' })
    }
    if (path.endsWith('/threads')) return ok({ threads: routes.list ?? [] })
    return ok(routes.threads?.[path.split('/').pop()!] ?? {})
  }) as unknown as typeof globalThis.fetch

  return { api: new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }), seen }
}

/** How many `threads.get` calls were made — the cost this whole module exists
 *  to avoid paying twice. */
function threadGets(seen: string[]): string[] {
  return seen.filter((u) => /\/threads\/[^/?]+/.test(new URL(u).pathname))
}

describe('syncThreads', () => {
  it('does a full fetch when nothing is cached', async () => {
    const { api, seen } = gmail({
      list: [{ id: 't1' }, { id: 't2' }],
      threads: { t1: rawThread('t1', 'One'), t2: rawThread('t2', 'Two') },
    })

    const page = await syncThreads(api, cache, {})

    expect(page.threads.map((t) => t.subject)).toEqual(['One', 'Two'])
    expect(threadGets(seen)).toHaveLength(2)
  })

  it('asks Gmail only what changed when a history id is held', async () => {
    const first = gmail({
      list: [{ id: 't1' }, { id: 't2' }],
      threads: { t1: rawThread('t1', 'One'), t2: rawThread('t2', 'Two') },
    })
    await syncThreads(first.api, cache, {})

    // Nothing has happened since.
    const second = gmail({ history: { historyId: '5001' } })
    const page = await syncThreads(second.api, cache, {})

    expect(page.threads.map((t) => t.subject)).toEqual(['One', 'Two'])
    // The whole point: the list is served from the cache and NOTHING is
    // refetched. One request instead of twenty-six.
    expect(threadGets(second.seen)).toHaveLength(0)
  })

  it('refetches only the threads history says changed', async () => {
    const first = gmail({
      list: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
      threads: {
        t1: rawThread('t1', 'One'),
        t2: rawThread('t2', 'Two'),
        t3: rawThread('t3', 'Three'),
      },
    })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      history: {
        historyId: '5002',
        history: [
          { messagesAdded: [{ message: { id: 'm9', threadId: 't1' } }] },
          { messagesAdded: [{ message: { id: 'm10', threadId: 't3' } }] },
        ],
      },
      threads: { t1: rawThread('t1', 'One (updated)'), t3: rawThread('t3', 'Three (updated)') },
    })
    const page = await syncThreads(second.api, cache, {})

    // Two changed threads → two gets, not twenty-five. This is the win.
    expect(threadGets(second.seen)).toHaveLength(2)
    expect(page.threads.map((t) => t.subject)).toContain('One (updated)')
    expect(page.threads.map((t) => t.subject)).toContain('Two')
  })

  it('falls back to a full fetch when Google has expired the history id', async () => {
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'One') } })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      history: 404,
      list: [{ id: 't1' }, { id: 't2' }],
      threads: { t1: rawThread('t1', 'One'), t2: rawThread('t2', 'Two') },
    })

    // Gmail keeps roughly a week of history. A 404 here means "resync", not
    // "something went wrong" — it must never surface as a failure.
    const page = await syncThreads(second.api, cache, {})

    expect(page.threads.map((t) => t.subject)).toEqual(['One', 'Two'])
  })

  it('stores the new history id after a sync', async () => {
    const { api } = gmail({
      list: [{ id: 't1' }],
      threads: { t1: rawThread('t1', 'One') },
      profile: { historyId: '4242' },
    })

    await syncThreads(api, cache, {})

    // Without this the next refresh is another full fetch, and the cache buys
    // a fast paint but no requests back. Stored against the list it was taken
    // for — see `cacheKey`.
    expect(cache.historyId(cacheKey({}))).toBe('4242')
  })

  it('applies a label change without refetching the thread', async () => {
    const first = gmail({
      list: [{ id: 't1' }],
      threads: { t1: rawThread('t1', 'One', ['INBOX', 'UNREAD']) },
    })
    expect((await syncThreads(first.api, cache, {})).threads[0]!.unread).toBe(true)

    const second = gmail({
      history: {
        historyId: '5003',
        history: [
          {
            labelsRemoved: [
              { message: { id: 't1-m1', threadId: 't1' }, labelIds: ['UNREAD'] },
            ],
          },
        ],
      },
    })
    const page = await syncThreads(second.api, cache, {})

    // Read/unread is the most common delta there is; paying a request for it
    // would spend the whole saving.
    expect(page.threads[0]!.unread).toBe(false)
    expect(threadGets(second.seen)).toHaveLength(0)
  })

  it('refetches when a user label changes, rather than guessing the name', async () => {
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'One') } })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      history: {
        historyId: '5004',
        history: [
          { labelsAdded: [{ message: { id: 't1-m1', threadId: 't1' }, labelIds: ['Label_12'] }] },
        ],
      },
      threads: { t1: rawThread('t1', 'One', ['INBOX', 'Label_12']) },
    })
    await syncThreads(second.api, cache, {})

    // The cache holds label NAMES; a bare `Label_12` cannot be turned into one
    // without a lookup, so this is the case where a refetch is the cheap answer.
    expect(threadGets(second.seen)).toHaveLength(1)
  })

  it('drops a thread history reports as deleted', async () => {
    const first = gmail({
      list: [{ id: 't1' }, { id: 't2' }],
      threads: { t1: rawThread('t1', 'One'), t2: rawThread('t2', 'Two') },
    })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      history: {
        historyId: '5005',
        history: [{ messagesDeleted: [{ message: { id: 't2-m1', threadId: 't2' } }] }],
      },
    })
    const page = await syncThreads(second.api, cache, {})

    expect(page.threads.map((t) => t.id)).toEqual(['t1'])
  })

  it('does not serve a cached list for a different query', async () => {
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'Inbox thing') } })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      list: [{ id: 't9' }],
      threads: { t9: rawThread('t9', 'Search hit') },
    })
    const page = await syncThreads(second.api, cache, { query: 'from:jane' })

    // A delta is only meaningful against the list it was computed for.
    expect(page.threads.map((t) => t.subject)).toEqual(['Search hit'])
  })

  it('asks for changes since the list was cached, not since some other list was', async () => {
    // The inbox is cached at cursor 100…
    const inbox = gmail({
      list: [{ id: 't1' }],
      threads: { t1: rawThread('t1', 'One') },
      profile: { historyId: '100' },
    })
    await syncThreads(inbox.api, cache, {})

    // …then a search is run, and the mailbox has moved on to 200.
    const search = gmail({
      list: [{ id: 't9' }],
      threads: { t9: rawThread('t9', 'Hit') },
      profile: { historyId: '200' },
    })
    await syncThreads(search.api, cache, { query: 'from:jane' })

    const back = gmail({ history: { historyId: '201' } })
    await syncThreads(back.api, cache, {})

    // A single mailbox-wide cursor would ask "what changed since 200?" against
    // a list last written at 100 — and everything in between is silently lost
    // from that list until something else forces a full resync.
    const asked = back.seen.find((u) => new URL(u).pathname.endsWith('/history'))!
    expect(new URL(asked).searchParams.get('startHistoryId')).toBe('100')
  })

  /**
   * Archive, trash and spam — **the threads that leave without being deleted.**
   *
   * The bug these exist for: `messagesDeleted` is the only thing that used to
   * take a thread out of a cached list, and archiving is not a deletion. So
   * history reported `labelsRemoved: ['INBOX']`, that was not a patchable label,
   * the thread was refetched — `threads.get` still answers, it is in All Mail —
   * and `merge` found it absent from the cached list and added it back as new
   * mail, at the TOP, because the sort is by date.
   *
   * Worse, it stuck: the merged list was written back and the cursor advanced,
   * so no later delta ever mentioned it again. Archiving a thread in Holi made
   * it jump to the top of the inbox on the next refresh and stay there.
   */
  describe('a thread that leaves the inbox', () => {
    /** Archived at Gmail: the INBOX label removed, the thread otherwise intact. */
    function archivedInHistory(id: string) {
      return {
        historyId: '6001',
        history: [
          { labelsRemoved: [{ message: { id: `${id}-m1`, threadId: id }, labelIds: ['INBOX'] }] },
        ],
      }
    }

    async function cachedInbox() {
      const first = gmail({
        list: [{ id: 't1' }, { id: 't2' }],
        threads: { t1: rawThread('t1', 'One'), t2: rawThread('t2', 'Two') },
      })
      await syncThreads(first.api, cache, {})
    }

    it('does not come back as new mail', async () => {
      await cachedInbox()
      // What `data.archive` does to the cache once Google has agreed.
      cache.dropThread('t2')

      const second = gmail({
        history: archivedInHistory('t2'),
        // Still answers — an archived thread is in All Mail, which is exactly
        // why refetching it and trusting the result was wrong.
        threads: { t2: rawThread('t2', 'Two', []) },
      })
      const page = await syncThreads(second.api, cache, {})

      expect(page.threads.map((t) => t.id)).toEqual(['t1'])
    })

    it('stays gone across later syncs', async () => {
      await cachedInbox()
      cache.dropThread('t2')
      await syncThreads(
        gmail({ history: archivedInHistory('t2'), threads: { t2: rawThread('t2', 'Two', []) } }).api,
        cache,
        {},
      )

      // Nothing happens at all after that. The resurrection used to be written
      // back to the cache, so this is where it became permanent.
      const page = await syncThreads(gmail({ history: { historyId: '6002' } }).api, cache, {})

      expect(page.threads.map((t) => t.id)).toEqual(['t1'])
    })

    it('leaves when Gmail is the one that archived it', async () => {
      // Not our write: archived in the Gmail web UI, so the cache still holds
      // it. The row has to go, and this is the half that would have been broken
      // in the opposite direction if `left` were only about our own writes.
      await cachedInbox()

      const page = await syncThreads(
        gmail({ history: archivedInHistory('t2'), threads: { t2: rawThread('t2', 'Two', []) } }).api,
        cache,
        {},
      )

      expect(page.threads.map((t) => t.id)).toEqual(['t1'])
    })

    it('spends no request refetching a thread it is about to drop', async () => {
      await cachedInbox()

      const second = gmail({
        history: archivedInHistory('t2'),
        threads: { t2: rawThread('t2', 'Two', []) },
      })
      await syncThreads(second.api, cache, {})

      expect(threadGets(second.seen)).toHaveLength(0)
    })

    it('treats trash the same way, though nothing was deleted', async () => {
      await cachedInbox()

      const second = gmail({
        history: {
          historyId: '6003',
          history: [
            { labelsAdded: [{ message: { id: 't2-m1', threadId: 't2' }, labelIds: ['TRASH'] }] },
          ],
        },
        threads: { t2: rawThread('t2', 'Two', ['TRASH']) },
      })
      const page = await syncThreads(second.api, cache, {})

      expect(page.threads.map((t) => t.id)).toEqual(['t1'])
    })

    it('comes back when it is put back', async () => {
      // The reverse must work or un-archiving would be invisible until a full
      // resync. Both events in one window, in order: the last one wins.
      await cachedInbox()
      cache.dropThread('t2')

      const second = gmail({
        history: {
          historyId: '6004',
          history: [
            { labelsRemoved: [{ message: { id: 't2-m1', threadId: 't2' }, labelIds: ['INBOX'] }] },
            { labelsAdded: [{ message: { id: 't2-m1', threadId: 't2' }, labelIds: ['INBOX'] }] },
          ],
        },
        threads: { t2: rawThread('t2', 'Two') },
      })
      const page = await syncThreads(second.api, cache, {})

      expect(page.threads.map((t) => t.id)).toContain('t2')
    })

    it('keeps it in a SEARCH, which may still legitimately match', async () => {
      // An explicit query is not the inbox, so "left the inbox" says nothing
      // about whether the thread still answers `from:jane`. Here it is a
      // refetch, exactly as it was before departures existed.
      const first = gmail({
        list: [{ id: 't2' }],
        threads: { t2: rawThread('t2', 'Two') },
      })
      await syncThreads(first.api, cache, { query: 'from:jane' })

      const second = gmail({
        history: archivedInHistory('t2'),
        threads: { t2: rawThread('t2', 'Two (archived)', []) },
      })
      const page = await syncThreads(second.api, cache, { query: 'from:jane' })

      expect(page.threads.map((t) => t.subject)).toEqual(['Two (archived)'])
    })
  })

  /**
   * The unread filter is a different question, so it needs a different key.
   *
   * `cacheKey` was `query|category` while `ListThreadsOptions.unread` also
   * narrows the list (`composeQuery` ANDs `is:unread` on). The two lists
   * therefore shared one cache entry, and the consequence was not staleness but
   * a wrong answer in both directions.
   */
  describe('the unread filter', () => {
    it('is not served the whole inbox from the unfiltered cache', async () => {
      const first = gmail({
        list: [{ id: 't1' }, { id: 't2' }],
        threads: {
          t1: rawThread('t1', 'Read one'),
          t2: rawThread('t2', 'Unread one', ['INBOX', 'UNREAD']),
        },
      })
      await syncThreads(first.api, cache, {})

      const second = gmail({
        list: [{ id: 't2' }],
        threads: { t2: rawThread('t2', 'Unread one', ['INBOX', 'UNREAD']) },
      })
      const page = await syncThreads(second.api, cache, { unread: true })

      expect(page.threads.map((t) => t.id)).toEqual(['t2'])
    })

    /**
     * A thread that stops being unread has left the unread list.
     *
     * The departure machinery only ever modelled leaving the *mailbox* —
     * INBOX removed, TRASH or SPAM added. Nothing modelled leaving *this
     * list*, so a thread read while the unread list was cached was patched
     * to `unread: false` and kept: the delta path handed back a list of
     * read mail under the unread key. A cold cache was correct, which is
     * why this survived — it only ever went wrong on the second visit, and
     * opening a thread is what marks it read.
     */
    it('drops a thread from the unread list once it has been read', async () => {
      const first = gmail({
        list: [{ id: 't1' }, { id: 't2' }],
        threads: {
          t1: rawThread('t1', 'One', ['INBOX', 'UNREAD']),
          t2: rawThread('t2', 'Two', ['INBOX', 'UNREAD']),
        },
      })
      expect((await syncThreads(first.api, cache, { unread: true })).threads).toHaveLength(2)

      // Exactly what opening t1 produces.
      const second = gmail({
        history: {
          historyId: '5002',
          history: [
            { labelsRemoved: [{ message: { id: 't1-m1', threadId: 't1' }, labelIds: ['UNREAD'] }] },
          ],
        },
      })
      const page = await syncThreads(second.api, cache, { unread: true })

      expect(page.threads.map((t) => t.id)).toEqual(['t2'])
    })

    it('keeps a read thread in the list that did not ask about unread', async () => {
      // The same event, on the plain inbox: being read is a flag here, not a
      // departure, and dropping the row would be the opposite bug.
      const first = gmail({
        list: [{ id: 't1' }],
        threads: { t1: rawThread('t1', 'One', ['INBOX', 'UNREAD']) },
      })
      await syncThreads(first.api, cache, {})

      const second = gmail({
        history: {
          historyId: '5002',
          history: [
            { labelsRemoved: [{ message: { id: 't1-m1', threadId: 't1' }, labelIds: ['UNREAD'] }] },
          ],
        },
      })
      const page = await syncThreads(second.api, cache, {})

      expect(page.threads.map((t) => t.id)).toEqual(['t1'])
      expect(page.threads[0]!.unread).toBe(false)
    })

    it('does not overwrite the inbox with its own narrower answer', async () => {
      // The other direction, and the more damaging one: a cold unread-only
      // fetch used to be written under the inbox's key, so the unfiltered list
      // then showed only unread threads until something forced a resync.
      const unreadOnly = gmail({
        list: [{ id: 't2' }],
        threads: { t2: rawThread('t2', 'Unread one', ['INBOX', 'UNREAD']) },
      })
      await syncThreads(unreadOnly.api, cache, { unread: true })

      const everything = gmail({
        list: [{ id: 't1' }, { id: 't2' }],
        threads: {
          t1: rawThread('t1', 'Read one'),
          t2: rawThread('t2', 'Unread one', ['INBOX', 'UNREAD']),
        },
      })
      const page = await syncThreads(everything.api, cache, {})

      expect(page.threads.map((t) => t.id)).toEqual(['t1', 't2'])
    })
  })

  /**
   * Sent is a different mailbox, so it is a different list — and the delta
   * machinery was written knowing only about the inbox.
   *
   * Two things were hardcoded to `INBOX`: the label `history.list` is scoped
   * to, and the label whose *removal* means a thread has left. Neither is right
   * for Sent. Scoping the delta to INBOX would mean a newly sent message never
   * appeared, and worse, it would never appear *again* — the cursor advances
   * past the event that would have explained it. And "INBOX was removed" is
   * what archiving a conversation does, which has nothing to do with whether
   * the account sent it.
   */
  describe('the Sent mailbox', () => {
    it('is not served the inbox from the inbox’s cache entry', async () => {
      const inbox = gmail({
        list: [{ id: 't1' }],
        threads: { t1: rawThread('t1', 'Something received') },
      })
      await syncThreads(inbox.api, cache, {})

      const sent = gmail({
        list: [{ id: 't9' }],
        threads: { t9: rawThread('t9', 'Something sent', ['SENT']) },
      })
      const page = await syncThreads(sent.api, cache, { mailbox: 'sent' })

      expect(page.threads.map((t) => t.subject)).toEqual(['Something sent'])
    })

    it('scopes the delta to SENT rather than to the inbox', async () => {
      const first = gmail({
        list: [{ id: 't9' }],
        threads: { t9: rawThread('t9', 'Something sent', ['SENT']) },
      })
      await syncThreads(first.api, cache, { mailbox: 'sent' })

      const second = gmail({ history: { historyId: '5001' } })
      await syncThreads(second.api, cache, { mailbox: 'sent' })

      const history = second.seen.find((url) => new URL(url).pathname.endsWith('/history'))!
      expect(new URL(history).searchParams.get('labelId')).toBe('SENT')
    })

    it('keeps a sent thread that was archived out of the inbox', async () => {
      // Archiving removes INBOX. In the inbox list that means the thread is
      // gone; in Sent it means nothing at all — the account still sent it.
      const first = gmail({
        list: [{ id: 't9' }],
        threads: { t9: rawThread('t9', 'Something sent', ['SENT']) },
      })
      await syncThreads(first.api, cache, { mailbox: 'sent' })

      const second = gmail({
        history: {
          historyId: '5002',
          history: [
            { labelsRemoved: [{ message: { id: 't9-m1', threadId: 't9' }, labelIds: ['INBOX'] }] },
          ],
        },
        threads: { t9: rawThread('t9', 'Something sent', ['SENT']) },
      })
      const page = await syncThreads(second.api, cache, { mailbox: 'sent' })

      expect(page.threads.map((t) => t.id)).toEqual(['t9'])
    })

    it('drops a sent thread that was trashed', async () => {
      // The departure that IS real for Sent, and the one `LEFT_WHEN_ADDED`
      // already covered.
      const first = gmail({
        list: [{ id: 't9' }],
        threads: { t9: rawThread('t9', 'Something sent', ['SENT']) },
      })
      await syncThreads(first.api, cache, { mailbox: 'sent' })

      const second = gmail({
        history: {
          historyId: '5002',
          history: [
            { labelsAdded: [{ message: { id: 't9-m1', threadId: 't9' }, labelIds: ['TRASH'] }] },
          ],
        },
      })
      const page = await syncThreads(second.api, cache, { mailbox: 'sent' })

      expect(page.threads).toEqual([])
    })
  })

  it('goes straight to Gmail for a later page, never to the cache', async () => {
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'One') } })
    await syncThreads(first.api, cache, {})

    const second = gmail({ list: [{ id: 't2' }], threads: { t2: rawThread('t2', 'Two') } })
    const page = await syncThreads(second.api, cache, { pageToken: 'page-2' })

    // "Load more" asks for what is past the tail — the one thing the cache by
    // definition does not hold.
    expect(page.threads.map((t) => t.subject)).toEqual(['Two'])
  })
})
