import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, vimCodeEditingAtom } from '@/plugin-api'
import { createAppHintAdapter } from '../renderer/app-hints'
import { useAppHints } from '../renderer/use-app-hints'
// eslint-disable-next-line no-restricted-imports -- This regression deliberately mounts the production layer.
import { HostHintLayer } from '@/features/shell/host-hint-layer'

const nonce = 'opaque-document-nonce'
const adapters: Array<{ dispose(): void }> = []
const create = (...args: Parameters<typeof createAppHintAdapter>) => {
  const adapter = createAppHintAdapter(...args)
  adapters.push(adapter)
  return adapter
}
const fixture = () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => frame })
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    right: 210,
    bottom: 120,
    width: 200,
    height: 100,
  } as DOMRect)
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 100 })
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 50 })
  return frame
}
const guestMessage = (
  frame: HTMLIFrameElement,
  data: object,
  source: MessageEventSource | null = frame.contentWindow,
) => window.dispatchEvent(new MessageEvent('message', { data: { nonce, ...data }, source }))
const targets = (frame: HTMLIFrameElement, requestId: string, data: unknown[]) =>
  guestMessage(frame, { type: 'targets', requestId, targets: data })

afterEach(() => {
  cleanup()
  for (const adapter of adapters.splice(0)) adapter.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

test('re-enables the same focused frame after window blur and focus', () => {
  const frame = fixture()
  const pane = document.createElement('div')
  pane.dataset.pane = ''
  pane.dataset.paneFocused = ''
  pane.append(frame)
  document.body.append(pane)
  frame.focus()
  const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/repo')
  store.set(vimCodeEditingAtom, true)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const hook = renderHook(
    () =>
      useAppHints({
        frame,
        lease: { nonce, token: 'lease' },
        remote: 'owner/repo',
        bundle: 'app',
        visible: true,
        gateOpen: true,
        loaded: 'app',
        activeRemote: 'owner/repo',
        store,
        authorize: async () => true,
      }),
    { wrapper },
  )
  act(() => window.dispatchEvent(new Event('blur')))
  expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false })
  act(() => window.dispatchEvent(new Event('focus')))
  expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true })
  hook.unmount()
  expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false })
  hasFocus.mockRestore()
})

test('real app hints survive their own portal and activate only through the focused host layer', async () => {
  const frame = fixture()
  const chrome = document.createElement('button')
  chrome.textContent = 'Host action'
  document.body.append(chrome)
  vi.spyOn(chrome, 'getBoundingClientRect').mockReturnValue({
    left: 500,
    top: 20,
    right: 600,
    bottom: 70,
    width: 100,
    height: 50,
  } as DOMRect)
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => (x >= 500 ? chrome : frame),
  })
  const pane = document.createElement('section')
  pane.dataset.pane = ''
  pane.dataset.paneFocused = ''
  pane.append(frame)
  document.body.append(pane)
  frame.focus()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/repo')
  store.set(vimCodeEditingAtom, true)
  let authorize!: (allowed: boolean) => void
  const authorized = new Promise<boolean>((resolve) => (authorize = resolve))
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const Harness = () => {
    useAppHints({
      frame,
      lease: { nonce, token: 'lease' },
      remote: 'owner/repo',
      bundle: 'app',
      visible: true,
      gateOpen: true,
      loaded: 'app',
      activeRemote: 'owner/repo',
      store,
      authorize: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockImplementation(() => authorized),
    })
    return <HostHintLayer scopeKey="integrated-app-hints" />
  }
  const mounted = render(<Harness />, { wrapper })
  frame.focus()
  vi.spyOn(frame.ownerDocument, 'activeElement', 'get').mockReturnValue(frame)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => {
    guestMessage(frame, { type: 'request' })
  })
  const request = post.mock.calls
    .map(([message]) => message as { requestId?: string })
    .find((message) => message.requestId)?.requestId
  expect(request).toBeDefined()
  await act(async () =>
    targets(frame, request!, [
      { id: 'open', label: 'Open note', x: 20, y: 10 },
      ...Array.from({ length: 29 }, (_, index) => ({
        id: `other-${index}`,
        label: `Other ${index}`,
        x: 30,
        y: 10,
      })),
    ]),
  )
  const label = await waitFor(() => {
    const result = document.querySelector('[data-host-hints] [data-hint-target="Open note"]')
    expect(result).not.toBeNull()
    return result as HTMLElement
  })
  await act(async () => {
    pane.setAttribute('data-hint-regression', 'changed')
  })
  expect(document.querySelector('[data-hint-target="Open note"]')).not.toBeNull()
  expect(document.querySelector('[data-hint-target="Host action"]')).toBeNull()
  const key = label.dataset.hintKey!
  expect(key.length).toBeGreaterThan(1)
  const sendKey = (requestId: string, character: string) =>
    guestMessage(frame, {
      type: 'key',
      requestId,
      key: character,
      shift: false,
      repeat: false,
      composing: false,
      modified: false,
    })
  await act(async () => {
    sendKey(request!, key[0]!)
  })
  expect(document.querySelector('[data-host-hints] [data-hint-target="Open note"]')).not.toBeNull()
  for (const character of key.slice(1)) {
    await act(async () => {
      sendKey(request!, character)
    })
  }
  expect(document.querySelector('[data-host-hints]')).not.toBeNull()
  expect(
    post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'activate'),
  ).toHaveLength(0)
  await act(async () => authorize(true))
  await waitFor(() =>
    expect(post.mock.calls.map(([message]) => message)).toContainEqual({
      type: 'activate',
      nonce,
      requestId: request,
      targetId: 'open',
    }),
  )
  await waitFor(() => expect(document.querySelector('[data-host-hints]')).toBeNull())
  expect(
    post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'activate'),
  ).toHaveLength(1)
  await act(async () => {
    guestMessage(frame, { type: 'request' })
  })
  const nextRequest = post.mock.calls
    .map(([message]) => message as { requestId?: string })
    .at(-1)!.requestId!
  await act(async () =>
    targets(frame, nextRequest, [{ id: 'cancel', label: 'Cancel target', x: 20, y: 10 }]),
  )
  await waitFor(() =>
    expect(document.querySelector('[data-hint-target="Cancel target"]')).not.toBeNull(),
  )
  await act(async () => {
    sendKey(nextRequest, 'Escape')
  })
  await waitFor(() => expect(document.querySelector('[data-host-hints]')).toBeNull())
  mounted.unmount()
})

test('accepts bounded targets only from the exact frame and outstanding random request', async () => {
  const frame = fixture()
  const adapter = create(frame, nonce)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const prepared = adapter.prepare!()
  const request = post.mock.calls[0]![0] as { requestId: string; type: string }
  expect(request.type).toBe('holi:vim-app-hints')
  expect(request.requestId).toMatch(/^[\da-f-]{36}$/)
  guestMessage(
    frame,
    {
      type: 'targets',
      requestId: request.requestId,
      targets: [{ id: 'wrong-source', label: 'bad', x: 5, y: 5 }],
    },
    window,
  )
  guestMessage(frame, { type: 'targets', requestId: 'stale', targets: [] })
  targets(frame, request.requestId, [
    { id: 'one', label: 'Open note', x: 20, y: 10 },
    { id: 'one', label: 'duplicate', x: 1, y: 1 },
    { id: 'outside', label: 'outside', x: 101, y: 1 },
  ])
  await prepared
  expect(adapter.discover()).toEqual([
    expect.objectContaining({ label: 'Open note', x: 50, y: 40, token: 'one' }),
  ])
  adapter.invalidate?.()
})

test('routes only guest-requested keys through the subscribed adapter and authorizes activation', async () => {
  const frame = fixture()
  let current = true
  let allowed = true
  const authorize = vi.fn(async () => allowed)
  const adapter = create(frame, nonce, { current: () => current, authorize })
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const route = vi.fn(() => true)
  adapter.subscribe?.(vi.fn(), route)
  const prepared = adapter.prepare!()
  const requestId = (post.mock.calls[0]![0] as { requestId: string }).requestId
  targets(frame, requestId, [{ id: 'target', label: 'Action', x: 10, y: 10 }])
  await prepared
  guestMessage(frame, {
    type: 'key',
    requestId,
    key: 'f',
    shift: false,
    repeat: false,
    composing: false,
    modified: false,
  })
  guestMessage(frame, {
    type: 'key',
    requestId,
    key: 'F2',
    shift: false,
    repeat: false,
    composing: false,
    modified: false,
  })
  guestMessage(frame, {
    type: 'key',
    requestId,
    key: 'x',
    shift: false,
    repeat: false,
    composing: false,
    modified: true,
  })
  expect(route).toHaveBeenCalledTimes(2)
  const action = adapter.activate!({ token: 'target' } as never)
  expect(await action).toBe(true)
  expect(authorize).toHaveBeenCalledTimes(2)
  expect(post.mock.calls.at(-1)?.[0]).toMatchObject({
    type: 'activate',
    requestId,
    targetId: 'target',
  })
  expect(await adapter.activate!({ token: 'target' } as never)).toBe(false)
  allowed = false
  expect(await adapter.activate!({ token: 'target' } as never)).toBe(false)
  current = false
  expect(adapter.unchanged!([])).toBe(false)
  adapter.invalidate?.()
})

test('authenticated Escape cancels pending authorization and discards its late response', async () => {
  const frame = fixture()
  let authorize!: (allowed: boolean) => void
  const adapter = create(frame, nonce, {
    current: () => true,
    authorize: () => new Promise<boolean>((resolve) => (authorize = resolve)),
  })
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const invalidate = vi.fn()
  adapter.subscribe?.(invalidate)
  const pending = adapter.prepare!()
  const requestId = (post.mock.calls[0]![0] as { requestId: string }).requestId
  targets(frame, requestId, [{ id: 'late', label: 'Late target', x: 10, y: 10 }])
  guestMessage(frame, {
    type: 'key',
    requestId,
    key: 'Escape',
    shift: false,
    repeat: false,
    composing: false,
    modified: false,
  })
  await expect(pending).rejects.toThrow('cancelled')
  authorize(true)
  await act(async () => Promise.resolve())
  expect(adapter.discover()).toEqual([])
  expect(invalidate).toHaveBeenCalledOnce()
  expect(post.mock.calls.map(([message]) => message)).toContainEqual(
    expect.objectContaining({ type: 'cancel', requestId }),
  )
  adapter.dispose()
})

test('cancellation, replacement requests and disposal revoke pending preparations', async () => {
  const frame = fixture()
  const adapter = create(frame, nonce)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const pending = adapter.prepare!()
  const oldId = (post.mock.calls[0]![0] as { requestId: string }).requestId
  adapter.cancelPrepare?.()
  await expect(pending).rejects.toThrow('cancelled')
  const fresh = adapter.prepare!()
  const newId = (post.mock.calls.at(-1)![0] as { requestId: string }).requestId
  expect(newId).not.toBe(oldId)
  targets(frame, oldId, [{ id: 'stale', label: 'stale', x: 1, y: 1 }])
  expect(adapter.discover()).toEqual([])
  adapter.invalidate?.()
  await expect(fresh).rejects.toThrow('cancelled')
  expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'cancel', requestId: newId })
})

test('invalidate cancels a request but permits a fresh request and activation', async () => {
  const frame = fixture()
  const adapter = create(frame, nonce)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const invalidated = vi.fn()
  adapter.subscribe?.(invalidated)
  const first = adapter.prepare!()
  const firstId = (post.mock.calls.at(-1)![0] as { requestId: string }).requestId
  adapter.invalidate?.()
  await expect(first).rejects.toThrow('cancelled')
  const second = adapter.prepare!()
  const secondId = (post.mock.calls.at(-1)![0] as { requestId: string }).requestId
  targets(frame, secondId, [{ id: 'again', label: 'Again', x: 10, y: 10 }])
  await second
  expect(secondId).not.toBe(firstId)
  expect(adapter.discover()).toHaveLength(1)
  expect(await adapter.activate!({ token: 'again' } as never)).toBe(true)
  expect(invalidated).toHaveBeenCalled()
})

test('ignores duplicate target responses while authorization is pending', async () => {
  const frame = fixture()
  let authorize!: (allowed: boolean) => void
  const adapter = create(frame, nonce, {
    current: () => true,
    authorize: () => new Promise<boolean>((resolve) => (authorize = resolve)),
  })
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const prepared = adapter.prepare!()
  const id = (post.mock.calls[0]![0] as { requestId: string }).requestId
  targets(frame, id, [{ id: 'first', label: 'First', x: 10, y: 10 }])
  targets(frame, id, [{ id: 'second', label: 'Second', x: 20, y: 20 }])
  authorize(true)
  await prepared
  expect(adapter.discover()).toEqual([expect.objectContaining({ token: 'first' })])
})

test('request monitor cancels when painted host placement changes without mutation', async () => {
  const frame = fixture()
  let left = 10
  vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(
    () => ({ left, top: 20, right: left + 200, bottom: 120, width: 200, height: 100 }) as DOMRect,
  )
  const rafs: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafs.push(callback)
    return rafs.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  const adapter = create(frame, nonce)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const prepared = adapter.prepare!()
  const id = (post.mock.calls[0]![0] as { requestId: string }).requestId
  targets(frame, id, [{ id: 'move', label: 'Move', x: 10, y: 10 }])
  await prepared
  left = 30
  rafs.shift()?.(0)
  expect(adapter.discover()).toEqual([])
  expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'cancel', requestId: id })
})
