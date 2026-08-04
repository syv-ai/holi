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
  cache.useAccount('sub-a')
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
