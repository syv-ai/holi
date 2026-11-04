/** The browser's pages and the shell's tabs onto them (docs/features/browser.md). */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { browserVault, pagesAtom } from '../renderer/state'
import type { PageInfo } from '../shared/page'
import {
  activeRemoteAtom,
  closeSurfaceTabAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
} from '@/plugin-api'

const close = vi.fn()
const open = vi.fn()

vi.mock('../renderer/browser-cap', () => ({
  browserCap: {
    // The vault's opening list, which these tests never answer.
    tabs: () => new Promise<never>(() => {}),
    close: (remote: string, { tab }: { tab: string }) => {
      close(remote, tab)
      return Promise.resolve()
    },
    open: (...args: unknown[]) => open(...args),
  },
}))

const storage = new Map<string, string>()

beforeEach(() => {
  close.mockReset()
  open.mockReset()
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

test('a page that left main’s list takes its tab out of the strip', () => {
  const store = storeWith('p1', 'p2')
  const stop = browserVault('o/vault', store)

  store.set(pagesAtom, [page('p2')])

  expect(store.get(surfaceTabIdsAtom('browser'))).toEqual(['p2'])
  stop()
})
