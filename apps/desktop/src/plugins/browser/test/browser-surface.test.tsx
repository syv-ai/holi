/**
 * A browser tab (docs/features/browser.md): its address bar, its states, and
 * telling main where the page goes, and that it goes away when hidden.
 */
import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, vimCodeEditingAtom } from '@/plugin-api'
import type { PageInfo } from '../shared/page'
import { BrowserSurface } from '../renderer/browser-surface'
import { browserEvents, pagesAtom, vimModesAtom } from '../renderer/state'

const run = vi.hoisted(() => vi.fn())
const registration = vi.hoisted(() => ({
  adapter: null as null | { discover(request: number, signal: AbortSignal): Promise<unknown> },
}))
vi.mock('@/plugin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugin-api')>()
  return {
    ...actual,
    registerAsyncHostHintAdapter: (
      _owner: HTMLElement,
      adapter: (typeof registration)['adapter'],
    ) => {
      registration.adapter = adapter
      return () => {
        if (registration.adapter === adapter) registration.adapter = null
      }
    },
  }
})
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))

const send = vi.fn()
const openExternal = vi.fn(async () => undefined)

const page = (over: Partial<PageInfo> = {}): PageInfo => ({
  id: 't1',
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  favicon: null,
  error: null,
  ...over,
})

beforeEach(() => {
  registration.adapter = null
  run.mockReset()
  run.mockResolvedValue(page())
  send.mockReset()
  Object.assign(window, {
    holi: { ...(window as { holi?: object }).holi, openExternal, plugin: { send, on: vi.fn() } },
  })
})

function show(pages: PageInfo[], visible = true) {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(pagesAtom, pages)
  const view = render(
    <Provider store={store}>
      <div data-pane data-pane-focused>
        <BrowserSurface id="t1" visible={visible} />
      </div>
    </Provider>,
  )
  return { store, ...view }
}

const calls = (name: string) =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => ({ params: c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson) }))

test('reports actual browser Vim mode and configures the active page from the machine preference', async () => {
  const { store } = show([page()])
  store.set(vimCodeEditingAtom, true)
  act(() =>
    browserEvents['vim-mode']!(
      {
        remote: 'syv/vault',
        payload: { id: 't1', nonce: 'doc-1', attachment: 'attach-1', revision: 3, mode: 'normal' },
      },
      store,
    ),
  )
  expect(screen.getByLabelText('Vim normal mode')).toHaveTextContent('NORMAL')
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      'browser',
      expect.objectContaining({
        remote: 'syv/vault',
        name: 'vim-config',
        payload: expect.objectContaining({
          id: 't1',
          nonce: 'doc-1',
          attachment: 'attach-1',
          enabled: true,
        }),
      }),
    ),
  )
  expect(store.get(vimModesAtom).t1?.mode).toBe('normal')
})

test('a fresh attachment reconfigures Vim even when document and preference stay the same', async () => {
  const { store } = show([page()])
  store.set(vimCodeEditingAtom, true)
  const mode = {
    nonce: 'same-document',
    attachment: 'first-attachment',
    revision: 1,
    mode: 'insert' as const,
  }
  act(() => store.set(vimModesAtom, { t1: mode }))
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  act(() =>
    store.set(vimModesAtom, {
      t1: { ...mode, attachment: 'second-attachment' },
    }),
  )
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect(
    send.mock.calls.map(
      ([, message]) => (message as { payload: { attachment: string } }).payload.attachment,
    ),
  ).toEqual(['first-attachment', 'second-attachment'])
})

test('a page not open yet shows its skeleton', () => {
  show([])
  expect(screen.getByLabelText('Opening the page')).toBeInTheDocument()
})

test('a new tab asks for an address, and going there opens it in this tab', async () => {
  show([page({ url: '', title: '' })])
  expect(screen.getByText('Go anywhere')).toBeInTheDocument()
  const address = screen.getByLabelText('Address')
  await waitFor(() => expect(address).toHaveFocus())
  await userEvent.type(address, 'example.org{Enter}')
  expect(calls('browser.open').at(-1)?.params).toEqual({ tab: 't1', url: 'https://example.org' })
})

test('a page that failed says why, and Retry loads it again', async () => {
  show([
    page({
      error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://nope.invalid/' },
    }),
  ])
  expect(screen.getByText('This page didn’t load')).toBeInTheDocument()
  expect(screen.getByText(/ERR_NAME_NOT_RESOLVED/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(calls('browser.reload').at(-1)?.params).toEqual({ tab: 't1' })
})

test('a restored tabs event puts its address in the surface and enables Reload', async () => {
  const { store } = show([])
  act(() => {
    browserEvents.tabs!(
      {
        remote: 'syv/vault',
        payload: [page({ id: 't1', url: 'https://restored.example/', title: 'Restored' })],
      },
      store,
    )
  })

  expect(screen.getByLabelText('Address')).toHaveValue('https://restored.example/')
  expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
})

test('back, reload and Open in your browser act on this tab', async () => {
  show([page()])
  expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(calls('browser.back').at(-1)?.params).toEqual({ tab: 't1' })
  await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
  expect(calls('browser.reload')).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'Open in your browser' }))
  expect(openExternal).toHaveBeenCalledWith('https://example.com/')
})

test('a loading page offers Stop instead of Reload', () => {
  show([page({ loading: true })])
  expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
})

test('main is told where the page goes, and to take it away when the tab hides', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 50,
    left: 10,
    top: 50,
    right: 810,
    bottom: 650,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  } as DOMRect)
  const { unmount } = show([page()])
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith('browser', {
      remote: 'syv/vault',
      name: 'place',
      payload: { id: 't1', rect: { x: 10, y: 50, width: 800, height: 600 } },
    }),
  )
  act(() => unmount())
  expect(send).toHaveBeenLastCalledWith('browser', {
    remote: 'syv/vault',
    name: 'place',
    payload: { id: 't1', rect: null },
  })
  vi.restoreAllMocks()
})

test('a hidden tab never places its page', async () => {
  show([page()], false)
  await new Promise((r) => setTimeout(r, 50))
  expect(
    send.mock.calls.filter(([, e]) => (e as { payload: { rect: unknown } }).payload.rect !== null),
  ).toEqual([])
})

test('a visibility transition expires an outstanding discovery across an A-B-A return', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 300,
    bottom: 200,
    width: 300,
    height: 200,
    toJSON: () => ({}),
  } as DOMRect)
  let resolve!: (value: unknown) => void
  run.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
  const { store, rerender } = show([page()])
  act(() => {
    store.set(vimCodeEditingAtom, true)
    store.set(vimModesAtom, {
      t1: { nonce: 'doc-1', attachment: 'attach-1', revision: 1, mode: 'normal' },
    })
  })
  await waitFor(() => expect(registration.adapter).not.toBeNull())
  const adapter = registration.adapter!
  const discovery = adapter.discover(55, new AbortController().signal)
  rerender(
    <Provider store={store}>
      <div data-pane data-pane-focused>
        <BrowserSurface id="t1" visible={false} />
      </div>
    </Provider>,
  )
  rerender(
    <Provider store={store}>
      <div data-pane data-pane-focused>
        <BrowserSurface id="t1" visible />
      </div>
    </Provider>,
  )
  resolve({ owner: {}, targets: [{ id: 'late', label: 'Late', x: 1, y: 1 }] })
  expect(await discovery).toBeNull()
  expect(registration.adapter).not.toBeNull()
  vi.restoreAllMocks()
})
