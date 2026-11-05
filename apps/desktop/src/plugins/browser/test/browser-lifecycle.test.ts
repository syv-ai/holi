/** The renderer shell and the browser capability table share page identity. */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'
import { browserCapabilities, BROWSER_NAMESPACES, type Pages } from '../main/capabilities'
import type { PageInfo } from '../shared/page'
import { browserEvents, browserVault, pagesAtom } from '../renderer/state'
import {
  activeRemoteAtom,
  closeSurfaceTabAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
} from '@/plugin-api'

const dispatch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => dispatch(input) } } },
}))

const remote = 'o/vault'
const address = 'https://example.com/'
const makePage = (id: string, url: string): PageInfo => ({
  id,
  url,
  title: 'Example',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  favicon: null,
  error: null,
})

function fixture(
  initial: PageInfo[] = [makePage('p1', address)],
  { deferTabs = false, emitEvents = false }: { deferTabs?: boolean; emitEvents?: boolean } = {},
) {
  const backend = new Map(initial.map((page) => [page.id, page]))
  let resolveTabs!: (list: PageInfo[]) => void
  const startupTabs = deferTabs
    ? new Promise<PageInfo[]>((resolve) => (resolveTabs = resolve))
    : null
  let changed: () => void = () => {}
  let sendTabs: (list: PageInfo[]) => void = () => {}
  let sendReveal: (id: string) => void = () => {}
  const pages: Pages = {
    list: () => [...backend.values()],
    current: () => 'p1',
    has: (id) => backend.has(id),
    open: async ({ url, id, reveal }) => {
      const page = makePage(id ?? `new-${backend.size + 1}`, url ?? '')
      backend.set(page.id, page)
      if (reveal) sendReveal(page.id)
      changed()
      return page
    },
    navigate: async (id, url) => ({ ...backend.get(id)!, url }),
    back: async (id) => backend.get(id)!,
    forward: async (id) => backend.get(id)!,
    reload: async (id) => backend.get(id)!,
    stop: (id) => backend.get(id)!,
    close: (id) => {
      backend.delete(id)
      changed()
    },
    read: async (id) => ({ id, url: backend.get(id)!.url, title: '', text: '', truncated: false }),
    click: async (id) => backend.get(id)!,
    type: async (id) => backend.get(id)!,
    press: async (id) => backend.get(id)!,
    scroll: async (id) => ({ ...backend.get(id)!, atEnd: false }),
    screenshot: async () => new Uint8Array(),
    still: async () => null,
  }
  const registry = createCapabilityRegistry()
  registry.register(BROWSER_NAMESPACES, browserCapabilities(pages))
  changed = emitEvents ? () => queueMicrotask(() => sendTabs(pages.list())) : () => {}
  const context = { remote, root: '/tmp/vault', bundle: null } as CapabilityContext
  dispatch.mockImplementation(({ name, paramsJson }: { name: string; paramsJson?: string }) =>
    name === 'browser.tabs' && startupTabs !== null
      ? startupTabs
      : registry
          .run(name, 'ui', context, paramsJson === undefined ? {} : JSON.parse(paramsJson))
          .then((result) => result.value),
  )
  return {
    backend,
    resolveTabs: () => resolveTabs([...backend.values()]),
    connect: (store: ReturnType<typeof createStore>) => {
      sendTabs = (list) => browserEvents.tabs!({ remote, payload: list }, store)
      sendReveal = (id) => browserEvents.reveal!({ remote, payload: { id } }, store)
    },
    notify: () => sendTabs(pages.list()),
    run: async (name: string, params: Record<string, unknown> = {}, door: 'cli' | 'ui' = 'cli') =>
      (await registry.run(`browser.${name}`, door, context, params)).value,
  }
}

beforeEach(() => {
  dispatch.mockReset()
  const storage = new Map([['holi.browser.addresses', JSON.stringify({ p1: address })]])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
})

test.each(['normally opened', 'restored'] as const)(
  'CLI close retires the shell tab for a %s page',
  async (kind) => {
    const { backend, connect, notify, run } = fixture([], { emitEvents: kind === 'restored' })
    const store = createStore()
    connect(store)
    store.set(activeRemoteAtom, remote)
    if (kind === 'restored') store.set(openSurfaceAtom, 'browser', 'p1')
    const initialPages = store.get(pagesAtom)
    const stop = browserVault(remote, store)
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'browser.tabs' })),
    )
    if (kind === 'normally opened')
      await vi.waitFor(() => expect(store.get(pagesAtom)).not.toBe(initialPages))

    let id: string
    if (kind === 'normally opened') {
      const page = (await run('open', { url: address }, 'ui')) as PageInfo
      id = page.id
      notify()
      await vi.waitFor(() => expect(store.get(pagesAtom).some((p) => p.id === id)).toBe(true))
      store.set(openSurfaceAtom, 'browser', id)
    } else {
      id = 'p1'
      await vi.waitFor(() => expect(backend.has(id)).toBe(true))
      await vi.waitFor(() => expect(store.get(pagesAtom).some((page) => page.id === id)).toBe(true))
    }

    await vi.waitFor(() => expect(store.get(surfaceTabIdsAtom('browser', remote))).toContain(id))
    await run('close', { tab: id })
    if (kind === 'normally opened') notify()
    await vi.waitFor(() =>
      expect(store.get(surfaceTabIdsAtom('browser', remote))).not.toContain(id),
    )
    expect(backend.has(id)).toBe(false)
    expect(store.get(pagesAtom).some((page) => page.id === id)).toBe(false)
    stop()
  },
)

test('a CLI close after a fresh reveal stays closed after the queued tabs event', async () => {
  const { backend, connect, run } = fixture([], { emitEvents: true })
  const store = createStore()
  connect(store)
  store.set(activeRemoteAtom, remote)
  const stop = browserVault(remote, store)
  await vi.waitFor(() =>
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'browser.tabs' })),
  )

  const page = (await run('open', { url: address }, 'cli')) as PageInfo
  await vi.waitFor(() => expect(store.get(pagesAtom).some(({ id }) => id === page.id)).toBe(true))
  await vi.waitFor(() => expect(store.get(surfaceTabIdsAtom('browser', remote))).toContain(page.id))
  await run('close', { tab: page.id })

  await vi.waitFor(() => expect(backend.has(page.id)).toBe(false))
  await vi.waitFor(() => expect(store.get(pagesAtom).some(({ id }) => id === page.id)).toBe(false))
  expect(store.get(surfaceTabIdsAtom('browser', remote))).not.toContain(page.id)
  stop()
})

test('a reveal before the queued tabs event keeps a new page open', async () => {
  const { backend, connect, run } = fixture([], { emitEvents: true })
  const store = createStore()
  connect(store)
  store.set(activeRemoteAtom, remote)
  const stop = browserVault(remote, store)
  await vi.waitFor(() =>
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'browser.tabs' })),
  )

  const page = (await run('open', { url: address }, 'cli')) as PageInfo
  await vi.waitFor(() => expect(store.get(pagesAtom).some(({ id }) => id === page.id)).toBe(true))
  expect(backend.has(page.id)).toBe(true)
  expect(store.get(surfaceTabIdsAtom('browser', remote))).toContain(page.id)
  stop()
})

test('forgets a pending reveal when leaving its vault before the tabs event', async () => {
  const { backend, connect, notify, resolveTabs } = fixture([], { deferTabs: true })
  const store = createStore()
  connect(store)
  store.set(activeRemoteAtom, remote)
  const stop = browserVault(remote, store)
  browserEvents.reveal!({ remote, payload: { id: 'p1' } }, store)
  expect(store.get(surfaceTabIdsAtom('browser', remote))).toEqual(['p1'])
  stop()
  store.set(activeRemoteAtom, 'o/other')
  store.set(activeRemoteAtom, remote)
  const stopAgain = browserVault(remote, store)
  try {
    resolveTabs()
    await vi.waitFor(() => expect(backend.get('p1')?.url).toBe(address))
    notify()
    expect(store.get(surfaceTabIdsAtom('browser', remote))).toEqual(['p1'])
    expect(store.get(pagesAtom)).toMatchObject([{ id: 'p1', url: address }])
  } finally {
    stopAgain()
  }
})

test('startup tabs reconcile remembered shell tabs against a newer tabs event', async () => {
  const { backend, connect, resolveTabs, run } = fixture([], { deferTabs: true, emitEvents: true })
  const store = createStore()
  connect(store)
  store.set(activeRemoteAtom, remote)
  store.set(openSurfaceAtom, 'browser', 'p1')
  const stop = browserVault(remote, store)
  await vi.waitFor(() =>
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'browser.tabs' })),
  )

  const newPage = (await run('open', { url: address }, 'ui')) as PageInfo
  store.set(openSurfaceAtom, 'browser', newPage.id)
  await vi.waitFor(() =>
    expect(store.get(pagesAtom).some((page) => page.id === newPage.id)).toBe(true),
  )
  resolveTabs()

  await vi.waitFor(() => expect(backend.has('p1')).toBe(true))
  expect(store.get(surfaceTabIdsAtom('browser', remote))).toEqual(['p1', newPage.id])
  stop()
})

test('shell close, undo and delayed tabs event reopen the same real capability page', async () => {
  const { backend, connect } = fixture()
  const store = createStore()
  connect(store)
  store.set(activeRemoteAtom, remote)
  store.set(pagesAtom, [makePage('p1', address)])
  store.set(openSurfaceAtom, 'browser', 'p1')
  const stop = browserVault(remote, store)
  await vi.waitFor(() =>
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'browser.tabs' })),
  )

  store.set(closeSurfaceTabAtom, 'browser', 'p1')
  await vi.waitFor(() => expect(backend.has('p1')).toBe(false))
  store.set(openSurfaceAtom, 'browser', 'p1')
  expect(backend.has('p1')).toBe(false)

  // Deliver the delayed event from close only after undo restored the shell id.
  browserEvents.tabs!({ remote, payload: [] }, store)
  await vi.waitFor(() => expect(backend.get('p1')?.url).toBe(address))
  const restored = backend.get('p1')!
  browserEvents.tabs!({ remote, payload: [restored] }, store)

  expect(store.get(surfaceTabIdsAtom('browser', remote))).toEqual(['p1'])
  expect(store.get(pagesAtom)).toMatchObject([{ id: 'p1', url: address, loading: false }])
  expect(backend.get('p1')).toMatchObject({ id: 'p1', url: address })
  stop()
})
