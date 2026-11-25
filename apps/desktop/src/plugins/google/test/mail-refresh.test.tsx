import { act, cleanup, renderHook } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { DEFAULT_MAIL_MARKER_PREFERENCES } from '../shared/mail-markers'
import { useMail, type ThreadSummary } from '../renderer/mail/use-mail'

const search = vi.fn()
const archive = vi.fn()
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async (input: { name: string; remote: string; paramsJson?: string }) => {
          const params = JSON.parse(input.paramsJson ?? '{}') as Record<string, unknown>
          switch (input.name) {
            case 'google.search':
              return search(input.remote, params)
            case 'google.contacts':
            case 'google.sendAs':
            case 'google.drafts':
              return []
            case 'google.archive':
              return archive(input.remote, params)
            case 'google.mailCounts':
              return null
            case 'google.mailMarkerAnnotations':
              return {}
            case 'google.mailMarkerPreferences':
              return DEFAULT_MAIL_MARKER_PREFERENCES
            case 'google.thread':
              return { id: params.id, subject: 'Opened mail', messages: [] }
            default:
              throw new Error(`Unexpected capability ${input.name}`)
          }
        },
      },
    },
  },
}))

function summary(id: string): ThreadSummary {
  return {
    id,
    subject: id,
    from: { name: 'Sender', email: 'sender@example.test' },
    date: '2026-11-25T00:00:00Z',
    snippet: id,
    unread: false,
    answered: false,
    messageCount: 1,
    webUrl: `https://mail.google.com/mail/#inbox/${id}`,
    starred: false,
    important: false,
    hasDraft: false,
    category: null,
    labels: [],
    unsubscribeUrl: null,
    hasInvite: false,
    replied: false,
    lastReplyAt: null,
    addressedAs: 'to',
    automated: false,
    needsReply: false,
  }
}

function page(...ids: string[]) {
  return { threads: ids.map(summary), nextPageToken: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function advance(ms = 30_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mount() {
  const store = createStore()
  store.set(activeRemoteAtom, 'team/one')
  const hook = renderHook(({ account, visible }) => useMail(account, visible), {
    initialProps: { account: 'account-a', visible: true },
    wrapper: ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    ),
  })
  await act(async () => {})
  return { ...hook, store }
}

beforeEach(() => {
  vi.useFakeTimers()
  search.mockReset().mockResolvedValue(page('existing'))
  archive.mockReset().mockResolvedValue({ ok: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

test('new mail appears without manual refresh and leaves the open reader in place', async () => {
  const { result } = await mount()
  await act(async () => {
    result.current.openThread(summary('existing'))
  })
  search.mockResolvedValue(page('arrived', 'existing'))
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['arrived', 'existing'])
  expect(result.current.list.kind).toBe('ready')
  expect(result.current.openId).toBe('existing')
})

test('automatic arrivals retain the selected inbox filters', async () => {
  const { result } = await mount()
  await act(async () => {
    result.current.setCategory('updates')
    result.current.setUnreadOnly(true)
  })
  search.mockImplementation(async (_remote, params) =>
    params.category === 'updates' && params.unread === true
      ? page('filtered-arrival')
      : page('wrong-filter'),
  )
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['filtered-arrival'])
  expect(result.current.category).toBe('updates')
  expect(result.current.unreadOnly).toBe(true)
})

test('an older periodic answer cannot undo an archive', async () => {
  const { result } = await mount()
  const pending = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(pending.promise)
  await advance()
  await act(async () => {
    await result.current.removeThreads(['existing'], 'archive')
  })
  await act(async () => {
    pending.resolve(page('existing'))
  })
  expect(result.current.threads).toEqual([])
})

test('periodic reads wait for a pending write without undoing optimistic state', async () => {
  const { result } = await mount()
  const pending = deferred<{ ok: true }>()
  archive.mockReturnValueOnce(pending.promise)
  let writing!: Promise<void>
  await act(async () => {
    writing = result.current.removeThreads(['existing'], 'archive')
  })
  await advance(90_000)
  expect(result.current.threads).toEqual([])
  expect(search).toHaveBeenCalledTimes(1)
  search.mockResolvedValue(page())
  await act(async () => {
    pending.resolve({ ok: true })
    await writing
  })
  await advance()
  expect(result.current.threads).toEqual([])
  expect(search).toHaveBeenCalledTimes(2)
})

test('periodic reads do not overlap a stalled initial mailbox read', async () => {
  const initial = deferred<ReturnType<typeof page>>()
  search.mockReturnValue(initial.promise)
  const { result } = await mount()
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(1)
  await act(async () => {
    initial.resolve(page('initial'))
  })
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['initial'])
})

test('a stalled periodic read is single flight and a later failure keeps usable mail', async () => {
  const { result } = await mount()
  const pending = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(pending.promise)
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(2)
  await act(async () => {
    pending.resolve(page('arrived'))
  })
  search.mockRejectedValueOnce(new Error('Offline'))
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['arrived'])
  search.mockResolvedValue(page('reconnected'))
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['reconnected'])
})

test('hidden mail drops its pending answer and performs no more periodic reads', async () => {
  const { result, rerender, unmount } = await mount()
  const pending = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(pending.promise)
  await advance()
  rerender({ account: 'account-a', visible: false })
  await act(async () => {
    pending.resolve(page('hidden-result'))
  })
  await advance(90_000)
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['existing'])
  expect(search).toHaveBeenCalledTimes(2)
  rerender({ account: 'account-a', visible: true })
  search.mockResolvedValue(page('visible-again'))
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['visible-again'])
  unmount()
  const reads = search.mock.calls.length
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(reads)
})

test.each(['account', 'vault'] as const)(
  'a stalled old %s cannot block or replace the current inbox',
  async (context) => {
    const { result, rerender, store } = await mount()
    const old = deferred<ReturnType<typeof page>>()
    search.mockReturnValueOnce(old.promise)
    await advance()
    search.mockResolvedValue(page('current'))
    await act(async () => {
      if (context === 'account') rerender({ account: 'account-b', visible: true })
      else store.set(activeRemoteAtom, 'team/two')
    })
    search.mockResolvedValue(page('current-arrival', 'current'))
    await advance()
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      'current-arrival',
      'current',
    ])
    await act(async () => {
      old.resolve(page('old-account'))
    })
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      'current-arrival',
      'current',
    ])
  },
)
