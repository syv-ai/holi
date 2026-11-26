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
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { GoogleApi, type GoogleApiDeps } from '../main/api'
import { openGoogleCache, type GoogleCache } from '../main/cache'
import {
  disposeGoogleCapabilities,
  googleCapabilities,
  GOOGLE_NAMESPACES,
  type GoogleCapabilityDeps,
} from '../main/capabilities'
import { createGoogleData } from '../main/data'
import { readThread, type MailPage } from '../main/gmail'
import { cacheKey, syncThreads } from '../main/mail-sync'

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
      message(
        `${id}-m1`,
        id,
        [
          ['Subject', subject],
          ['From', 'Jane <jane@x.com>'],
        ],
        labels,
      ),
    ],
  }
}

interface Routes {
  /** `threads.list` — the ids, newest first. */
  list?: { id: string }[]
  listPages?: Record<string, { threads: { id: string }[]; nextPageToken?: string }>
  threads?: Record<string, unknown>
  /** Headers-only `messages.get` responses; no MIME bodies. */
  mimeProbes?: Record<string, unknown>
  /** `history.list`. A number means "answer this status instead". */
  history?: unknown | number
  historyPages?: Record<string, unknown | number>
  profile?: { historyId?: string }
  missingThreads?: string[]
  failedThreads?: string[]
}

/** A fake Gmail covering list, get, history, labels and profile. */
function gmail(
  routes: Routes,
  deps: Partial<Omit<GoogleApiDeps, 'fetch'>> = {},
  override?: (url: URL, signal: AbortSignal) => Promise<Response> | undefined,
) {
  const seen: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    seen.push(url.href)
    if (init?.method && init.method !== 'GET') throw new Error('Mail sync must only read')
    const signal = init?.signal
    if (!signal) throw new Error('Expected an abortable Google request')
    signal.throwIfAborted()
    const response = override?.(url, signal)
    if (response !== undefined) return response
    const path = url.pathname
    const ok = (body: unknown) => Response.json(body)

    // Mail access can work on a grant that cannot list send-as aliases.
    if (path.endsWith('/settings/sendAs')) {
      return Response.json(
        { error: { errors: [{ reason: 'insufficientPermissions' }] } },
        { status: 403 },
      )
    }
    if (path.endsWith('/labels')) return ok({ labels: [] })
    if (path.endsWith('/profile')) return ok(routes.profile ?? { historyId: '5000' })
    if (path.endsWith('/history')) {
      const token = new URL(url).searchParams.get('pageToken') ?? ''
      const historyPage = routes.historyPages?.[token] ?? routes.history
      if (typeof historyPage === 'number') {
        // Gmail answers 404 when `startHistoryId` is older than it keeps —
        // roughly a week. A NORMAL outcome, not an error.
        return Response.json({}, { status: historyPage })
      }
      return ok(historyPage ?? { historyId: '5000' })
    }
    if (path.endsWith('/threads')) {
      const params = new URL(url).searchParams
      if (params.get('q')?.includes('filename:ics')) return ok({})
      return ok(routes.listPages?.[params.get('pageToken') ?? ''] ?? { threads: routes.list ?? [] })
    }
    const mimeProbe = /\/messages\/([^/]+)$/.exec(path)
    if (mimeProbe) {
      const params = new URL(url).searchParams
      const fields = params.get('fields') ?? ''
      if (
        params.get('format') !== 'full' ||
        !fields.includes('parts(') ||
        /body|data|attachmentId/i.test(fields)
      )
        throw new Error('Expected a masked MIME structure probe')
      const probe = routes.mimeProbes?.[mimeProbe[1]!]
      if (!probe) throw new Error('No message for MIME structure probe')
      return ok(probe)
    }
    const metadata = /\/threads\/([^/]+)$/.exec(path)
    if (!metadata || url.searchParams.get('format') !== 'metadata')
      throw new Error(`Unexpected Gmail read: ${url}`)
    const threadId = metadata[1]!
    if (routes.missingThreads?.includes(threadId)) {
      return Response.json({ error: { code: 404, status: 'NOT_FOUND' } }, { status: 404 })
    }
    if (routes.failedThreads?.includes(threadId)) {
      return Response.json({ error: { code: 503, status: 'UNAVAILABLE' } }, { status: 503 })
    }
    return ok(routes.threads?.[threadId] ?? {})
  }

  return { api: new GoogleApi({ accessToken: async () => 'at', ...deps, fetch }), seen }
}

/** The UI search capability with real Google data and cache for one connected vault. */
async function searchMail(api: GoogleApi, params = {}): Promise<MailPage> {
  const remote = 'owner/inbox'
  const data = createGoogleData({ api: () => api, cache })
  const capabilities = googleCapabilities({
    accounts: {} as GoogleCapabilityDeps['accounts'],
    dataFor: async (caller) => (caller === remote ? data : null),
    settings: {
      read: async () => ({ calendars: {}, imageSenders: [], imagesFromAllSenders: false }),
      write: async () => {},
    },
  })
  const registry = createCapabilityRegistry()
  registry.register(GOOGLE_NAMESPACES, capabilities)
  try {
    const { value } = await registry.run(
      'google.search',
      'ui',
      {
        remote,
        root: remote,
        bundle: null,
        snapshot: async () => emptyVaultSnapshot(),
        claims: async () => [],
        core: noCoreServices(),
      },
      params,
    )
    return value as MailPage
  } finally {
    disposeGoogleCapabilities(capabilities)
  }
}

/** Drive the request's native signal deterministically, without waiting for a timer. */
function captureDeadlines() {
  const requests = new WeakMap<AbortSignal, AbortController>()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController()
    requests.set(controller.signal, controller)
    return controller.signal
  })
  return {
    expire(signal: AbortSignal) {
      const request = requests.get(signal)
      if (!request) throw new Error('Expected the request deadline signal')
      request.abort(new DOMException('The operation timed out', 'TimeoutError'))
    },
    restore: () => timeout.mockRestore(),
  }
}

/** A fetch waiting for headers rejects with the abort reason, not a response. */
function beforeHeaders(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
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

  it.each([{}, { freshPage: true }, { refresh: true }])(
    'reports current first-page metadata 404s without mistaking a 503 for absence (%j)',
    async (context) => {
      const { api } = gmail({
        listPages: {
          '': {
            threads: [{ id: 'gone' }, { id: 'unreadable' }, { id: 'healthy' }],
            nextPageToken: 'page-2',
          },
        },
        missingThreads: ['gone'],
        failedThreads: ['unreadable'],
        threads: { healthy: rawThread('healthy', 'Still here') },
      })
      const page = await syncThreads(api, cache, {}, undefined, context)
      expect(page.threads.map(({ id }) => id)).toEqual(['healthy'])
      expect(page.nextPageToken).toBe('page-2')
      expect(page.notFoundThreadIds).toEqual(['gone'])
      expect(page.unreadableThreadIds).toEqual(['unreadable'])
    },
  )

  it('fetches each needs-reply page fresh without sharing the ordinary list cache', async () => {
    const cold = gmail({ listPages: { '': { threads: [], nextPageToken: 'cold-next' } } })
    expect(await syncThreads(cold.api, cache, { needsReply: true })).toMatchObject({
      threads: [],
      nextPageToken: 'cold-next',
    })

    const ordinary = gmail({
      list: [{ id: 'ordinary' }],
      threads: { ordinary: rawThread('ordinary', 'Ordinary') },
    })
    await syncThreads(ordinary.api, cache, {})

    const firstPage = gmail({
      listPages: { '': { threads: [{ id: 'filtered-out' }], nextPageToken: 'page-2' } },
      threads: { 'filtered-out': rawThread('filtered-out', 'Filtered out') },
    })
    const first = await syncThreads(firstPage.api, cache, { needsReply: true })
    expect(first).toMatchObject({ threads: [{ id: 'filtered-out' }], nextPageToken: 'page-2' })

    const emptyPage = gmail({ listPages: { '': { threads: [], nextPageToken: 'page-3' } } })
    expect(await syncThreads(emptyPage.api, cache, { needsReply: true })).toMatchObject({
      threads: [],
      nextPageToken: 'page-3',
    })

    const continued = gmail({ listPages: { 'page-2': { threads: [], nextPageToken: 'page-3' } } })
    expect(
      await syncThreads(continued.api, cache, { needsReply: true, pageToken: 'page-2' }),
    ).toMatchObject({ threads: [], nextPageToken: 'page-3' })
    expect(
      new URL(continued.seen.find((url) => url.includes('/threads?'))!).searchParams.get(
        'pageToken',
      ),
    ).toBe('page-2')

    // Neither the needs-reply fetch nor its filtered empty page overwrote the
    // independently maintained ordinary inbox cache.
    expect(cache.readThreads(cacheKey({}))?.map((thread) => thread.id)).toEqual(['ordinary'])
  })

  it('refreshes explicit searches so repeated results retain current pagination', async () => {
    const firstIds = Array.from({ length: 25 }, (_, i) => `t${i + 1}`)
    const threads = Object.fromEntries([...firstIds, 't26'].map((id) => [id, rawThread(id, id)]))
    const first = gmail({
      listPages: { '': { threads: firstIds.map((id) => ({ id })), nextPageToken: 'page-2' } },
      threads,
    })
    const query = { query: 'in:inbox newer_than:7d' }

    const initial = await syncThreads(first.api, cache, query)
    expect(initial.threads).toHaveLength(25)
    expect(initial.nextPageToken).toBe('page-2')

    const repeated = gmail({
      listPages: { '': { threads: firstIds.map((id) => ({ id })), nextPageToken: 'page-2' } },
      threads,
    })
    const refreshed = await syncThreads(repeated.api, cache, query)
    expect(refreshed.threads).toHaveLength(25)
    expect(refreshed.nextPageToken).toBe('page-2')

    const later = gmail({ list: [{ id: 't26' }], threads })
    const next = await syncThreads(later.api, cache, { ...query, pageToken: 'page-2' })
    expect(next.threads.map((thread) => thread.id)).toEqual(['t26'])
    expect(next.nextPageToken).toBeNull()
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

  it('rebuilds an older invitation classification even when mailbox history is unchanged', async () => {
    const id = 't1'
    const messageId = 't1-m1'
    const metadata = rawThread(id, 'Inline invite')
    const payload = {
      mimeType: 'application/octet-stream',
      headers: [
        ...metadata.messages[0]!.payload.headers,
        {
          name: 'Content-Type',
          value: '(outer (comment)) multipart (type) / mixed; boundary="invite"',
        },
      ],
    }
    const provider = gmail({
      list: [{ id }],
      threads: { [id]: { id, messages: [{ ...metadata.messages[0], payload }] } },
      mimeProbes: {
        [messageId]: {
          id: messageId,
          threadId: id,
          payload: { ...payload, parts: [{ mimeType: 'text/calendar; method=REQUEST' }] },
        },
      },
      history: { historyId: '5000' },
    })
    const key = cacheKey({})
    const current = await syncThreads(provider.api, cache, {})
    // Persist the previous release's classification of the same provider row.
    cache.writeThreads(
      key,
      current.threads.map((thread) => ({ ...thread, hasInvite: false, automated: false })),
    )
    cache.close()
    const path = join(dir, 'cache.db')
    const legacy = new DatabaseSync(path)
    legacy.prepare("UPDATE meta SET value = '6' WHERE key = 'shape'").run()
    legacy.close()

    cache = openGoogleCache(path)
    cache.ensureShape()
    const upgraded = await syncThreads(provider.api, cache, {})
    expect(upgraded.threads).toMatchObject([{ id, hasInvite: true, automated: true }])

    cache.close()
    cache = openGoogleCache(path)
    cache.ensureShape()
    const unchanged = gmail({ history: { historyId: '5000' } })
    expect((await syncThreads(unchanged.api, cache, {})).threads).toMatchObject(upgraded.threads)
  })

  it('observes sent-only changes for cached inbox threads without importing unrelated threads', async () => {
    const first = gmail({
      list: [{ id: 'cached' }],
      threads: { cached: rawThread('cached', 'Incoming') },
    })
    await syncThreads(first.api, cache, {})

    const replied = rawThread('cached', 'Incoming')
    replied.messages.push(
      message('cached-reply', 'cached', [['From', 'Me <me@example.com>']], ['SENT']),
    )
    const second = gmail({
      history: {
        historyId: '5002',
        history: [
          {
            messagesAdded: [
              { message: { id: 'reply', threadId: 'cached' } },
              { message: { id: 'unrelated', threadId: 'sent-only' } },
            ],
          },
        ],
      },
      threads: { cached: replied, 'sent-only': rawThread('sent-only', 'Unrelated', ['SENT']) },
    })
    const page = await syncThreads(second.api, cache, {})

    expect(page.threads.map((thread) => thread.id)).toEqual(['cached'])
    expect(page.threads[0]!.replied).toBe(true)
    expect(threadGets(second.seen)).toHaveLength(1)
    const historyUrl = second.seen.find((url) => new URL(url).pathname.endsWith('/history'))!
    expect(new URL(historyUrl).searchParams.has('labelId')).toBe(false)
  })

  it('applies arrivals and replies found on later history pages', async () => {
    const first = gmail({
      list: [{ id: 'cached' }],
      threads: { cached: rawThread('cached', 'Incoming') },
    })
    await syncThreads(first.api, cache, {})

    const replied = rawThread('cached', 'Incoming')
    replied.messages.push(
      message('cached-reply', 'cached', [['From', 'Me <me@example.com>']], ['SENT']),
    )
    const second = gmail({
      historyPages: {
        '': {
          historyId: '5001',
          history: [{ messagesAdded: [{ message: { id: 'irrelevant', threadId: 'elsewhere' } }] }],
          nextPageToken: 'next',
        },
        next: {
          historyId: '5002',
          history: [
            { messagesAdded: [{ message: { id: 'arrival-message', threadId: 'arrival' } }] },
            { messagesAdded: [{ message: { id: 'reply-message', threadId: 'cached' } }] },
          ],
        },
      },
      list: [{ id: 'arrival' }],
      threads: {
        arrival: rawThread('arrival', 'New arrival'),
        cached: replied,
      },
    })

    const page = await syncThreads(second.api, cache, {})

    expect(page.threads.map((thread) => thread.id)).toEqual(['arrival', 'cached'])
    expect(page.threads.find((thread) => thread.id === 'cached')!.replied).toBe(true)
    expect(cache.historyId(cacheKey({}))).toBe('5002')
    const historyRequests = second.seen.filter((url) => new URL(url).pathname.endsWith('/history'))
    expect(historyRequests).toHaveLength(2)
    expect(historyRequests.map((url) => new URL(url).searchParams.get('startHistoryId'))).toEqual([
      '5000',
      '5000',
    ])
    expect(new URL(historyRequests[1]!).searchParams.get('pageToken')).toBe('next')
  })

  it('keeps the cached list and cursor when a later history page fails', async () => {
    const first = gmail({
      list: [{ id: 'cached' }],
      threads: { cached: rawThread('cached', 'Incoming') },
    })
    const original = await syncThreads(first.api, cache, {})
    const cursor = cache.historyId(cacheKey({}))

    const second = gmail({
      historyPages: {
        '': {
          historyId: '5001',
          history: [{ messagesAdded: [{ message: { id: 'changed', threadId: 'cached' } }] }],
          nextPageToken: 'broken',
        },
        broken: 503,
      },
      threads: { cached: rawThread('cached', 'Changed') },
    })

    await expect(syncThreads(second.api, cache, {})).rejects.toThrow()
    expect(cache.readThreads(cacheKey({}))).toEqual(original.threads)
    expect(cache.historyId(cacheKey({}))).toBe(cursor)
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
            labelsRemoved: [{ message: { id: 't1-m1', threadId: 't1' }, labelIds: ['UNREAD'] }],
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

  it('keeps a conversation when history deletes only its draft message', async () => {
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'Reply') } })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      list: [{ id: 't1' }],
      history: {
        historyId: '5005',
        history: [{ messagesDeleted: [{ message: { id: 'draft', threadId: 't1' } }] }],
      },
      threads: { t1: rawThread('t1', 'Reply') },
    })
    const page = await syncThreads(second.api, cache, {})
    expect(page.threads.map((thread) => thread.id)).toEqual(['t1'])
    expect(threadGets(second.seen)).toHaveLength(1)
  })

  it('refreshes a drafts query when its last draft is deleted', async () => {
    const options = { query: 'in:drafts' }
    const draft = rawThread('t1', 'Draft', ['DRAFT'])
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: draft } })
    await syncThreads(first.api, cache, options)

    const survivingIncoming = rawThread('t1', 'Incoming', ['INBOX'])
    const second = gmail({
      history: {
        historyId: '5005',
        history: [{ messagesDeleted: [{ message: { id: 'draft', threadId: 't1' } }] }],
      },
      list: [],
      threads: { t1: survivingIncoming },
    })

    const page = await syncThreads(second.api, cache, options)

    expect(page.threads).toEqual([])
    expect(threadGets(second.seen)).toHaveLength(0)
  })

  it('refreshes a matching drafts query after a draft is deleted', async () => {
    const options = { query: 'in:drafts' }
    const draft = rawThread('t1', 'Before', ['DRAFT'])
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: draft } })
    await syncThreads(first.api, cache, options)

    const survivingDraft = rawThread('t1', 'Updated', ['DRAFT'])
    const second = gmail({
      history: {
        historyId: '5005',
        history: [{ messagesDeleted: [{ message: { id: 'old-draft', threadId: 't1' } }] }],
      },
      list: [{ id: 't1' }],
      threads: { t1: survivingDraft },
    })

    const page = await syncThreads(second.api, cache, options)

    expect(page.threads.map((thread) => thread.subject)).toEqual(['Updated'])
    expect(threadGets(second.seen)).toHaveLength(1)
  })

  it('retains a thread when a draft is replaced by another draft', async () => {
    const original = rawThread('t1', 'Reply')
    original.messages.push(message('old-draft', 't1', [], ['DRAFT']))
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: original } })
    await syncThreads(first.api, cache, {})

    const replacement = rawThread('t1', 'Reply')
    replacement.messages.push(message('replacement-draft', 't1', [], ['DRAFT']))
    const second = gmail({
      list: [{ id: 't1' }],
      history: {
        historyId: '5005',
        history: [
          { messagesDeleted: [{ message: { id: 'old-draft', threadId: 't1' } }] },
          { messagesAdded: [{ message: { id: 'replacement-draft', threadId: 't1' } }] },
        ],
      },
      threads: { t1: replacement },
    })

    const page = await syncThreads(second.api, cache, {})
    expect(page.threads.map((thread) => thread.id)).toEqual(['t1'])
    expect(page.threads[0]!.hasDraft).toBe(true)
  })

  it('retains a thread and records its reply when a draft is sent', async () => {
    const draft = rawThread('t1', 'Reply')
    draft.messages.push(message('draft', 't1', [], ['DRAFT']))
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: draft } })
    await syncThreads(first.api, cache, {})

    const sent = rawThread('t1', 'Reply')
    sent.messages.push({
      ...message('sent-reply', 't1', [['From', 'Me <me@example.com>']], ['SENT']),
      internalDate: '2000000000000',
    })
    const second = gmail({
      list: [{ id: 't1' }],
      history: {
        historyId: '5006',
        history: [
          { messagesDeleted: [{ message: { id: 'draft', threadId: 't1' } }] },
          { messagesAdded: [{ message: { id: 'sent-reply', threadId: 't1' } }] },
        ],
      },
      threads: { t1: sent },
    })

    const page = await syncThreads(second.api, cache, {})
    expect(page.threads.map((thread) => thread.id)).toEqual(['t1'])
    expect(page.threads[0]).toMatchObject({
      replied: true,
      lastReplyAt: new Date(2000000000000).toISOString(),
    })
  })

  it.each([
    ['Inbox', {}, 'in:inbox', ['INBOX']],
    ['Sent', { mailbox: 'sent' as const }, 'in:sent', ['SENT']],
  ])(
    'admits an uncached message arrival for %s without labelsAdded',
    async (_name, options, query, labels) => {
      const first = gmail({ list: [{ id: 'old' }], threads: { old: rawThread('old', 'Old') } })
      await syncThreads(first.api, cache, options)

      const second = gmail({
        list: [{ id: 'new' }],
        history: {
          historyId: '5005',
          history: [{ messagesAdded: [{ message: { id: 'new-message', threadId: 'new' } }] }],
        },
        threads: { new: rawThread('new', 'New matching result', labels) },
      })
      const page = await syncThreads(second.api, cache, options)

      expect(page.threads.map((thread) => thread.id)).toContain('new')
      const list = second.seen.find((url) => new URL(url).pathname.endsWith('/threads'))!
      expect(new URL(list).searchParams.get('q')).toBe(query)
    },
  )

  it('admits a label-only arrival after an archive and undo in the inbox', async () => {
    const options = {}
    const first = gmail({
      list: [{ id: 'restored' }, { id: 'old' }],
      threads: { restored: rawThread('restored', 'Restored match'), old: rawThread('old', 'Old') },
    })
    await syncThreads(first.api, cache, options)
    cache.dropThread('restored')

    const second = gmail({
      list: [{ id: 'restored' }],
      history: {
        historyId: '5005',
        history: [
          {
            labelsRemoved: [
              { message: { id: 'restored-m1', threadId: 'restored' }, labelIds: ['INBOX'] },
            ],
          },
          {
            labelsAdded: [
              { message: { id: 'restored-m1', threadId: 'restored' }, labelIds: ['INBOX'] },
            ],
          },
        ],
      },
      threads: { restored: rawThread('restored', 'Restored match') },
    })

    const page = await syncThreads(second.api, cache, options)

    expect(page.threads.map((thread) => thread.id)).toContain('restored')
    expect(threadGets(second.seen)).toEqual(
      expect.arrayContaining([expect.stringContaining('/threads/restored')]),
    )
  })

  it('does not admit unrelated archive or trash departures to the inbox', async () => {
    for (const [id, event] of [
      [
        'trashed-sent',
        { labelsAdded: [{ message: { id: 'm1', threadId: 'trashed-sent' }, labelIds: ['TRASH'] }] },
      ],
      [
        'archived-sent',
        {
          labelsRemoved: [
            { message: { id: 'm2', threadId: 'archived-sent' }, labelIds: ['INBOX'] },
          ],
        },
      ],
    ] as const) {
      const options = {}
      const first = gmail({
        list: [{ id: 'match' }],
        threads: { match: rawThread('match', 'Match') },
      })
      await syncThreads(first.api, cache, options)

      const second = gmail({
        list: [],
        history: { historyId: '5006', history: [event] },
        threads: { [id]: rawThread(id, 'Unrelated sent-only', ['SENT']) },
      })
      const page = await syncThreads(second.api, cache, options)

      expect(page.threads.map((thread) => thread.id)).not.toContain(id)
      expect(threadGets(second.seen)).not.toEqual(
        expect.arrayContaining([expect.stringContaining(`/threads/${id}`)]),
      )
    }
  })

  it('confirms uncached arrivals across every page of the active mailbox list', async () => {
    const options = {}
    const first = gmail({ list: [{ id: 'old' }], threads: { old: rawThread('old', 'Old') } })
    await syncThreads(first.api, cache, options)

    const second = gmail({
      history: {
        historyId: '5005',
        history: [
          {
            messagesAdded: [
              { message: { id: 'older-arrival', threadId: 'older-arrival' } },
              { message: { id: 'nonmatch', threadId: 'nonmatch' } },
            ],
          },
        ],
      },
      listPages: {
        '': { threads: [{ id: 'unrelated-1' }], nextPageToken: 'older' },
        older: { threads: [{ id: 'unrelated-2' }], nextPageToken: 'oldest' },
        oldest: { threads: [{ id: 'older-arrival' }] },
      },
      threads: {
        unrelated: rawThread('unrelated', 'Unrelated'),
        'older-arrival': rawThread('older-arrival', 'Older matching result'),
        nonmatch: rawThread('nonmatch', 'Not in query'),
      },
    })

    const page = await syncThreads(second.api, cache, options)

    expect(page.threads.map((thread) => thread.id)).toContain('older-arrival')
    expect(page.threads.map((thread) => thread.id)).not.toContain('nonmatch')
    expect(second.seen.some((url) => new URL(url).searchParams.get('pageToken') === 'older')).toBe(
      true,
    )
    expect(threadGets(second.seen)).toEqual(
      expect.arrayContaining([expect.stringContaining('/threads/older-arrival')]),
    )
    expect(threadGets(second.seen)).toHaveLength(1)
    expect(threadGets(second.seen).some((url) => url.includes('unrelated'))).toBe(false)
  })

  it('does not admit an uncached message that the active mailbox list does not return', async () => {
    const options = {}
    const first = gmail({ list: [{ id: 'old' }], threads: { old: rawThread('old', 'Old') } })
    await syncThreads(first.api, cache, options)

    const second = gmail({
      list: [{ id: 'other-match' }],
      history: {
        historyId: '5005',
        history: [{ messagesAdded: [{ message: { id: 'new-message', threadId: 'not-a-match' } }] }],
      },
      threads: {
        'other-match': rawThread('other-match', 'Other matching result'),
        'not-a-match': rawThread('not-a-match', 'Does not match'),
      },
    })
    const page = await syncThreads(second.api, cache, options)

    expect(page.threads.map((thread) => thread.id)).not.toContain('not-a-match')
    expect(page).not.toHaveProperty('notFoundThreadIds')
    expect(threadGets(second.seen)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('/threads/not-a-match')]),
    )
  })

  it.each([404, 200, 503])(
    'reconciles a cached deletion candidate omitted by Gmail’s list (metadata %i)',
    async (status) => {
      const invitation = rawThread('invitation', 'Meeting', ['INBOX', 'UNREAD'])
      const sentReply = message('sent-reply', 'invitation', [['Subject', 'Re: Meeting']], ['SENT'])
      // In the 200 control, only the inbox message was deleted; its Sent reply survives.
      if (status === 200) invitation.messages.push(sentReply)
      const healthy = rawThread('healthy', 'Other mail', ['INBOX', 'UNREAD'])
      const first = gmail({
        list: [{ id: 'invitation' }, { id: 'healthy' }],
        threads: { invitation, healthy },
      })
      const unread = { unread: true }
      await searchMail(first.api, unread)
      const initial = await searchMail(first.api)
      expect(initial.threads.map(({ id }) => id)).toEqual(['invitation', 'healthy'])

      const delta = gmail({
        list: [{ id: 'healthy' }],
        history: {
          historyId: '5005',
          history: [
            {
              id: '5005',
              messagesDeleted: [{ message: { id: 'invitation-m1', threadId: 'invitation' } }],
              labelsRemoved: [
                { message: { id: 'unrelated-m1', threadId: 'unrelated' }, labelIds: ['INBOX'] },
              ],
            },
          ],
        },
        threads: { healthy, invitation: { id: 'invitation', messages: [sentReply] } },
        missingThreads: status === 404 ? ['invitation', 'unrelated'] : ['unrelated'],
        ...(status === 503 ? { failedThreads: ['invitation'] } : {}),
      })
      const page = await searchMail(delta.api)
      expect(page.threads.map(({ id }) => id)).toEqual(['healthy'])
      expect(page.notFoundThreadIds).toEqual(status === 404 ? ['invitation'] : undefined)
      expect(page.unreadableThreadIds).toEqual(status === 503 ? ['invitation'] : undefined)
      expect(cache.readThreads(cacheKey({}))?.map(({ id }) => id)).toEqual(
        status === 503 ? ['healthy', 'invitation'] : ['healthy'],
      )
      expect(cache.readThreads(cacheKey(unread))?.map(({ id }) => id)).toEqual(
        status === 404 ? ['healthy'] : ['invitation', 'healthy'],
      )
      expect(cache.historyId(cacheKey({}))).toBe(status === 503 ? null : '5005')

      if (status === 503) {
        const retry = gmail({
          listPages: {
            '': { threads: [{ id: 'healthy' }], nextPageToken: 'next-page' },
            'next-page': { threads: [{ id: 'older' }] },
          },
          threads: { healthy, older: rawThread('older', 'Older mail') },
          missingThreads: ['invitation', 'unrelated'],
          profile: { historyId: '5006' },
        })
        const recovered = await searchMail(retry.api, { refresh: true })
        expect(recovered).toMatchObject({
          threads: [{ id: 'healthy' }],
          nextPageToken: 'next-page',
          notFoundThreadIds: ['invitation'],
        })
        expect(recovered).not.toHaveProperty('unreadableThreadIds')
        expect(cache.readThreads(cacheKey(unread))?.map(({ id }) => id)).toEqual(['healthy'])
        expect(cache.historyId(cacheKey({}))).toBe('5006')
        expect(await searchMail(retry.api, { pageToken: recovered.nextPageToken })).toMatchObject({
          threads: [{ id: 'older' }],
          nextPageToken: null,
        })
      }

      const unchanged = gmail({ history: { historyId: status === 503 ? '5006' : '5005' } })
      const next = await searchMail(unchanged.api)
      expect(next.threads.map(({ id }) => id)).toEqual(['healthy'])
      expect(next).not.toHaveProperty('notFoundThreadIds')
      expect(next).not.toHaveProperty('unreadableThreadIds')
    },
  )

  it.each(['404', 'surviving reply', '503', 'timeout'])(
    'checks a deletion from Load more without caching the continuation (%s)',
    async (verdict) => {
      const healthy = rawThread('healthy', 'Other mail')
      const id = 'invitation'
      const inviteMessage = message(
        'invite-message',
        id,
        [
          ['Subject', 'Meeting'],
          ['Content-Type', 'text/calendar; method=REQUEST'],
        ],
        ['INBOX'],
      )
      const calendarPart = {
        ...inviteMessage,
        payload: { ...inviteMessage.payload, mimeType: 'text/calendar' },
      }
      const sent = message('sent-reply', id, [['Subject', 'Re: Meeting']], ['SENT'])
      const sentReply = { ...sent, payload: { ...sent.payload, mimeType: 'text/plain' } }
      const messages = verdict === 'surviving reply' ? [calendarPart, sentReply] : [calendarPart]
      const metadata = { id, messages }
      const initial = gmail(
        {
          listPages: {
            '': { threads: [{ id: 'healthy' }], nextPageToken: 'next' },
            next: { threads: [{ id: 'invitation' }] },
          },
          threads: { healthy, invitation: metadata },
        },
        {},
        (url) => {
          if (url.pathname.endsWith(`/threads/${id}`) && url.searchParams.get('format') === 'full')
            return Promise.resolve(
              Response.json({
                id,
                messages: messages.map((m) => ({
                  ...m,
                  payload: { ...m.payload, body: { size: 0 } },
                })),
              }),
            )
        },
      )
      const first = await searchMail(initial.api)
      expect(first).toMatchObject({ threads: [{ id: 'healthy' }], nextPageToken: 'next' })
      const continuation = await searchMail(initial.api, { pageToken: first.nextPageToken })
      expect(continuation).toMatchObject({
        threads: [{ id: 'invitation', hasInvite: true }],
        nextPageToken: null,
      })
      const opened = await readThread(initial.api, continuation.threads[0]!.id)
      expect(opened.id).toBe(id)
      expect(opened.messages.find((item) => item.id === inviteMessage.id)?.hasCalendarPayload).toBe(
        true,
      )
      // An unchanged first-page delta must not contain the continuation row.
      expect((await searchMail(initial.api)).threads.map((row) => row.id)).toEqual(['healthy'])

      const deadlines = verdict === 'timeout' ? captureDeadlines() : undefined
      const delta = gmail(
        {
          list: [{ id: 'healthy' }],
          threads: { healthy, invitation: { id, messages: [sentReply] } },
          history: {
            historyId: '5005',
            history: [
              {
                id: '5005',
                messagesDeleted: [{ message: { id: inviteMessage.id, threadId: id } }],
              },
            ],
          },
          missingThreads: verdict === '404' ? [id] : [],
          failedThreads: verdict === '503' ? [id] : [],
        },
        {},
        (url, signal) => {
          if (
            !deadlines ||
            !url.pathname.endsWith(`/threads/${id}`) ||
            url.searchParams.get('format') !== 'metadata'
          )
            return
          const response = beforeHeaders(signal)
          deadlines.expire(signal)
          return response
        },
      )
      const page = await searchMail(delta.api).finally(() => deadlines?.restore())
      const failed = verdict === '503' || verdict === 'timeout'
      expect(page.threads.map((row) => row.id)).toEqual(['healthy'])
      expect(page.notFoundThreadIds).toEqual(verdict === '404' ? [id] : undefined)
      expect(page.unreadableThreadIds).toEqual(failed ? [id] : undefined)

      if (failed) {
        // The failed resource is still off-page on Retry, and not in the new history window.
        const retry = gmail({
          list: [{ id: 'healthy' }],
          threads: { healthy },
          missingThreads: [id],
          profile: { historyId: '5006' },
        })
        const recovered = await searchMail(retry.api, { refresh: true })
        expect(recovered).toMatchObject({ threads: [{ id: 'healthy' }], notFoundThreadIds: [id] })
        expect(recovered).not.toHaveProperty('unreadableThreadIds')
      }

      const unchanged = gmail({}, {}, (url) => {
        if (!url.pathname.endsWith('/history')) return
        const since = failed ? '5006' : '5005'
        return Promise.resolve(
          url.searchParams.get('startHistoryId') === since
            ? Response.json({ historyId: since })
            : Response.json({}, { status: 400 }),
        )
      })
      const next = await searchMail(unchanged.api)
      expect(next.threads.map((row) => row.id)).toEqual(['healthy'])
      expect(next).not.toHaveProperty('notFoundThreadIds')
      expect(next).not.toHaveProperty('unreadableThreadIds')
    },
  )

  it('does not move past a mailbox-wide batch deletion too large to verify', async () => {
    const healthy = rawThread('healthy', 'Kept')
    await searchMail(gmail({ list: [{ id: 'healthy' }], threads: { healthy } }).api)
    const deletion = {
      id: '5005',
      messagesDeleted: Array.from({ length: 1_000 }, (_, i) => ({
        message: { id: `message-${i}`, threadId: `thread-${i}` },
      })),
    }
    const { api } = gmail({ list: [{ id: 'healthy' }], threads: { healthy } }, {}, (url) => {
      if (!url.pathname.endsWith('/history')) return
      const history = url.searchParams.get('startHistoryId') === '5000' ? [deletion] : []
      return Promise.resolve(Response.json({ historyId: '5005', history }))
    })
    await expect(searchMail(api)).rejects.toThrow()
    await expect(searchMail(api)).rejects.toThrow()
  })

  it('does not deliver a late off-page 404 from a retired account to its replacement', async () => {
    let entered!: (event: 'probe') => void
    let release!: (response: Response) => void
    const started = new Promise<'probe'>((resolve) => (entered = resolve))
    const response = new Promise<Response>((resolve) => (release = resolve))
    const oldApi = gmail(
      {
        history: {
          historyId: '5005',
          history: [
            { id: '5005', messagesDeleted: [{ message: { id: 'm1', threadId: 'shared' } }] },
          ],
        },
      },
      {},
      (url) => {
        if (url.pathname.endsWith('/threads/shared')) {
          entered('probe')
          return response
        }
      },
    ).api
    await searchMail(gmail({}).api)
    const old = createGoogleData({ api: () => oldApi, cache })

    const replacementCache = openGoogleCache(join(dir, 'replacement.db'))
    const replacementApi = gmail({
      list: [{ id: 'shared' }],
      threads: { shared: rawThread('shared', 'Mail in the replacement account') },
    }).api
    const replacement = createGoogleData({ api: () => replacementApi, cache: replacementCache })
    const pending = old.threads({})
    try {
      expect(await Promise.race([started, pending])).toBe('probe')
      old.forget()
      expect((await replacement.threads({})).threads.map(({ id }) => id)).toEqual(['shared'])
      release(Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 }))
      await expect(pending).rejects.toThrow()
      const current = await replacement.threads({})
      expect(current.threads.map(({ subject }) => subject)).toEqual([
        'Mail in the replacement account',
      ])
      expect(current).not.toHaveProperty('notFoundThreadIds')
    } finally {
      release(Response.json({}, { status: 404 }))
      await pending.catch(() => {})
      replacementCache.close()
    }
  })

  it('evicts a changed thread after a metadata 404, including from another cached list', async () => {
    const list = [{ id: 'deleted' }, { id: 'healthy' }]
    const first = gmail({
      list,
      threads: {
        deleted: rawThread('deleted', 'Removed', ['INBOX', 'UNREAD']),
        healthy: rawThread('healthy', 'Still here', ['INBOX', 'UNREAD']),
      },
    })
    const unread = { unread: true }
    expect((await syncThreads(first.api, cache, unread)).threads.map(({ id }) => id)).toEqual([
      'deleted',
      'healthy',
    ])
    await syncThreads(first.api, cache)

    // The thread vanished after the history snapshot; there is no explicit
    // deletion in this delta, only a refetch of a changed conversation.
    const delta = gmail({
      history: {
        historyId: '6000',
        history: [{ messagesAdded: [{ message: { id: 'incoming', threadId: 'deleted' } }] }],
      },
      missingThreads: ['deleted'],
    })
    const updated = await syncThreads(delta.api, cache)
    expect(updated.threads.map(({ id }) => id)).toEqual(['healthy'])
    expect(updated.notFoundThreadIds).toEqual(['deleted'])
    expect(updated.nextPageToken).toBeNull()
    expect(updated).not.toHaveProperty('unreadableThreadIds')

    const unchanged = gmail({ history: { historyId: '6000' } })
    for (const options of [{}, unread]) {
      const page = await syncThreads(unchanged.api, cache, options)
      expect(page.threads.map(({ id }) => id)).toEqual(['healthy'])
      expect(page).not.toHaveProperty('notFoundThreadIds')
    }
    expect(unchanged.seen[0]).toContain('startHistoryId=6000')
  })

  it.each([404, 503])(
    'reports an overlapping continuation metadata %i without losing the page',
    async (status) => {
      const initialIds = [{ id: 'overlap' }, { id: 'retained' }]
      const first = gmail({
        listPages: { '': { threads: initialIds, nextPageToken: 'page-2' } },
        threads: {
          overlap: rawThread('overlap', 'Previously visible', ['INBOX', 'UNREAD']),
          retained: rawThread('retained', 'Still visible', ['INBOX', 'UNREAD']),
        },
      })
      const unread = { unread: true }
      const inbox = await syncThreads(first.api, cache)
      for (const page of [inbox, await syncThreads(first.api, cache, unread)]) {
        expect(page.threads.map(({ id }) => id)).toEqual(['overlap', 'retained'])
      }
      const next = gmail({
        listPages: {
          'page-2': { threads: [{ id: 'overlap' }, { id: 'new' }], nextPageToken: 'page-3' },
        },
        threads: { new: rawThread('new', 'Next page row') },
        ...(status === 404 ? { missingThreads: ['overlap'] } : { failedThreads: ['overlap'] }),
      })
      const page = await syncThreads(next.api, cache, { pageToken: inbox.nextPageToken! })

      expect(page.threads.map(({ id }) => id)).toEqual(['new'])
      expect(page.nextPageToken).toBe('page-3')
      expect(page.notFoundThreadIds).toEqual(status === 404 ? ['overlap'] : undefined)
      expect(page.unreadableThreadIds).toEqual(status === 503 ? ['overlap'] : undefined)

      // No history change has announced the disappearance. A definitive metadata
      // 404 must still evict the summary from every cached list for this account.
      const unchanged = gmail({ history: { historyId: '6000' } })
      if (status === 404) {
        expect((await syncThreads(unchanged.api, cache)).threads.map(({ id }) => id)).toEqual([
          'retained',
        ])
      }
      expect((await syncThreads(unchanged.api, cache, unread)).threads.map(({ id }) => id)).toEqual(
        status === 404 ? ['retained'] : ['overlap', 'retained'],
      )
    },
  )

  it('reports a failed deleted-message confirmation as pending until a fresh read', async () => {
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'Draft') } })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      list: [{ id: 't1' }],
      history: {
        historyId: '6000',
        history: [{ messagesDeleted: [{ message: { id: 'draft', threadId: 't1' } }] }],
      },
      failedThreads: ['t1'],
    })

    const partial = await syncThreads(second.api, cache)
    expect(partial).toMatchObject({ threads: [], unreadableThreadIds: ['t1'] })
    expect(partial).not.toHaveProperty('notFoundThreadIds')
    expect(cache.readThreads(cacheKey({}))?.map(({ id }) => id)).toEqual(['t1'])
    const fresh = gmail({
      list: [{ id: 't1' }],
      threads: { t1: rawThread('t1', 'Remaining message') },
      profile: { historyId: '6001' },
    })
    const recovered = await syncThreads(fresh.api, cache)
    expect(recovered.threads.map(({ subject }) => subject)).toEqual(['Remaining message'])
    expect(recovered).not.toHaveProperty('unreadableThreadIds')
  })

  it.each(['headers', 'body'] as const)(
    'isolates a metadata endpoint timeout at %s and restores the row on read-only retry',
    async (stage) => {
      const deadlines = captureDeadlines()
      try {
        let stalled = false
        const { api } = gmail(
          {
            listPages: {
              '': { threads: [{ id: 'slow' }, { id: 'healthy' }], nextPageToken: 'page-2' },
            },
            threads: { slow: rawThread('slow', 'Slow'), healthy: rawThread('healthy', 'Healthy') },
          },
          {},
          (url, signal) => {
            if (!stalled || !url.pathname.endsWith('/threads/slow')) return
            if (stage === 'headers') {
              const response = beforeHeaders(signal)
              deadlines.expire(signal)
              return response
            }
            const body = new ReadableStream(
              {
                start(stream) {
                  signal.addEventListener(
                    'abort',
                    () => stream.error(new DOMException('Body read aborted', 'AbortError')),
                    { once: true },
                  )
                },
                pull() {
                  deadlines.expire(signal)
                },
              },
              { highWaterMark: 0 },
            )
            return Promise.resolve(new Response(body, { status: 200 }))
          },
        )
        expect((await syncThreads(api, cache)).threads.map(({ id }) => id)).toEqual([
          'slow',
          'healthy',
        ])
        stalled = true
        const partial = await syncThreads(api, cache, {}, undefined, { refresh: true })
        expect(partial.threads.map(({ id }) => id)).toEqual(['healthy'])
        expect(partial.nextPageToken).toBe('page-2')
        expect(partial.unreadableThreadIds).toEqual(['slow'])
        expect(partial).not.toHaveProperty('notFoundThreadIds')
        expect(cache.readThreads(cacheKey({}))?.map(({ id }) => id)).toContain('slow')

        stalled = false
        const recovered = await syncThreads(api, cache, {}, undefined, { refresh: true })
        expect(recovered.threads.map(({ id }) => id)).toEqual(['slow', 'healthy'])
        expect(recovered.nextPageToken).toBe('page-2')
        expect(recovered).not.toHaveProperty('unreadableThreadIds')
        expect(recovered).not.toHaveProperty('notFoundThreadIds')
      } finally {
        deadlines.restore()
      }
    },
  )

  it('rejects the page when OAuth token acquisition times out after the list request', async () => {
    let listed = false
    const { api } = gmail(
      { list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'One') } },
      {
        accessToken: async () => {
          if (listed) throw new DOMException('OAuth refresh timed out', 'TimeoutError')
          return 'at'
        },
      },
      (url) => {
        if (url.pathname.endsWith('/threads')) listed = true
        return undefined
      },
    )
    await expect(syncThreads(api, cache)).rejects.toMatchObject({ code: 'reconnect' })
  })

  it('rejects the page when the caller aborts a metadata fetch', async () => {
    const caller = new AbortController()
    const cancelled = new DOMException('The caller ended the read', 'AbortError')
    const { api } = gmail(
      {
        list: [{ id: 'aborted' }, { id: 'healthy' }],
        threads: { healthy: rawThread('healthy', 'Healthy') },
      },
      {},
      (url, deadline) => {
        if (!url.pathname.endsWith('/threads/aborted')) return
        const response = beforeHeaders(AbortSignal.any([caller.signal, deadline]))
        caller.abort(cancelled)
        return response
      },
    )
    await expect(syncThreads(api, cache)).rejects.toBe(cancelled)
  })

  it.each(['binding', 'shared scan'] as const)(
    'keeps %s failures global when a resource deadline expires',
    async (failure) => {
      const deadlines = captureDeadlines()
      try {
        const stopped = new Error('The account binding changed')
        let active = true
        const { api } = gmail(
          { list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'One') } },
          {
            assertRequest: () => {
              if (!active) throw stopped
            },
          },
          (url, signal) => {
            const applies =
              failure === 'binding'
                ? url.pathname.endsWith('/threads/t1')
                : url.searchParams.get('q')?.includes('filename:ics')
            if (!applies) return
            const response = beforeHeaders(signal)
            if (failure === 'binding') active = false
            deadlines.expire(signal)
            return response
          },
        )
        const page = syncThreads(api, cache)
        if (failure === 'binding') await expect(page).rejects.toBe(stopped)
        else await expect(page).rejects.toMatchObject({ cause: { name: 'TimeoutError' } })
      } finally {
        deadlines.restore()
      }
    },
  )

  it.each([
    [401, 'reconnect', 'authError'],
    [403, 'scope', 'insufficientPermissions'],
    [403, 'rate-limit', 'userRateLimitExceeded'],
    [429, 'rate-limit', 'rateLimitExceeded'],
  ])('rejects the whole page for a metadata HTTP %i (%s)', async (status, code, reason) => {
    const { api } = gmail(
      {
        list: [{ id: 'refused' }, { id: 'healthy' }],
        threads: { healthy: rawThread('healthy', 'Healthy') },
      },
      {},
      (url) => {
        if (!url.pathname.endsWith('/threads/refused')) return
        return Promise.resolve(Response.json({ error: { errors: [{ reason }] } }, { status }))
      },
    )
    await expect(syncThreads(api, cache)).rejects.toMatchObject({ status, code })
  })

  it('refreshes an explicit query instead of using mailbox history', async () => {
    const first = gmail({ list: [{ id: 't1' }], threads: { t1: rawThread('t1', 'Inbox thing') } })
    await syncThreads(first.api, cache, {})

    const second = gmail({
      list: [{ id: 't9' }],
      threads: { t9: rawThread('t9', 'Search hit') },
    })
    const page = await syncThreads(second.api, cache, { query: 'from:jane' })

    // Explicit searches are fetched from Gmail rather than inferred from mailbox history.
    expect(page.threads.map((t) => t.subject)).toEqual(['Search hit'])
    expect(second.seen.some((url) => new URL(url).pathname.endsWith('/history'))).toBe(false)
  })

  it('asks for changes since the list was cached, not since some other list was', async () => {
    // The inbox is cached at cursor 100…
    const inbox = gmail({
      list: [{ id: 't1' }],
      threads: { t1: rawThread('t1', 'One') },
      profile: { historyId: '100' },
    })
    await syncThreads(inbox.api, cache, {})

    // …then a Sent list is refreshed, and the mailbox has moved on to 200.
    const sent = gmail({
      list: [{ id: 't9' }],
      threads: { t9: rawThread('t9', 'Hit', ['SENT']) },
      profile: { historyId: '200' },
    })
    await syncThreads(sent.api, cache, { mailbox: 'sent' })

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
        gmail({ history: archivedInHistory('t2'), threads: { t2: rawThread('t2', 'Two', []) } })
          .api,
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
        gmail({ history: archivedInHistory('t2'), threads: { t2: rawThread('t2', 'Two', []) } })
          .api,
        cache,
        {},
      )

      expect(page.threads.map((t) => t.id)).toEqual(['t1'])
    })

    it('keeps an inbox thread when only one message loses INBOX', async () => {
      await cachedInbox()
      const thread = rawThread('t2', 'Two')
      thread.messages.push(message('t2-reply', 't2', [], ['SENT']))

      const second = gmail({
        list: [{ id: 't2' }],
        history: archivedInHistory('t2'),
        threads: { t2: thread },
      })
      const page = await syncThreads(second.api, cache, {})

      expect(page.threads.map((item) => item.id)).toContain('t2')
      expect(threadGets(second.seen)).toHaveLength(1)
    })

    it('keeps an inbox thread when a SENT-only reply is trashed', async () => {
      await cachedInbox()
      const thread = rawThread('t2', 'Two')
      thread.messages.push(message('t2-reply', 't2', [], ['SENT']))

      const second = gmail({
        list: [{ id: 't2' }],
        history: {
          historyId: '6003',
          history: [
            { labelsAdded: [{ message: { id: 't2-reply', threadId: 't2' }, labelIds: ['TRASH'] }] },
          ],
        },
        threads: { t2: thread },
      })
      const page = await syncThreads(second.api, cache, {})

      expect(page.threads.map((item) => item.id)).toContain('t2')
      expect(threadGets(second.seen)).toHaveLength(1)
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
        list: [{ id: 't1' }, { id: 't2' }],
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

    it('keeps an archived thread in Sent', async () => {
      const first = gmail({
        list: [{ id: 't2' }],
        threads: { t2: rawThread('t2', 'Two', ['INBOX', 'SENT']) },
      })
      await syncThreads(first.api, cache, { mailbox: 'sent' })

      const second = gmail({
        list: [{ id: 't2' }],
        history: archivedInHistory('t2'),
        threads: { t2: rawThread('t2', 'Two (archived)', ['SENT']) },
      })
      const page = await syncThreads(second.api, cache, { mailbox: 'sent' })

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
      expect(new URL(history).searchParams.has('labelId')).toBe(false)
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
