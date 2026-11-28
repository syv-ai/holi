import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultEvent } from '@holi/shared'
import type { PluginCtx } from '../../../main/plugin-api'
import type { GoogleData } from '../main/data'
import type { MailThreadSummary } from '../main/gmail'
import { startGoogleTriggers } from '../main/triggers'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const thread = (id: string): MailThreadSummary => ({
  id,
  messageCount: 1,
  date: '2026-11-13T12:00:00Z',
  subject: '',
  snippet: '',
  answered: false,
  from: { email: `${id}@example.test`, name: '' },
  unread: false,
  webUrl: '',
  starred: false,
  important: false,
  hasDraft: false,
  category: null,
  labels: [],
  unsubscribeUrl: null,
  hasInvite: false,
  replied: false,
  lastReplyAt: null,
  addressedAs: null,
  automated: false,
  needsReply: false,
})

function rig() {
  const listeners = new Set<(event: VaultEvent) => void>()
  const emitted: VaultEvent[] = []
  const ctx = {
    events: {
      on: (cb: (event: VaultEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      emit: (event: VaultEvent) => emitted.push(event),
    },
  } as unknown as PluginCtx
  const announce = () => {
    for (const cb of listeners)
      cb({ type: 'interest', interest: { task: false, calendar: false, mail: ['in:inbox'] } })
  }
  return { ctx, emitted, announce }
}

afterEach(() => vi.useRealTimers())

describe('account-scoped trigger baselines', () => {
  it('carries an unreadable thread through a partial poll without treating its recovery as new mail', async () => {
    vi.useFakeTimers()
    const r = rig()
    const existing = thread('existing')
    const arrival = thread('arrival')
    const newer = { ...existing, messageCount: 2, date: '2026-11-13T12:01:00Z' }
    const threads = vi.fn<GoogleData['threads']>()
    const data = { threads } as unknown as GoogleData
    const stop = startGoogleTriggers(r.ctx, {
      data: async () => data,
      overrides: async () => ({}),
      pollMs: 100,
    })
    const setPage = (rows: MailThreadSummary[], unreadableThreadIds?: string[]) => {
      threads.mockResolvedValue({
        threads: rows,
        nextPageToken: null,
        syncedAt: '2026-11-13T12:02:00Z',
        unreadableThreadIds,
      })
    }
    try {
      setPage([existing])
      r.announce()
      await vi.advanceTimersByTimeAsync(1)
      expect(r.emitted).toEqual([])

      setPage([arrival], [existing.id])
      await vi.advanceTimersByTimeAsync(100)
      expect(r.emitted).toEqual([expect.objectContaining({ id: arrival.id, source: 'mail' })])

      setPage([existing, arrival])
      await vi.advanceTimersByTimeAsync(100)
      expect(r.emitted).toHaveLength(1)

      setPage([newer, arrival])
      await vi.advanceTimersByTimeAsync(200)
      expect(r.emitted.slice(1)).toEqual([
        expect.objectContaining({ id: existing.id, source: 'mail', version: `2:${newer.date}` }),
      ])

      // Complete snapshots still let a thread leave and re-enter a query.
      setPage([newer])
      await vi.advanceTimersByTimeAsync(100)
      setPage([newer, arrival])
      await vi.advanceTimersByTimeAsync(100)
      expect(r.emitted.slice(2)).toEqual([
        expect.objectContaining({ id: arrival.id, source: 'mail' }),
      ])
    } finally {
      stop()
    }
  })

  it('baselines an initially unreadable thread without suppressing later arrivals', async () => {
    vi.useFakeTimers()
    const r = rig()
    const baseline = thread('baseline')
    const existing = thread('existing')
    const arrival = thread('arrival')
    const later = thread('later')
    const newer = { ...existing, messageCount: 2, date: '2026-11-13T12:01:00Z' }
    const threads = vi.fn<GoogleData['threads']>()
    const data = { threads } as unknown as GoogleData
    const stop = startGoogleTriggers(r.ctx, {
      data: async () => data,
      overrides: async () => ({}),
      pollMs: 100,
    })
    const setPage = (rows: MailThreadSummary[], unreadableThreadIds?: string[]) => {
      threads.mockResolvedValue({
        threads: rows,
        nextPageToken: null,
        syncedAt: '2026-11-13T12:02:00Z',
        unreadableThreadIds,
      })
    }
    try {
      setPage([baseline], [existing.id])
      r.announce()
      await vi.advanceTimersByTimeAsync(1)
      expect(r.emitted).toEqual([])

      setPage([baseline, arrival], [existing.id, later.id])
      await vi.advanceTimersByTimeAsync(100)
      expect(r.emitted).toEqual([expect.objectContaining({ id: arrival.id, source: 'mail' })])

      // Only the thread first listed after the baseline is new on recovery.
      setPage([baseline, existing, arrival, later])
      await vi.advanceTimersByTimeAsync(100)
      expect(r.emitted.slice(1)).toEqual([
        expect.objectContaining({ id: later.id, source: 'mail' }),
      ])

      setPage([baseline, newer, arrival, later])
      await vi.advanceTimersByTimeAsync(200)
      expect(r.emitted.slice(2)).toEqual([
        expect.objectContaining({ id: existing.id, source: 'mail', version: `2:${newer.date}` }),
      ])
    } finally {
      stop()
    }
  })

  it('starts a fresh baseline when a vault switches accounts, rather than treating B mail as new A mail', async () => {
    vi.useFakeTimers()
    const r = rig()
    const first = {
      threads: vi.fn(async () => ({ threads: [thread('a')] })),
    } as unknown as GoogleData
    const second = {
      threads: vi.fn(async () => ({ threads: [thread('b')] })),
    } as unknown as GoogleData
    let current: GoogleData | null = first
    const stop = startGoogleTriggers(r.ctx, {
      data: async () => current,
      overrides: async () => ({}),
      pollMs: 100,
    })
    try {
      r.announce()
      await vi.advanceTimersByTimeAsync(1)
      current = second
      await vi.advanceTimersByTimeAsync(100)
      expect(r.emitted.filter((event) => event.type === 'happened')).toEqual([])
      vi.mocked(second.threads).mockResolvedValue({
        threads: [thread('b'), thread('new')],
        nextPageToken: null,
        syncedAt: '2026-11-13T12:00:00Z',
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(r.emitted.filter((event) => event.type === 'happened')).toEqual([
        expect.objectContaining({ id: 'new', source: 'mail' }),
      ])
    } finally {
      stop()
    }
  })

  it('drops an old account response that finishes after unlinking, including its baseline', async () => {
    vi.useFakeTimers()
    const r = rig()
    const pending = deferred<{ threads: MailThreadSummary[] }>()
    const first = {
      threads: vi
        .fn()
        .mockResolvedValueOnce({ threads: [thread('a')] })
        .mockReturnValueOnce(pending.promise),
    } as unknown as GoogleData
    let current: GoogleData | null = first
    const stop = startGoogleTriggers(r.ctx, {
      data: async () => current,
      overrides: async () => ({}),
      pollMs: 100,
    })
    try {
      r.announce()
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(100)
      current = null
      pending.resolve({ threads: [thread('a'), thread('stale')] })
      await vi.advanceTimersByTimeAsync(1)
      expect(r.emitted.filter((event) => event.type === 'happened')).toEqual([])
    } finally {
      stop()
    }
  })
})
