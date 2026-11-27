import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GoogleApi, GoogleApiError } from '../main/api'
import { openGoogleCache, type GoogleCache } from '../main/cache'
import {
  fetchThreadSummaries,
  type ListThreadsOptions,
  type MailPage,
  type MailThreadSummary,
} from '../main/gmail'
import type { MailListRequest } from '../main/mail-list-types'
import { syncThreads } from '../main/mail-sync'

let dir: string
let cache: GoogleCache
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-loaded-mail-'))
  cache = openGoogleCache(join(dir, 'cache.db'))
  cache.ensureShape()
})
afterEach(async () => {
  cache.close()
  await rm(dir, { recursive: true, force: true })
})

const INBOX = ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL']
function rawThread(id: string, labels: string[][] = [INBOX]) {
  return {
    id,
    messages: labels.map((labelIds, index) => ({
      id: `${id}-m${index}`,
      threadId: id,
      internalDate: String(1700000000000 + index),
      labelIds,
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: `Subject ${id}` },
          { name: 'From', value: 'Jane <jane@example.com>' },
          { name: 'Date', value: 'Tue, 14 Nov 2023 22:13:20 +0000' },
          { name: 'Content-Type', value: 'text/plain' },
        ],
      },
    })),
  }
}

/** Wire-level adapter: list pages contain IDs only, metadata has message labels,
 * history is mailbox-wide, expired cursors and missing metadata are HTTP 404s.
 * Unexpected requests fail rather than quietly returning an empty mailbox. */
function gmail(query = 'in:inbox') {
  const calls: URL[] = []
  const pages = new Map<string, { ids: string[]; next?: string }>()
  const threads = new Map<string, ReturnType<typeof rawThread>>()
  const state = {
    historyId: '100',
    changed: [] as string[],
    expired: false,
    failure: null as string | null,
    // Model a change that lands after profile capture but during threads.list.
    onList: undefined as (() => void) | undefined,
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push(url)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token')
    const endpoint = url.pathname.replace('/gmail/v1/users/me/', '')
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    if (endpoint === 'profile') return json({ historyId: state.historyId })
    if (endpoint === 'history') {
      expect(url.searchParams.get('startHistoryId')).toMatch(/^\d+$/)
      expect(url.searchParams.has('labelId')).toBe(false)
      if (state.expired) return json({ error: { message: 'expired' } }, 404)
      return json({
        historyId: state.historyId,
        history: [{ messages: state.changed.map((id) => ({ id: `${id}-m0`, threadId: id })) }],
      })
    }
    if (endpoint === 'labels') {
      if (state.failure === 'labels') return json({ error: { message: 'unavailable' } }, 503)
      return json({ labels: [] })
    }
    if (endpoint === 'threads') {
      const q = url.searchParams.get('q')!
      if (/^has:attachment filename:ics after:\d+ before:\d+$/.test(q)) {
        // Fixtures are plain text with no attachments. This bounded badge
        // lookup is distinct from scanning the active mailbox for membership.
        return json({ threads: [] })
      }
      expect(q).toBe(query)
      const token = url.searchParams.get('pageToken') ?? ''
      const page = pages.get(token)
      if (page === undefined) throw new Error(`unexpected mailbox page: ${token}`)
      state.onList?.()
      return json({ threads: page.ids.map((id) => ({ id })), nextPageToken: page.next })
    }
    if (endpoint.startsWith('threads/')) {
      const id = endpoint.slice('threads/'.length)
      expect(url.searchParams.get('format')).toBe('metadata')
      expect(url.searchParams.getAll('metadataHeaders')).toContain('Subject')
      if (state.failure === id) return json({ error: { message: 'unavailable' } }, 503)
      const thread = threads.get(id)
      return thread === undefined ? json({ error: { message: 'gone' } }, 404) : json(thread)
    }
    throw new Error(`unexpected Gmail request: ${url}`)
  }
  return {
    api: new GoogleApi({ accessToken: async () => 'test-token', fetch }),
    calls,
    pages,
    threads,
    state,
    gets: () =>
      calls
        .filter((url) => /\/threads\//.test(url.pathname))
        .map((url) => url.pathname.split('/').pop()!),
    lists: () =>
      calls.filter(
        (url) => url.pathname.endsWith('/threads') && url.searchParams.get('q') === query,
      ),
  }
}

function sync(
  server: ReturnType<typeof gmail>,
  request: MailListRequest,
  options: ListThreadsOptions = {},
) {
  return syncThreads(server.api, cache, options, undefined, {
    uiList: { owner: 'owner/repo:account-a', request },
  })
}

/** Apply only the public response protocol: absence from a refresh is not removal. */
function apply(loaded: Map<string, MailThreadSummary>, page: MailPage) {
  for (const id of page.uiList!.removedIds) loaded.delete(id)
  for (const thread of page.threads) loaded.set(thread.id, thread)
}

async function loadPages(server: ReturnType<typeof gmail>, options: ListThreadsOptions = {}) {
  const loaded = new Map<string, MailThreadSummary>()
  let page = await sync(server, { loadedIds: [] }, options)
  apply(loaded, page)
  while (page.nextPageToken !== null) {
    page = await sync(
      server,
      { loadedIds: [...loaded.keys()], cursor: page.uiList!.cursor },
      {
        ...options,
        pageToken: page.nextPageToken,
      },
    )
    apply(loaded, page)
  }
  return { loaded, cursor: page.uiList!.cursor }
}

describe('loaded mail list synchronization with SQLite', () => {
  it('does not report a label failure until outstanding thread reads have drained', async () => {
    let release!: () => void
    const metadataGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const api = new GoogleApi({
      accessToken: async () => 'test-token',
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/labels')) {
          return new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
            status: 503,
          })
        }
        if (url.pathname.includes('/threads/')) {
          await metadataGate
          return Response.json(rawThread(url.pathname.split('/').pop()!))
        }
        throw new Error(`unexpected Gmail request: ${url}`)
      },
    })
    let settled = false
    const outcome = fetchThreadSummaries(api, ['a', 'b', 'c', 'd', 'e', 'f'], undefined, {}).then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    try {
      // Let the immediate label failure propagate while metadata stays held.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
    } finally {
      release()
      await outcome
    }
    expect(await outcome).toBeInstanceOf(GoogleApiError)
    expect(await outcome).toMatchObject({ status: 503 })
  })

  it('reconciles later-page archive, read and category changes without hydrating unchanged rows or scanning the mailbox', async () => {
    const options = { unread: true, category: 'primary' as const }
    const server = gmail('in:inbox category:primary is:unread')
    const later = ['archived', 'read', 'moved', 'split', 'surviving']
    server.pages.set('', { ids: ['head'], next: 'later' })
    server.pages.set('later', { ids: later })
    for (const id of ['head', ...later]) server.threads.set(id, rawThread(id))
    const { loaded, cursor } = await loadPages(server, options)
    server.threads.set('archived', rawThread('archived', [['UNREAD', 'CATEGORY_PERSONAL']]))
    server.threads.set('read', rawThread('read', [['INBOX', 'CATEGORY_PERSONAL']]))
    server.threads.set('moved', rawThread('moved', [['INBOX', 'UNREAD', 'CATEGORY_UPDATES']]))
    // Unioning summary flags would incorrectly admit this conversation: no
    // single live message matches the conjunction, and trash cannot lend UNREAD.
    server.threads.set(
      'split',
      rawThread('split', [
        ['INBOX', 'CATEGORY_PERSONAL'],
        ['TRASH', 'UNREAD', 'CATEGORY_PERSONAL'],
      ]),
    )
    server.threads.set('surviving', rawThread('surviving', [['CATEGORY_PERSONAL'], INBOX]))
    server.state.changed = [...later, 'not-loaded']
    server.state.historyId = '200'
    server.calls.length = 0
    const refreshed = await sync(
      server,
      { loadedIds: [...loaded.keys()], cursor, refresh: true },
      options,
    )
    expect(refreshed.uiList).toMatchObject({
      mode: 'delta',
      removedIds: ['archived', 'read', 'moved', 'split'],
    })
    expect(new Set(refreshed.uiList!.revalidatedIds)).toEqual(new Set(later))
    apply(loaded, refreshed)
    expect([...loaded.keys()]).toEqual(['head', 'surviving'])
    expect(server.gets().sort()).toEqual([...later].sort())
    expect(server.lists()).toHaveLength(1)
    expect(refreshed.nextPageToken).toBe('later')

    server.state.changed = []
    server.calls.length = 0
    const unchanged = await sync(
      server,
      { loadedIds: [...loaded.keys()], cursor: refreshed.uiList!.cursor, refresh: true },
      options,
    )
    expect(unchanged.threads).toEqual([])
    expect(unchanged.uiList!.removedIds).toEqual([])
    expect(server.gets()).toEqual([])
    expect(server.lists()).toHaveLength(1)
  })

  it('keeps a displaced Starred row on arrival, then removes an actual external unstar and replays changes during the initial list', async () => {
    const server = gmail('is:starred')
    const options = { query: 'is:starred', limit: 1 }
    server.pages.set('', { ids: ['old'] })
    server.threads.set('old', rawThread('old', [['STARRED']]))
    server.state.onList = () => {
      server.state.historyId = '101'
    }
    const { loaded, cursor } = await loadPages(server, options)
    expect(cursor.historyId).toBe('100')
    server.state.onList = undefined
    server.pages.set('', { ids: ['new'], next: 'older' })
    server.threads.set('new', rawThread('new', [['STARRED']]))
    server.state.changed = ['new']
    server.calls.length = 0
    const arrival = await sync(
      server,
      { loadedIds: [...loaded.keys()], cursor, refresh: true },
      options,
    )
    apply(loaded, arrival)
    expect([...loaded.keys()]).toEqual(['old', 'new'])
    expect(arrival.uiList!.removedIds).toEqual([])
    expect(server.gets()).toEqual(['new'])
    expect(
      server.calls
        .find((url) => url.pathname.endsWith('/history'))!
        .searchParams.get('startHistoryId'),
    ).toBe('100')
    server.threads.set('old', rawThread('old', [['INBOX']]))
    server.state.changed = ['old']
    server.calls.length = 0
    const unstar = await sync(
      server,
      { loadedIds: [...loaded.keys()], cursor: arrival.uiList!.cursor, refresh: true },
      options,
    )
    apply(loaded, unstar)
    expect([...loaded.keys()]).toEqual(['new'])
    expect(unstar.uiList!.removedIds).toEqual(['old'])
    expect(server.gets()).toEqual(['old'])
    expect(server.lists()).toHaveLength(1)
  })

  it.each(['expired', 'missing'] as const)(
    'recovers %s history across more than 500 genuinely loaded rows while keeping disk bounded',
    async (recovery) => {
      const server = gmail()
      const ids = Array.from({ length: 525 }, (_, i) => `t${i}`)
      for (const id of ids) server.threads.set(id, rawThread(id))
      for (let start = 0; start < ids.length; start += 175) {
        server.pages.set(start === 0 ? '' : String(start), {
          ids: ids.slice(start, start + 175),
          next: start + 175 < ids.length ? String(start + 175) : undefined,
        })
      }
      const { loaded, cursor } = await loadPages(server, { limit: 175 })
      expect(loaded.size).toBe(525)
      const diskKey = `ui:${cursor.key}`
      expect(cache.readThreads(diskKey)).toHaveLength(500)
      const evicted = ids.find(
        (id) => !cache.readThreads(diskKey)!.some((thread) => thread.id === id),
      )!
      server.threads.delete(evicted)
      server.state.expired = recovery === 'expired'
      server.calls.length = 0
      const recovered = await sync(
        server,
        {
          loadedIds: [...loaded.keys()],
          cursor: recovery === 'missing' ? undefined : cursor,
          refresh: true,
        },
        { limit: 175 },
      )
      expect(recovered.uiList!.mode).toBe('coverage')
      expect(new Set(recovered.uiList!.revalidatedIds)).toEqual(new Set(ids))
      expect(recovered.uiList!.removedIds).toEqual([evicted])
      expect(recovered.threads).toHaveLength(524)
      apply(loaded, recovered)
      expect(loaded.size).toBe(524)
      expect(loaded.has(evicted)).toBe(false)
      expect(server.gets().sort()).toEqual([...ids].sort())
      expect(server.lists()).toHaveLength(1)
      expect(cache.readThreads(diskKey)).toHaveLength(500)
    },
  )

  it('skips duplicate-only continuation pages before hydration and reports exhaustion only at the real end without advancing history', async () => {
    const server = gmail()
    for (const id of ['a', 'b', 'c']) server.threads.set(id, rawThread(id))
    server.pages.set('', { ids: ['a', 'b'], next: 'shifted' })
    const first = await sync(server, { loadedIds: [] })
    const cursor = first.uiList!.cursor
    server.pages.set('shifted', { ids: ['a', 'b'], next: 'unseen' })
    server.pages.set('unseen', { ids: ['b', 'c'], next: 'tail' })
    server.pages.set('tail', { ids: ['c'], next: 'end' })
    server.pages.set('end', { ids: [] })
    server.state.historyId = '999'
    server.calls.length = 0
    const next = await sync(server, { loadedIds: ['a', 'b'], cursor }, { pageToken: 'shifted' })
    expect(next.threads.map((thread) => thread.id)).toEqual(['c'])
    expect(next.nextPageToken).toBe('tail')
    expect(next.uiList!.cursor).toEqual(cursor)
    expect(server.gets()).toEqual(['c'])
    expect(server.lists()).toHaveLength(2)
    server.calls.length = 0
    const end = await sync(server, { loadedIds: ['a', 'b', 'c'], cursor }, { pageToken: 'tail' })
    expect(end.threads).toEqual([])
    expect(end.nextPageToken).toBeNull()
    expect(end.uiList!.cursor).toEqual(cursor)
    expect(server.gets()).toEqual([])
    expect(server.lists()).toHaveLength(2)
    expect(server.calls.some((url) => /\/(profile|history)$/.test(url.pathname))).toBe(false)
  })

  it.each(['changed', 'labels'])(
    'rejects a partial %s failure without publishing or caching partial success',
    async (failure) => {
      const server = gmail()
      server.pages.set('', { ids: ['changed', 'gone'] })
      for (const id of ['changed', 'gone']) server.threads.set(id, rawThread(id))
      const { loaded, cursor } = await loadPages(server)
      const diskKey = `ui:${cursor.key}`
      const before = cache.readThreads(diskKey)
      server.pages.set('', { ids: ['arrival'], next: 'older' })
      server.threads.set('arrival', rawThread('arrival'))
      server.threads.delete('gone')
      server.state.changed = ['changed', 'gone']
      server.state.historyId = '200'
      server.state.failure = failure
      const request = { loadedIds: [...loaded.keys()], cursor, refresh: true }
      await expect(sync(server, request)).rejects.toMatchObject({ status: 503 })
      expect(cache.readThreads(diskKey)).toEqual(before)
      expect(cursor.historyId).toBe('100')
      server.state.failure = null
      const retry = await sync(server, request)
      expect(retry.uiList).toMatchObject({
        mode: 'delta',
        removedIds: ['gone'],
        cursor: { historyId: '200' },
      })
      expect(new Set(retry.threads.map((thread) => thread.id))).toEqual(
        new Set(['arrival', 'changed']),
      )
      apply(loaded, retry)
      expect(new Set(loaded.keys())).toEqual(new Set(['arrival', 'changed']))
    },
  )
})
