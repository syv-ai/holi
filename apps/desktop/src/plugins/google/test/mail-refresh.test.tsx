import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react'
import { render } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Toaster, toast } from 'sonner'
import { googleRenderer } from '../renderer'
import { Provider, createStore } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { DEFAULT_MAIL_MARKER_PREFERENCES } from '../shared/mail-markers'
import { useMail, type ThreadSummary } from '../renderer/mail/use-mail'

const search = vi.fn()
const archive = vi.fn()
const unarchive = vi.fn()
const counts = vi.fn()
const categories = vi.fn()
const marker = vi.fn()
const annotations = vi.fn()
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      names: { query: async () => [] },
      run: {
        mutate: async (input: { name: string; remote: string; paramsJson?: string }) => {
          const params = JSON.parse(input.paramsJson ?? '{}') as Record<string, unknown>
          switch (input.name) {
            case 'google.status':
              return {
                account: { email: 'sender@example.test', sub: 'account-a' },
                missingScopes: [],
              }
            case 'google.allAccounts':
              return {
                accounts: [{ sub: 'account-a', email: 'sender@example.test' }],
                current: 'account-a',
              }
            case 'google.search':
              return search(input.remote, params)
            case 'google.contacts':
            case 'google.sendAs':
            case 'google.drafts':
              return []
            case 'google.archive':
              return archive(input.remote, params)
            case 'google.star':
              return undefined
            case 'google.unarchive':
              return unarchive(input.remote, params)
            case 'google.mailCounts':
              return counts(input.remote)
            case 'google.categoryCounts':
              return categories(input.remote)
            case 'google.setMailMarker':
              return marker(input.remote, params)
            case 'google.imageSenders':
              return []
            case 'google.mailMarkerAnnotations':
              return annotations(input.remote, params)
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
    snippet: `Preview of ${id}`,
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

const cursor = { version: 1 as const, owner: 'team/one:account-a', key: 'inbox', historyId: '100' }
function page(...ids: string[]) {
  return pageWithToken(null, ...ids)
}

function pageWithToken(token: string | null, ...ids: string[]) {
  return {
    threads: ids.map(summary),
    nextPageToken: token,
    syncedAt: '2026-11-25T00:00:00Z',
    uiList: {
      mode: 'page' as 'page' | 'delta' | 'coverage',
      cursor,
      removedIds: [] as string[],
      revalidatedIds: [] as string[],
    },
  }
}
function delta(
  ids: string[],
  loaded: string[],
  removed: string[] = [],
  token: string | null = null,
) {
  return {
    ...pageWithToken(token, ...ids),
    uiList: {
      mode: 'delta' as const,
      cursor: { ...cursor, historyId: '101' },
      removedIds: removed,
      revalidatedIds: loaded.filter((id) => ids.includes(id) || removed.includes(id)),
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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
  unarchive.mockReset().mockResolvedValue({ ok: true })
  counts.mockReset().mockResolvedValue({ unread: 16, total: 340 })
  categories.mockReset().mockResolvedValue({ updates: { count: 3, more: false } })
  marker.mockReset().mockResolvedValue({ ok: true })
  annotations.mockReset().mockResolvedValue({})
})
afterEach(async () => {
  toast.dismiss()
  await advance(100)
  await advance(1_000)
  cleanup()
  vi.useRealTimers()
})

test('StrictMode replay queues an initial replacement without overlapping reads or waiting for a poll', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'team/one')
  const initial = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(initial.promise).mockResolvedValue(page('current-ready'))
  const { result } = renderHook(() => useMail('account-a', true), {
    reactStrictMode: true,
    wrapper: ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    ),
  })
  await act(async () => {})
  expect(search).toHaveBeenCalledTimes(1)
  await act(async () => {
    initial.resolve(page('retired-initial'))
  })
  expect(search).toHaveBeenCalledTimes(2)
  expect(result.current.list.kind).toBe('ready')
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['current-ready'])
})

test('a successful retained-reader write replaces its invalidated initial search without polling', async () => {
  const { result } = await mount()
  await act(async () => {
    result.current.openThread(summary('existing'))
  })
  const replacement = {
    threads: [summary('search-match')],
    nextPageToken: null,
    syncedAt: '2026-11-25T00:00:00Z',
  }
  const pending = deferred<typeof replacement>()
  search.mockReturnValueOnce(pending.promise).mockResolvedValue(replacement)
  await act(async () => {
    result.current.search('subject:retained')
  })
  expect(result.current.list.kind).toBe('loading')
  await act(async () => {
    expect(await result.current.setStarred('existing', true)).toBe(true)
  })
  expect(search).toHaveBeenCalledTimes(2)
  await act(async () => {
    pending.resolve({ ...replacement, threads: [summary('retired-search')] })
  })
  expect(search).toHaveBeenCalledTimes(3)
  expect(result.current.searching).toBe(true)
  expect(result.current.openId).toBe('existing')
  expect(result.current.list.kind).toBe('ready')
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['search-match'])
})

test('a write invalidates a stalled poll without releasing its single-flight slot', async () => {
  const { result } = await mount()
  const pending = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(pending.promise)
  await advance()
  await act(async () => {
    await result.current.removeThreads(['existing'], 'archive')
  })
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(2)
  expect(result.current.threads).toEqual([])
  await act(async () => {
    pending.resolve(page('existing'))
  })
  expect(result.current.threads).toEqual([])
  search.mockResolvedValue(delta(['arrived'], []))
  await advance()
  expect(search).toHaveBeenCalledTimes(3)
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['arrived'])
})

test('history refresh preserves later pages and continuation after cached rows disappear', async () => {
  search
    .mockResolvedValueOnce(pageWithToken('next', 'cached'))
    .mockResolvedValueOnce(delta(['arrived'], ['cached'], [], 'fresh-next'))
    .mockResolvedValueOnce(pageWithToken('older', 'later'))
    .mockResolvedValueOnce(delta([], ['arrived', 'cached', 'later'], ['cached'], 'fresh-older'))
    .mockResolvedValueOnce(page('last'))
  const { result } = await mount()
  await advance()
  expect(result.current.list).toMatchObject({ kind: 'ready', nextPageToken: 'fresh-next' })
  await act(async () => result.current.loadMore())
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['arrived', 'cached', 'later'])
  expect(search.mock.calls[2]?.[1]).toMatchObject({
    pageToken: 'fresh-next',
    uiList: {
      loadedIds: expect.arrayContaining(['cached', 'arrived']),
      cursor: { ...cursor, historyId: '101' },
    },
  })
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['arrived', 'later'])
  expect(result.current.list).toMatchObject({ kind: 'ready', nextPageToken: 'fresh-older' })
  await act(async () => result.current.loadMore())
  expect(search.mock.calls[4]?.[1]).toMatchObject({ pageToken: 'fresh-older' })
  expect(result.current.threads.map((thread) => thread.id).sort()).toEqual([
    'arrived',
    'last',
    'later',
  ])
  expect(result.current.list).toMatchObject({ kind: 'ready', nextPageToken: null })
})

test('pagination is single flight with polling and refresh uses every loaded row', async () => {
  search.mockResolvedValueOnce(pageWithToken('next', 'cached'))
  const { result } = await mount()
  const later = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(later.promise)
  await act(async () => result.current.loadMore())
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(2)
  await act(async () => later.resolve(pageWithToken('older', 'later')))
  search.mockResolvedValue(delta(['arrived', 'cached'], ['cached', 'later'], [], 'fresh'))
  await advance()
  expect(search.mock.lastCall?.[1]).toMatchObject({
    uiList: {
      loadedIds: expect.arrayContaining(['cached', 'later']),
      refresh: true,
      cursor,
    },
  })
  expect(result.current.threads.map((thread) => thread.id).sort()).toEqual([
    'arrived',
    'cached',
    'later',
  ])
  expect(result.current.list).toMatchObject({ nextPageToken: 'fresh' })
})

test.each(['sidebar', 'surface'] as const)(
  '%s registration retains the reader across arrivals, updates and authoritative departures',
  async (registration) => {
    search.mockResolvedValueOnce(pageWithToken('next', 'existing', 'departed'))
    const store = createStore()
    store.set(activeRemoteAtom, 'team/one')
    const Surface =
      registration === 'sidebar'
        ? googleRenderer.sidebarApps!.find((app) => app.id === 'mail')!.render
        : googleRenderer.surfaces!.find((surface) => surface.kind === 'mail')!.render
    const view = render(
      <Provider store={store}>
        <Surface visible />
      </Provider>,
    )
    await act(async () => {})
    expect(search.mock.calls[0]?.[1]).toMatchObject({ uiList: { loadedIds: [] } })
    await act(async () => fireEvent.click(screen.getByText('existing', { exact: true })))
    const reader = screen.getByRole('heading', { name: 'Opened mail' })
    const update = delta(['incoming', 'existing'], ['existing', 'departed'], ['departed'], 'fresh')
    update.threads[1] = { ...summary('existing'), snippet: 'Updated preview' }
    search.mockResolvedValueOnce(update)
    await advance()
    expect(screen.getByText('incoming', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('Updated preview', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('departed', { exact: true })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Opened mail' })).toBe(reader)
    expect(search.mock.lastCall?.[1]).toMatchObject({
      uiList: {
        loadedIds: expect.arrayContaining(['existing', 'departed']),
        refresh: true,
        cursor,
      },
    })
    const later = deferred<ReturnType<typeof page>>()
    search.mockReturnValueOnce(later.promise)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more' })))
    expect(search.mock.lastCall?.[1]).toMatchObject({ pageToken: 'fresh' })
    const reads = search.mock.calls.length
    await advance(90_000)
    expect(search).toHaveBeenCalledTimes(reads)
    await act(async () => later.resolve(page('older')))
    search.mockResolvedValueOnce(delta(['incoming'], ['existing', 'incoming', 'older']))
    await advance()
    // Omission is not a departure, including mail appended beyond the first page.
    expect(screen.getByText('older', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('existing', { exact: true })).toBeInTheDocument()
    expect(screen.getAllByText('incoming', { exact: true })).toHaveLength(1)
    const hidden = deferred<ReturnType<typeof page>>()
    search.mockReturnValueOnce(hidden.promise)
    await advance()
    view.rerender(
      <Provider store={store}>
        <Surface visible={false} />
      </Provider>,
    )
    await act(async () => hidden.resolve(page('hidden-result')))
    expect(screen.queryByText('hidden-result')).toBeNull()
    const stopped = search.mock.calls.length
    await advance(90_000)
    expect(search).toHaveBeenCalledTimes(stopped)
    search.mockResolvedValue(page('restored'))
    view.rerender(
      <Provider store={store}>
        <Surface visible />
      </Provider>,
    )
    await act(async () => {})
    const oldVault = deferred<ReturnType<typeof page>>()
    search.mockReturnValueOnce(oldVault.promise)
    await advance()
    search.mockResolvedValue(page('current-vault'))
    await act(async () => store.set(activeRemoteAtom, 'team/two'))
    expect(screen.getByText('current-vault', { exact: true })).toBeInTheDocument()
    await act(async () => oldVault.resolve(page('stale-vault')))
    expect(screen.queryByText('stale-vault', { exact: true })).toBeNull()
    const unmounted = deferred<ReturnType<typeof page>>()
    search.mockReturnValueOnce(unmounted.promise)
    await advance()
    const beforeUnmount = search.mock.calls.length
    view.unmount()
    await act(async () => unmounted.resolve(page('unmounted-result')))
    await advance()
    expect(search).toHaveBeenCalledTimes(beforeUnmount)
    expect(screen.queryByText('unmounted-result', { exact: true })).toBeNull()
  },
)

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
  search.mockResolvedValue(page())
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
    pending.resolve(delta(['arrived'], ['existing'], ['existing']))
  })
  search.mockRejectedValueOnce(new Error('Offline'))
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['arrived'])
  search.mockResolvedValue(delta(['reconnected'], ['arrived'], ['arrived']))
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
  expect(result.current.threads).toEqual([])
  expect(search).toHaveBeenCalledTimes(2)
  search.mockResolvedValue(page('visible-again'))
  rerender({ account: 'account-a', visible: true })
  await advance()
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['visible-again'])
  unmount()
  const reads = search.mock.calls.length
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(reads)
})

test('a deferred later page cannot cross an account switch or lose the current rows', async () => {
  search.mockResolvedValueOnce(pageWithToken('next', 'existing'))
  const { result, rerender } = await mount()
  const later = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(later.promise)
  await act(async () => result.current.loadMore())
  await advance()
  expect(search).toHaveBeenCalledTimes(2)
  rerender({ account: 'account-b', visible: true })
  await advance()
  await act(async () => {
    later.resolve(page('wrong-route'))
  })
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['existing'])
  expect(new Set(result.current.threads.map((thread) => thread.id)).size).toBe(
    result.current.threads.length,
  )
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
      'current',
      'current-arrival',
    ])
    await act(async () => {
      old.resolve(page('old-account'))
    })
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      'current',
      'current-arrival',
    ])
  },
)

test('pending marker writes suspend polling and manual refresh until persisted reconciliation', async () => {
  const { result } = await mount()
  const pending = deferred<{ ok: true }>()
  marker.mockReturnValueOnce(pending.promise)
  await act(async () => result.current.activateMarker('existing', false))
  expect(result.current.threads[0]).toMatchObject({ id: 'existing', starred: true })
  await act(async () => result.current.refresh())
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(1)
  annotations.mockResolvedValue({ existing: 'yellow-star' })
  search.mockResolvedValue({
    ...delta(['existing'], ['existing']),
    threads: [{ ...summary('existing'), starred: true }],
  })
  await act(async () => pending.resolve({ ok: true }))
  expect(search).toHaveBeenCalledTimes(2)
  expect(result.current.threads[0]).toMatchObject({ id: 'existing', starred: true })
})

test.each(['account', 'vault'] as const)(
  'activated category counts recover on a poll and late counts cannot cross %s contexts',
  async (context) => {
    const { result, store, rerender } = await mount()
    expect(result.current.counts).toEqual({ unread: 16, total: 340 })
    expect(categories).not.toHaveBeenCalled()
    categories.mockRejectedValueOnce(new Error('Offline'))
    await act(async () => result.current.loadCategoryCounts())
    expect(result.current.categoryCounts).toBeNull()
    counts.mockResolvedValue({ unread: 17, total: 341 })
    await advance()
    expect(result.current.counts).toEqual({ unread: 17, total: 341 })
    expect(result.current.categoryCounts).toEqual({ updates: { count: 3, more: false } })
    const oldCounts = deferred<{ unread: number; total: number }>()
    const oldCategories = deferred<{ updates: { count: number; more: boolean } }>()
    counts.mockReturnValue(oldCounts.promise)
    categories.mockReturnValue(oldCategories.promise)
    await advance()
    counts.mockResolvedValue({ unread: 2, total: 8 })
    categories.mockResolvedValue({ updates: { count: 1, more: false } })
    await act(async () => {
      if (context === 'account') rerender({ account: 'account-b', visible: true })
      else store.set(activeRemoteAtom, 'team/two')
    })
    await act(async () => result.current.loadCategoryCounts())
    await act(async () => {
      oldCounts.resolve({ unread: 999, total: 999 })
      oldCategories.resolve({ updates: { count: 999, more: false } })
    })
    expect(result.current.counts).toEqual({ unread: 2, total: 8 })
    expect(result.current.categoryCounts).toEqual({ updates: { count: 1, more: false } })
  },
)

test.each(['sidebar', 'surface'] as const)(
  '%s registration keeps selected filters and reader while counts and arrivals advance',
  async (registration) => {
    // Only the refresh interval needs a clock. Testing Library's userEvent
    // wrapper drains a real timeout after each interaction (Vitest is not Jest).
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const store = createStore()
    store.set(activeRemoteAtom, 'team/one')
    const Surface =
      registration === 'sidebar'
        ? googleRenderer.sidebarApps!.find((app) => app.id === 'mail')!.render
        : googleRenderer.surfaces!.find((surface) => surface.kind === 'mail')!.render
    render(
      <Provider store={store}>
        <Surface visible />
      </Provider>,
    )
    await act(async () => {})
    const user = userEvent.setup()
    if (registration === 'sidebar') {
      expect(screen.getByText('16', { exact: true })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /Inbox tab:/ }))
      await user.click(screen.getByRole('menuitemradio', { name: /Updates/ }))
      await user.click(screen.getByRole('tab', { name: 'Unread' }))
    } else {
      expect(screen.getByRole('button', { name: /show unread only/i })).toHaveTextContent('16')
      await user.click(screen.getByRole('button', { name: 'Choose a mailbox' }))
      await user.click(screen.getByRole('menuitem', { name: /Updates/ }))
      await user.click(screen.getByRole('button', { name: /show unread only/i }))
    }
    await act(async () => {})
    await act(async () => fireEvent.click(screen.getByText('existing', { exact: true })))
    const reader = screen.getByRole('heading', { name: 'Opened mail' })
    counts.mockResolvedValue({ unread: 18, total: 342 })
    categories.mockResolvedValue({ updates: { count: 5, more: false } })
    search.mockResolvedValue(delta(['filtered-arrival'], ['existing']))
    await advance()
    expect(search.mock.lastCall?.[1]).toMatchObject({
      category: 'updates',
      unread: true,
      uiList: { refresh: true, loadedIds: ['existing'] },
    })
    expect(screen.getByText('filtered-arrival', { exact: true })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Opened mail' })).toBe(reader)
    if (registration === 'sidebar') {
      expect(screen.getByRole('tab', { name: 'Unread' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText('5', { exact: true })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Inbox tab: Updates' })).toBeInTheDocument()
    } else {
      expect(
        screen.getByRole('button', { name: /show (unread only|all mail)/i }),
      ).toHaveTextContent('5')
      expect(screen.getByRole('button', { name: 'Choose a mailbox' })).toHaveTextContent('Updates')
    }
  },
)

test('manual refresh queues behind a stalled poll and stays single flight across timers', async () => {
  const { result } = await mount()
  const poll = deferred<ReturnType<typeof page>>()
  const manual = deferred<ReturnType<typeof page>>()
  search.mockReturnValueOnce(poll.promise).mockReturnValueOnce(manual.promise)
  await advance()
  await act(async () => result.current.refresh())
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(2)
  expect(result.current.threads.map((row) => row.id)).toEqual(['existing'])
  await act(async () => poll.resolve(delta(['incoming'], ['existing'])))
  expect(search).toHaveBeenCalledTimes(3)
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(3)
  await act(async () => manual.resolve(delta(['manual'], ['existing', 'incoming'])))
  expect(result.current.threads.map((row) => row.id)).toEqual(['existing', 'incoming', 'manual'])
})

test('mixed later-page bulk failures recover only refused rows after all concurrent writes settle', async () => {
  search
    .mockResolvedValueOnce(pageWithToken('next', 'first'))
    .mockResolvedValueOnce(page('later-a', 'later-b'))
  const { result } = await mount()
  await act(async () => result.current.loadMore())
  const refused = deferred<{ ok: true }>()
  const moved = deferred<{ ok: true }>()
  const concurrent = deferred<{ ok: true }>()
  archive.mockImplementation((_remote, { id }) =>
    id === 'later-a' ? refused.promise : id === 'later-b' ? moved.promise : concurrent.promise,
  )
  // Coverage returns the surviving candidate even though it is beyond the first page.
  search.mockImplementation(async (_remote, params) => ({
    ...page(...(params.uiList.loadedIds.includes('later-a') ? ['later-a'] : [])),
    uiList: {
      mode: 'coverage',
      cursor,
      revalidatedIds: params.uiList.loadedIds,
      removedIds: params.uiList.loadedIds.filter((id: string) => id !== 'later-a'),
    },
  }))
  let bulk!: Promise<void>
  let other!: Promise<void>
  await act(async () => {
    bulk = result.current.removeThreads(['later-a', 'later-b'], 'archive')
    other = result.current.removeThreads(['first'], 'archive')
  })
  await act(async () => refused.reject(new Error('Refused')))
  await advance(90_000)
  expect(search).toHaveBeenCalledTimes(2)
  await act(async () => {
    moved.resolve({ ok: true })
    await bulk
  })
  expect(search).toHaveBeenCalledTimes(2)
  await act(async () => {
    concurrent.resolve({ ok: true })
    await other
  })
  expect(result.current.threads.map((row) => row.id)).toEqual(['later-a'])
  expect(result.current.writeError).toBeTruthy()
  expect(search.mock.lastCall?.[1].uiList).not.toHaveProperty('cursor')
})

test('Undo restores later-page mail through authoritative coverage', async () => {
  render(<Toaster />)
  search.mockResolvedValueOnce(pageWithToken('next', 'first')).mockResolvedValueOnce(page('later'))
  const { result } = await mount()
  await act(async () => result.current.loadMore())
  await act(async () => result.current.removeThreads(['later'], 'archive'))
  await advance(1)
  search.mockImplementation(async (_remote, params) => ({
    ...page('first', ...(params.uiList.loadedIds.includes('later') ? ['later'] : [])),
    uiList: { mode: 'coverage', cursor, revalidatedIds: params.uiList.loadedIds, removedIds: [] },
  }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Undo' })))
  expect(unarchive).toHaveBeenCalledWith('team/one', { id: 'later' })
  expect(result.current.threads.map((row) => row.id)).toEqual(['first', 'later'])
  expect(search.mock.lastCall?.[1].uiList).not.toHaveProperty('cursor')
})

test.each(['folder', 'filter', 'hidden'] as const)(
  'Undo is visibly dismissed when its %s owner retires',
  async (change) => {
    render(<Toaster />)
    const { result, rerender } = await mount()
    await act(async () => result.current.removeThreads(['existing'], 'archive'))
    await advance(1)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    await act(async () => {
      if (change === 'folder') result.current.setFolder('sent')
      else if (change === 'filter') result.current.setUnreadOnly(true)
      else rerender({ account: 'account-a', visible: false })
    })
    // Sonner publishes dismissal over animation frames; commit that render
    // before advancing the exit animation's removal timer.
    await advance(100)
    await advance(1_000)
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(unarchive).not.toHaveBeenCalled()
  },
)
