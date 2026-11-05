/** The browser's pages and the shell's tabs onto them (docs/features/browser.md). */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { browserEvents, browserVault, pagesAtom } from '../renderer/state'
import type { PageInfo } from '../shared/page'
import {
  activeRemoteAtom,
  closeSurfaceTabAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
} from '@/plugin-api'

const { close, open, tabs } = vi.hoisted(() => ({
  close: vi.fn(),
  open: vi.fn(),
  tabs: vi.fn(),
}))

vi.mock('../renderer/browser-cap', () => ({
  browserCap: {
    tabs,
    close: (remote: string, { tab }: { tab: string }) => {
      close(remote, tab)
      return Promise.resolve()
    },
    open: (...args: unknown[]) => open(...args),
  },
}))

const storage = new Map<string, string>()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(() => {
  close.mockReset()
  open.mockReset()
  tabs.mockReset().mockImplementation(() => new Promise<never>(() => {}))
  storage.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
})

const page = (id: string, url = ''): PageInfo => ({
  id,
  url,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  favicon: null,
  error: null,
})

function storeWith(...ids: string[]) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(
    pagesAtom,
    ids.map((id) => page(id)),
  )
  for (const id of ids) store.set(openSurfaceAtom, 'browser', id)
  return store
}

test('closing a browser tab in the strip closes its page', () => {
  const store = storeWith('p1')
  const stop = browserVault('o/vault', store)

  store.set(closeSurfaceTabAtom, 'browser', 'p1')

  expect(close).toHaveBeenCalledWith('o/vault', 'p1')
  stop()
})

test('switching vaults closes none of the old vault’s pages', () => {
  const store = storeWith('p1')
  const stop = browserVault('o/vault', store)

  store.set(activeRemoteAtom, 'o/other')
  stop()

  expect(close).not.toHaveBeenCalled()
})

test('reopening a closed browser tab restores its remembered page', async () => {
  open.mockResolvedValue(page('p1', 'https://example.com/'))
  const store = storeWith('p1')
  store.set(pagesAtom, [page('p1')])
  const stop = browserVault('o/vault', store)

  store.set(pagesAtom, [page('p1', 'https://example.com/')])
  store.set(closeSurfaceTabAtom, 'browser', 'p1')
  store.set(pagesAtom, [])
  store.set(openSurfaceAtom, 'browser', 'p1')

  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith('o/vault', {
      reopen: 'p1',
      url: 'https://example.com/',
      shown: true,
    }),
  )
  stop()
})

test('a delayed page-close event cannot erase a shell tab reopened in the meantime', async () => {
  const closeResult = deferred<void>()
  const opened = deferred<PageInfo>()
  close.mockReturnValue(closeResult.promise)
  open.mockReturnValue(opened.promise)
  storage.set('holi.browser.addresses', JSON.stringify({ p1: 'https://example.com/' }))
  const store = storeWith('p1')
  store.set(pagesAtom, [page('p1', 'https://example.com/')])
  const stop = browserVault('o/vault', store)

  store.set(closeSurfaceTabAtom, 'browser', 'p1')
  store.set(openSurfaceAtom, 'browser', 'p1')

  // The old WebContents close event arrives after shell undo restored the id.
  store.set(pagesAtom, [])
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith('o/vault', {
      reopen: 'p1',
      url: 'https://example.com/',
      shown: true,
    }),
  )
  opened.resolve(page('p1', 'https://example.com/'))
  store.set(pagesAtom, [page('p1', 'https://example.com/')])
  closeResult.resolve()

  expect(store.get(surfaceTabIdsAtom('browser'))).toEqual(['p1'])
  expect(store.get(pagesAtom)).toMatchObject([{ id: 'p1', url: 'https://example.com/' }])
  stop()
})

test('a reopen failure removes its tab instead of leaving it loading forever', async () => {
  storage.set('holi.browser.addresses', JSON.stringify({ p1: 'https://example.com/' }))
  open.mockRejectedValue(new Error('unavailable'))
  const store = storeWith()
  const stop = browserVault('o/vault', store)

  store.set(openSurfaceAtom, 'browser', 'p1')

  await vi.waitFor(() => expect(store.get(surfaceTabIdsAtom('browser'))).toEqual([]))
  stop()
})

test('the closed-address limit never prunes addresses of live pages', () => {
  const ids = Array.from({ length: 51 }, (_, i) => `p${i}`)
  const store = storeWith(...ids)
  store.set(pagesAtom, [])
  const stop = browserVault('o/vault', store)
  store.set(
    pagesAtom,
    ids.map((id) => page(id, `https://${id}.example.com/`)),
  )

  const saved = JSON.parse(storage.get('holi.browser.addresses') ?? '{}') as Record<string, string>
  expect(Object.keys(saved)).toHaveLength(51)
  expect(saved['p1']).toBe('https://p1.example.com/')
  stop()
})

test('a stale startup list cannot overwrite a newer tabs event', async () => {
  const startup = deferred<PageInfo[]>()
  tabs.mockReturnValue(startup.promise)
  const store = storeWith()
  const stop = browserVault('o/vault', store)

  browserEvents.tabs!(
    { remote: 'o/vault', payload: [page('newer', 'https://new.example/')] },
    store,
  )
  startup.resolve([page('stale', 'https://stale.example/')])
  await Promise.resolve()
  await Promise.resolve()

  expect(store.get(pagesAtom)).toMatchObject([{ id: 'newer', url: 'https://new.example/' }])
  stop()
})

test('closing a shell tab while its reopen is pending closes the eventual page', async () => {
  const opened = deferred<PageInfo>()
  open.mockReturnValue(opened.promise)
  storage.set('holi.browser.addresses', JSON.stringify({ p1: 'https://example.com/' }))
  const store = storeWith()
  const stop = browserVault('o/vault', store)
  store.set(openSurfaceAtom, 'browser', 'p1')
  store.set(closeSurfaceTabAtom, 'browser', 'p1')

  opened.resolve(page('p1', 'https://example.com/'))
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith('o/vault', 'p1'))
  expect(store.get(surfaceTabIdsAtom('browser'))).not.toContain('p1')
  stop()
})

test('startup restoration and a live empty-list event share one reopen', async () => {
  const startup = deferred<PageInfo[]>()
  tabs.mockReturnValue(startup.promise)
  open.mockResolvedValue(page('p1', 'https://example.com/'))
  storage.set('holi.browser.addresses', JSON.stringify({ p1: 'https://example.com/' }))
  const store = storeWith('p1')
  store.set(pagesAtom, [])
  const stop = browserVault('o/vault', store)

  startup.resolve([])
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  browserEvents.tabs!({ remote: 'o/vault', payload: [] }, store)
  await Promise.resolve()
  expect(open).toHaveBeenCalledTimes(1)
  stop()
})

test('a blank page can be reopened with its original tab id', async () => {
  open.mockResolvedValue(page('p1'))
  const store = storeWith('p1')
  store.set(pagesAtom, [page('p1')])
  const stop = browserVault('o/vault', store)
  store.set(pagesAtom, [])
  store.set(openSurfaceAtom, 'browser', 'p1')

  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith('o/vault', {
      reopen: 'p1',
      url: '',
      shown: true,
    }),
  )
  stop()
})

test('closed addresses are bounded per vault without affecting other vaults', () => {
  const ids = Array.from({ length: 51 }, (_, i) => `p${i}`)
  const store = storeWith(...ids)
  store.set(pagesAtom, [])
  const stop = browserVault('o/vault', store)
  store.set(
    pagesAtom,
    ids.map((id) => page(id, `https://${id}.example.com/`)),
  )
  store.set(pagesAtom, [])

  const closed = JSON.parse(storage.get('holi.browser.closed-addresses') ?? '{}') as Record<
    string,
    Record<string, string>
  >
  expect(Object.keys(closed['o/vault'] ?? {})).toHaveLength(50)
  expect(closed['o/vault']?.['p0']).toBeUndefined()
  expect(Object.keys(closed)).toEqual(['o/vault'])
  stop()
})

test('a page that left main’s list takes its tab out of the strip', () => {
  const store = storeWith('p1', 'p2')
  const stop = browserVault('o/vault', store)

  store.set(pagesAtom, [page('p2')])

  expect(store.get(surfaceTabIdsAtom('browser'))).toEqual(['p2'])
  stop()
})
