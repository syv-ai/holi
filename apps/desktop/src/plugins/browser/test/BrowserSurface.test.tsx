/**
 * A browser tab (docs/features/browser.md): its address bar, its states, and
 * telling main where the page goes, and that it goes away when hidden.
 */
import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import type { PageInfo } from '../shared/page'
import { BrowserSurface } from '../renderer/BrowserSurface'
import { pagesAtom } from '../renderer/state'

const run = vi.hoisted(() => vi.fn())
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
      <BrowserSurface id="t1" visible={visible} />
    </Provider>,
  )
  return { store, ...view }
}

const calls = (name: string) =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson?: string })
    .filter((c) => c.name === name)
    .map((c) => ({ params: c.paramsJson === undefined ? undefined : JSON.parse(c.paramsJson) }))

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
