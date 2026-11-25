import { describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../main/api'
import { createMailAttention, type MailAttentionSession } from '../main/mail-attention'
import type { MailAttentionSnapshot } from '../shared/types'

interface Session extends MailAttentionSession {
  id: string
}

interface HistoryPage {
  status?: number
  historyId?: string
  history?: unknown[]
  nextPageToken?: string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function gmail() {
  let unread = 0
  let historyId = '10'
  let countStatus = 200
  let historyPages: Record<string, HistoryPage> = { '': { historyId } }
  let messages: Record<string, string[]> = {}
  const messageStatuses = new Map<string, number>()
  const messageGates = new Map<string, ReturnType<typeof deferred<void>>>()
  const messageStarted = new Map<string, ReturnType<typeof deferred<void>>>()
  let historyGate: ReturnType<typeof deferred<void>> | null = null
  let historyStarted: ReturnType<typeof deferred<void>> | null = null
  const seen: string[] = []

  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const parsed = new URL(url)
    const path = parsed.pathname
    const ok = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    if (path.endsWith('/labels/INBOX')) {
      return countStatus === 200
        ? ok({ threadsUnread: unread, threadsTotal: unread + 20 })
        : ok({}, countStatus)
    }
    if (path.endsWith('/profile')) {
      historyStarted?.resolve()
      await historyGate?.promise
      return ok({ historyId })
    }
    if (path.endsWith('/history')) {
      historyStarted?.resolve()
      await historyGate?.promise
      const token = parsed.searchParams.get('pageToken') ?? ''
      const page = historyPages[token] ?? { historyId }
      return ok(page, page.status ?? 200)
    }
    const id = path.split('/').pop()!
    messageStarted.get(id)?.resolve()
    await messageGates.get(id)?.promise
    return ok({ id, labelIds: messages[id] ?? [] }, messageStatuses.get(id) ?? 200)
  }) as unknown as typeof globalThis.fetch

  return {
    api: new GoogleApi({ accessToken: async () => 'token', fetch }),
    seen,
    setUnread(value: number) {
      unread = value
    },
    setCountStatus(status: number) {
      countStatus = status
    },
    setHistory(next: { profile?: string; pages: Record<string, HistoryPage> }) {
      historyPages = next.pages
      if (next.profile !== undefined) historyId = next.profile
    },
    setMessages(next: Record<string, string[]>) {
      messages = next
    },
    setMessageStatus(id: string, status: number) {
      messageStatuses.set(id, status)
    },
    holdMessage(id: string) {
      const gate = deferred<void>()
      const started = deferred<void>()
      messageGates.set(id, gate)
      messageStarted.set(id, started)
      return {
        started: started.promise,
        release: () => {
          gate.resolve()
          messageGates.delete(id)
          messageStarted.delete(id)
        },
      }
    },
    holdHistory() {
      historyGate = deferred<void>()
      historyStarted = deferred<void>()
      return {
        started: historyStarted.promise,
        release: () => {
          historyGate?.resolve()
          historyGate = null
          historyStarted = null
        },
      }
    },
  }
}

function rig() {
  const sessions = new Map<string, Session | null>()
  const servers = new Map<Session, ReturnType<typeof gmail>>()
  const notices = new Map<string, { title: string; body: string; navigate?: unknown }[]>()
  const snapshots = new Map<string, MailAttentionSnapshot[]>()
  const preferences = new Map<string, boolean>()
  const attention = createMailAttention<Session>({
    sessionFor: async (remote) => sessions.get(remote) ?? null,
    apiFor: (session) => servers.get(session)!.api,
    schedule: () => () => {},
    now: () => new Date('2026-11-25T08:00:00.000Z'),
    log: () => {},
  })
  const connect = (remote: string, session: Session, server: ReturnType<typeof gmail>) => {
    sessions.set(remote, session)
    servers.set(session, server)
  }
  const subscribe = async (remote: string) => {
    notices.set(remote, [])
    snapshots.set(remote, [])
    preferences.set(remote, false)
    return attention.subscribe({
      remote,
      notifications: async () => preferences.get(remote) === true,
      changed: (snapshot) => snapshots.get(remote)!.push(snapshot),
      notify: (notice) => {
        notices.get(remote)!.push(notice)
        return true
      },
    })
  }
  return { attention, sessions, notices, snapshots, preferences, connect, subscribe }
}

describe('mail attention', () => {
  it('returns an unknown subscription while the initial poll remains teardown-owned', async () => {
    const r = rig()
    const server = gmail()
    const session = { id: 'one', accountSub: 'sub-one' }
    r.connect('vault/a', session, server)
    const gate = server.holdHistory()

    const lease = await r.subscribe('vault/a')
    await gate.started

    expect(lease.snapshot()).toMatchObject({
      accountSub: 'sub-one',
      unreadThreads: null,
      status: 'unknown',
    })
    expect(r.snapshots.get('vault/a')).toEqual([
      expect.objectContaining({ accountSub: 'sub-one', status: 'unknown' }),
    ])

    let stopped = false
    const stopping = lease.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    gate.release()
    await stopping
    expect(stopped).toBe(true)
  })

  it('baselines the exact unread thread count without notifying old mail', async () => {
    const r = rig()
    const server = gmail()
    const session = { id: 'one', accountSub: 'sub-one' }
    server.setUnread(7)
    server.setHistory({
      pages: {
        '': {
          historyId: '10',
          history: [{ messagesAdded: [{ message: { id: 'backlog' } }] }],
        },
      },
    })
    r.connect('vault/b', session, server)
    r.preferences.set('vault/b', true)

    const lease = await r.subscribe('vault/b')
    await r.attention.refresh()

    expect(lease.snapshot()).toMatchObject({
      accountSub: 'sub-one',
      unreadThreads: 7,
      status: 'fresh',
    })
    expect(r.notices.get('vault/b')).toEqual([])
    expect(server.seen.some((url) => new URL(url).pathname.endsWith('/profile'))).toBe(true)
    await lease.stop()
  })

  it('notifies one aggregate for delivered unread mail including a reply', async () => {
    const r = rig()
    const server = gmail()
    const session = { id: 'one', accountSub: 'sub-one' }
    r.connect('vault/a', session, server)
    const lease = await r.subscribe('vault/a')
    await r.attention.refresh()
    r.preferences.set('vault/a', true)
    server.setUnread(2)
    server.setMessages({
      new: ['INBOX', 'UNREAD'],
      reply: ['INBOX', 'UNREAD'],
      read: ['INBOX'],
    })
    server.setHistory({
      pages: {
        '': {
          historyId: '11',
          history: [
            {
              id: 'h1',
              messagesAdded: [
                { message: { id: 'new', threadId: 'new-thread' } },
                { message: { id: 'reply', threadId: 'existing-thread' } },
                { message: { id: 'new', threadId: 'new-thread' } },
                { message: { id: 'read', threadId: 'read-thread' } },
              ],
              labelsAdded: [{ message: { id: 'old' }, labelIds: ['UNREAD', 'INBOX'] }],
            },
            { id: 'h1', messagesAdded: [{ message: { id: 'new' } }] },
          ],
        },
      },
    })

    await r.attention.refresh()

    expect(lease.snapshot()).toMatchObject({ unreadThreads: 2, status: 'fresh' })
    expect(r.notices.get('vault/a')).toEqual([
      {
        title: 'New mail',
        body: '2 unread messages arrived.',
        navigate: { name: 'open-mail', payload: { mailbox: 'inbox' } },
      },
    ])

    server.setHistory({
      pages: {
        '': {
          historyId: '12',
          history: [
            { labelsAdded: [{ message: { id: 'restored' }, labelIds: ['INBOX'] }] },
            { labelsAdded: [{ message: { id: 'old' }, labelIds: ['UNREAD'] }] },
          ],
        },
      },
    })
    await r.attention.refresh()
    expect(r.notices.get('vault/a')).toHaveLength(1)
    await lease.stop()
  })

  it('keeps stale counts and silently recovers expired or overflowing history', async () => {
    const r = rig()
    const server = gmail()
    const session = { id: 'one', accountSub: 'sub-one' }
    server.setUnread(4)
    r.connect('vault/a', session, server)
    const lease = await r.subscribe('vault/a')
    await r.attention.refresh()
    r.preferences.set('vault/a', true)

    server.setCountStatus(503)
    server.setHistory({ pages: { '': { status: 503 } } })
    await r.attention.refresh()
    expect(lease.snapshot()).toMatchObject({ unreadThreads: 4, status: 'stale' })

    server.setCountStatus(200)
    server.setUnread(6)
    server.setHistory({
      profile: '20',
      pages: {
        '': {
          status: 404,
          history: [{ messagesAdded: [{ message: { id: 'expired-backlog' } }] }],
        },
      },
    })
    await r.attention.refresh()
    expect(lease.snapshot()).toMatchObject({ unreadThreads: 6, status: 'fresh' })
    expect(r.notices.get('vault/a')).toEqual([])

    const pages: Record<string, HistoryPage> = {}
    for (let page = 0; page < 5; page += 1) {
      pages[page === 0 ? '' : `p${page}`] = {
        historyId: String(21 + page),
        history: [{ messagesAdded: [{ message: { id: `overflow-${page}` } }] }],
        nextPageToken: `p${page + 1}`,
      }
    }
    server.setHistory({ profile: '30', pages })
    await r.attention.refresh()
    expect(r.notices.get('vault/a')).toEqual([])
    await lease.stop()
  })

  it('shares one account poll and chooses one deterministic opted-in vault', async () => {
    const r = rig()
    const shared = gmail()
    const other = gmail()
    const sharedSession = { id: 'shared', accountSub: 'sub-shared' }
    const otherSession = { id: 'other', accountSub: 'sub-other' }
    r.connect('vault/b', sharedSession, shared)
    r.connect('vault/a', sharedSession, shared)
    r.connect('vault/c', otherSession, other)
    const [b, a, c] = await Promise.all([
      r.subscribe('vault/b'),
      r.subscribe('vault/a'),
      r.subscribe('vault/c'),
    ])
    await r.attention.refresh()
    r.preferences.set('vault/a', true)
    r.preferences.set('vault/b', true)
    r.preferences.set('vault/c', true)
    shared.setMessages({ shared: ['INBOX', 'UNREAD'] })
    shared.setHistory({
      pages: {
        '': { historyId: '11', history: [{ messagesAdded: [{ message: { id: 'shared' } }] }] },
      },
    })
    other.setMessages({ other: ['INBOX', 'UNREAD'] })
    other.setHistory({
      pages: {
        '': { historyId: '11', history: [{ messagesAdded: [{ message: { id: 'other' } }] }] },
      },
    })

    await r.attention.refresh()

    expect(r.notices.get('vault/a')).toHaveLength(1)
    expect(r.notices.get('vault/b')).toEqual([])
    expect(r.notices.get('vault/c')).toHaveLength(1)
    const sharedHistoryRequests = shared.seen.filter((url) =>
      new URL(url).pathname.endsWith('/history'),
    )
    expect(sharedHistoryRequests).toHaveLength(1)
    await Promise.all([a.stop(), b.stop(), c.stop()])
  })

  it('keeps teardown owned until every admitted metadata lookup settles', async () => {
    const r = rig()
    const server = gmail()
    const session = { id: 'one', accountSub: 'sub-one' }
    r.connect('vault/a', session, server)
    const lease = await r.subscribe('vault/a')
    await r.attention.refresh()
    r.preferences.set('vault/a', true)
    const snapshotsBefore = [...r.snapshots.get('vault/a')!]

    server.setUnread(9)
    server.setMessages({ failed: ['INBOX', 'UNREAD'], pending: ['INBOX', 'UNREAD'] })
    server.setMessageStatus('failed', 500)
    const pending = server.holdMessage('pending')
    server.setHistory({
      pages: {
        '': {
          historyId: '11',
          history: [
            {
              messagesAdded: [{ message: { id: 'failed' } }, { message: { id: 'pending' } }],
            },
          ],
        },
      },
    })

    const refresh = r.attention.refresh()
    await pending.started
    let stopped = false
    const stopping = lease.stop().then(() => {
      stopped = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(stopped).toBe(false)
    expect(r.snapshots.get('vault/a')).toEqual(snapshotsBefore)
    expect(r.notices.get('vault/a')).toEqual([])

    pending.release()
    await Promise.all([refresh, stopping])

    expect(stopped).toBe(true)
    expect(r.snapshots.get('vault/a')).toEqual(snapshotsBefore)
    expect(r.notices.get('vault/a')).toEqual([])
  })

  it('suppresses pending work after stop, unlink, reconnect, or preference changes', async () => {
    const r = rig()
    const first = gmail()
    const second = gmail()
    const firstSession = { id: 'first', accountSub: 'sub-first' }
    const secondSession = { id: 'second', accountSub: 'sub-second' }
    r.connect('vault/a', firstSession, first)
    const lease = await r.subscribe('vault/a')
    await r.attention.refresh()
    r.preferences.set('vault/a', true)
    first.setMessages({ pending: ['INBOX', 'UNREAD'] })
    first.setHistory({
      pages: {
        '': { historyId: '11', history: [{ messagesAdded: [{ message: { id: 'pending' } }] }] },
      },
    })

    let gate = first.holdHistory()
    let refresh = r.attention.refresh()
    await gate.started
    r.preferences.set('vault/a', false)
    gate.release()
    await refresh
    expect(r.notices.get('vault/a')).toEqual([])

    r.preferences.set('vault/a', true)
    first.setHistory({
      pages: {
        '': {
          historyId: '12',
          history: [{ messagesAdded: [{ message: { id: 'reconnected' } }] }],
        },
      },
    })
    first.setMessages({ reconnected: ['INBOX', 'UNREAD'] })
    gate = first.holdHistory()
    refresh = r.attention.refresh()
    await gate.started
    r.connect('vault/a', secondSession, second)
    gate.release()
    await refresh
    await r.attention.refresh()
    expect(lease.snapshot()).toMatchObject({ accountSub: 'sub-second' })
    expect(r.notices.get('vault/a')).toEqual([])

    second.setHistory({
      pages: {
        '': { historyId: '11', history: [{ messagesAdded: [{ message: { id: 'unlinked' } }] }] },
      },
    })
    second.setMessages({ unlinked: ['INBOX', 'UNREAD'] })
    gate = second.holdHistory()
    refresh = r.attention.refresh()
    await gate.started
    r.sessions.set('vault/a', null)
    gate.release()
    await refresh
    expect(lease.snapshot()).toMatchObject({ accountSub: null, status: 'disconnected' })
    expect(r.notices.get('vault/a')).toEqual([])

    r.connect('vault/a', secondSession, second)
    await r.attention.refresh()
    second.setMessages({ stopped: ['INBOX', 'UNREAD'] })
    second.setHistory({
      pages: {
        '': { historyId: '11', history: [{ messagesAdded: [{ message: { id: 'stopped' } }] }] },
      },
    })
    gate = second.holdHistory()
    refresh = r.attention.refresh()
    await gate.started
    const stopping = lease.stop()
    gate.release()
    await Promise.all([refresh, stopping])
    expect(r.notices.get('vault/a')).toEqual([])
  })
})
