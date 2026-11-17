import { presentation } from './hint-presentation'
import { beforeEach, expect, test, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))

import { createBrowserHintAdapter, dispatchBrowserHintEvent } from '../renderer/browser-hints'

let serial = 0
const input = (name: string) =>
  run.mock.calls
    .map(([call]) => call as { name: string; paramsJson?: string })
    .filter((call) => call.name === name)
    .map((call) => (call.paramsJson ? JSON.parse(call.paramsJson) : undefined))

beforeEach(() => {
  run.mockReset()
  run.mockImplementation(({ name, paramsJson }: { name: string; paramsJson?: string }) => {
    const params = paramsJson ? JSON.parse(paramsJson) : undefined
    return Promise.resolve(
      name === 'browser.hints-discover'
        ? {
            owner: { ...params, origin: `opaque-owner-${serial}`, snapshot: 2, geometry: 3 },
            targets: [{ id: 'target-1', label: 'Continue', x: 20, y: 30 }],
          }
        : name === 'browser.hints-activate'
          ? true
          : name === 'browser.hints-present'
            ? true
            : { cleared: true },
    )
  })
})

function setup(current = () => true) {
  const id = ++serial
  const context = {
    remote: `owner/vault-${id}`,
    tab: `tab-${id}`,
    nonce: `doc-${id}`,
    attachment: `attach-${id}`,
    ownerElement: document.createElement('div'),
    current,
  }
  return {
    ...context,
    ownerOrigin: `opaque-owner-${id}`,
    adapter: createBrowserHintAdapter(context),
    event: (
      request: number,
      origin: string,
      type: 'request' | 'cancel' | 'key' | 'revoke',
      extra = {},
    ) =>
      dispatchBrowserHintEvent(context.remote, {
        tab: context.tab,
        nonce: context.nonce,
        attachment: context.attachment,
        request,
        origin,
        type,
        ...(type === 'request' || type === 'cancel' ? {} : { snapshot: 2, geometry: 3 }),
        ...extra,
      }),
  }
}

test('discovers with a page request token and presents/activates the exact opaque owner', async () => {
  const fixture = setup()
  fixture.event(7, 'opaque-request-origin', 'request')
  expect(input('browser.hints-discover')).toHaveLength(0)
  const targets = await fixture.adapter.discover(1, new AbortController().signal)
  expect(targets).toEqual([{ id: 'target-1', label: 'Continue', x: 20, y: 30 }])
  expect(input('browser.hints-discover')).toEqual([
    { tab: fixture.tab, nonce: fixture.nonce, attachment: fixture.attachment, request: 7 },
  ])
  const owner = {
    tab: fixture.tab,
    nonce: fixture.nonce,
    attachment: fixture.attachment,
    request: 7,
    origin: fixture.ownerOrigin,
    snapshot: 2,
    geometry: 3,
  }
  expect(await fixture.adapter.present(1, 1, [{ id: 'target-1', key: 'A' }])).toBe(true)
  expect(input('browser.hints-present')).toEqual([
    { owner, p: { revision: 1, labels: [{ id: 'target-1', key: 'A' }], theme: 'light' } },
  ])
  expect(await fixture.adapter.activate(1, 'target-1')).toBe(true)
  expect(input('browser.hints-activate')).toEqual([{ owner, p: { id: 'target-1' } }])
  expect(input('browser.hints-clear')).toEqual([
    { tab: fixture.tab, nonce: fixture.nonce, attachment: fixture.attachment, request: 7 },
  ])
  fixture.adapter.dispose()
})

test('rejects sibling document and attachment events without assuming origin is a URL', async () => {
  const fixture = setup()
  const requestOrigin = 'opaque-request-origin'
  fixture.event(7, requestOrigin, 'request')
  await fixture.adapter.discover(1, new AbortController().signal)
  let invalidated = 0
  fixture.adapter.subscribe(
    1,
    () => invalidated++,
    () => false,
  )
  dispatchBrowserHintEvent(fixture.remote, {
    tab: 'sibling',
    nonce: fixture.nonce,
    attachment: fixture.attachment,
    request: 7,
    origin: requestOrigin,
    type: 'revoke',
  })
  dispatchBrowserHintEvent(fixture.remote, {
    tab: fixture.tab,
    nonce: 'old',
    attachment: fixture.attachment,
    request: 7,
    origin: requestOrigin,
    type: 'revoke',
  })
  dispatchBrowserHintEvent(fixture.remote, {
    tab: fixture.tab,
    nonce: fixture.nonce,
    attachment: 'old',
    request: 7,
    origin: requestOrigin,
    type: 'revoke',
  })
  fixture.event(8, requestOrigin, 'revoke')
  expect(invalidated).toBe(0)
  expect(input('browser.hints-clear')).toHaveLength(0)
  fixture.adapter.dispose()
})

test('a revoke before discovery retires only its exact page-origin request', () => {
  const fixture = setup()
  fixture.event(7, 'request-token', 'request')
  fixture.event(7, 'other-token', 'revoke')
  expect(input('browser.hints-clear')).toHaveLength(0)
  fixture.event(7, 'request-token', 'revoke')
  expect(input('browser.hints-clear')).toEqual([
    { tab: fixture.tab, nonce: fixture.nonce, attachment: fixture.attachment, request: 7 },
  ])
  fixture.adapter.dispose()
})

test('cancels a request before first discovery without crossing into the next request', async () => {
  const fixture = setup()
  const oldController = new AbortController()
  let unsubscribeOld = () => {}
  const oldInvalidated = vi.fn(() => {
    oldController.abort()
    unsubscribeOld()
  })
  fixture.event(7, 'old-origin', 'request')
  unsubscribeOld = fixture.adapter.subscribe(1, oldInvalidated, () => false)
  fixture.event(7, 'old-origin', 'cancel')
  expect(oldInvalidated).toHaveBeenCalledOnce()
  expect(await fixture.adapter.discover(1, oldController.signal)).toBeNull()
  expect(input('browser.hints-discover')).toHaveLength(0)

  fixture.event(8, 'new-origin', 'request')
  const newInvalidated = vi.fn()
  fixture.adapter.subscribe(2, newInvalidated, () => false)
  expect(await fixture.adapter.discover(2, new AbortController().signal)).toEqual([
    { id: 'target-1', label: 'Continue', x: 20, y: 30 },
  ])
  expect(oldInvalidated).toHaveBeenCalledOnce()
  expect(newInvalidated).not.toHaveBeenCalled()
  expect(input('browser.hints-discover')).toEqual([
    { tab: fixture.tab, nonce: fixture.nonce, attachment: fixture.attachment, request: 8 },
  ])
  fixture.adapter.dispose()
})

test('notifies the owning coordinator before retiring only the revoked request', async () => {
  const fixture = setup()
  fixture.event(7, 'request-token', 'request')
  await fixture.adapter.discover(1, new AbortController().signal)
  const invalidate = vi.fn(() => fixture.adapter.clear(1))
  fixture.adapter.subscribe(1, invalidate, () => false)
  fixture.event(8, 'different-token', 'request')
  await fixture.adapter.discover(2, new AbortController().signal)
  fixture.event(7, fixture.ownerOrigin, 'revoke')
  expect(invalidate).toHaveBeenCalledOnce()
  expect(input('browser.hints-clear')).toEqual([
    { tab: fixture.tab, nonce: fixture.nonce, attachment: fixture.attachment, request: 7 },
  ])
  expect(await fixture.adapter.present(2, 1, [{ id: 'target-1', key: 'B' }])).toBe(true)
  fixture.adapter.dispose()
})

test('adapter disposal invalidates the owning active request before retiring it', async () => {
  const fixture = setup()
  await fixture.adapter.discover(1, new AbortController().signal)
  const invalidate = vi.fn()
  fixture.adapter.subscribe(1, invalidate, () => false)

  fixture.adapter.dispose()

  expect(invalidate).toHaveBeenCalledOnce()
  expect(input('browser.hints-clear')).toEqual([
    { tab: fixture.tab, nonce: fixture.nonce, attachment: fixture.attachment, request: 1 },
  ])
  expect(await fixture.adapter.present(1, 2, [])).toBe(false)
})

test('late cancellation survives failed discovery and snapshot clear until unsubscribe', async () => {
  const fixture = setup()
  let reject!: (reason?: unknown) => void
  run.mockImplementationOnce(() => new Promise((_resolve, fail) => (reject = fail)))
  fixture.event(7, 'failed-origin', 'request')
  const invalidated = vi.fn()
  const unsubscribe = fixture.adapter.subscribe(1, invalidated, () => false)
  const discovery = fixture.adapter.discover(1, new AbortController().signal)
  await Promise.resolve()
  reject(new Error('discovery failed'))
  expect(await discovery).toBeNull()
  fixture.adapter.clear(1)
  fixture.event(7, 'failed-origin', 'cancel')
  expect(invalidated).toHaveBeenCalledOnce()
  fixture.event(7, 'failed-origin', 'cancel')
  expect(invalidated).toHaveBeenCalledOnce()
  unsubscribe()
  fixture.adapter.dispose()
})

test('adapter disposal invalidates a pending discovery without publishing its late result', async () => {
  const fixture = setup()
  let resolve!: (value: unknown) => void
  run.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
  const discovery = fixture.adapter.discover(4, new AbortController().signal)
  const invalidate = vi.fn()
  fixture.adapter.subscribe(4, invalidate, () => false)

  fixture.adapter.dispose()
  resolve({ owner: { request: 7, origin: 'opaque', snapshot: 1, geometry: 0 }, targets: [] })

  expect(invalidate).toHaveBeenCalledOnce()
  expect(await discovery).toBeNull()
  expect(input('browser.hints-clear')).toHaveLength(1)
})

test('disposing an adapter after its request subscription ended cannot invalidate it', async () => {
  const fixture = setup()
  await fixture.adapter.discover(1, new AbortController().signal)
  const invalidate = vi.fn()
  const unsubscribe = fixture.adapter.subscribe(1, invalidate, () => false)
  unsubscribe()

  fixture.adapter.dispose()

  expect(invalidate).not.toHaveBeenCalled()
})

test('aborts delayed discovery and refuses publication after ownership changes', async () => {
  const fixture = setup()
  let resolve!: (value: unknown) => void
  run.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
  const controller = new AbortController()
  const discovery = fixture.adapter.discover(9, controller.signal)
  controller.abort()
  resolve({ owner: { request: 7, origin: 'opaque', snapshot: 1, geometry: 0 }, targets: [] })
  expect(await discovery).toBeNull()
  expect(await fixture.adapter.present(9, 2, [])).toBe(false)
  fixture.adapter.dispose()
})

test('host requests retain their high-water request number across adapter remounts', async () => {
  const fixture = setup()
  await fixture.adapter.discover(1, new AbortController().signal)
  fixture.adapter.dispose()
  const next = createBrowserHintAdapter({
    remote: fixture.remote,
    tab: fixture.tab,
    nonce: fixture.nonce,
    attachment: fixture.attachment,
    ownerElement: fixture.ownerElement,
    current: () => true,
  })
  await next.discover(2, new AbortController().signal)
  expect(input('browser.hints-discover').map(({ request }) => request)).toEqual([1, 2])
  next.dispose()
})

test('a rejected activation clears its captured request even after a new request is discovered', async () => {
  const fixture = setup()
  await fixture.adapter.discover(1, new AbortController().signal)
  let rejectActivation!: (reason?: unknown) => void
  run.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectActivation = reject)))
  const activation = fixture.adapter.activate(1, 'target-1')
  await Promise.resolve()
  await fixture.adapter.discover(2, new AbortController().signal)
  rejectActivation(new Error('native action cancelled'))
  expect(await activation).toBe(false)
  expect(input('browser.hints-clear')).toEqual([
    { tab: fixture.tab, nonce: fixture.nonce, attachment: fixture.attachment, request: 1 },
  ])
  expect(await fixture.adapter.present(2, 1, [{ id: 'target-1', key: 'C' }])).toBe(true)
  fixture.adapter.dispose()
})

test('keeps the exact request key route live until delayed activation settles', async () => {
  const fixture = setup()
  await fixture.adapter.discover(4, new AbortController().signal)
  const wireRequest = input('browser.hints-discover')[0].request as number
  const routed: KeyboardEvent[] = []
  const unsubscribe = fixture.adapter.subscribe(
    4,
    () => undefined,
    (event) => {
      routed.push(event)
      return event.key === 'Escape'
    },
  )
  let finish!: (value: boolean) => void
  run.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const activation = fixture.adapter.activate(4, 'target-1')
  await Promise.resolve()

  fixture.event(wireRequest, fixture.ownerOrigin, 'key', { key: 'Escape', code: 'Escape' })
  expect(routed).toHaveLength(1)
  expect(routed[0]).toMatchObject({ key: 'Escape', code: 'Escape' })
  expect(input('browser.hints-clear')).toHaveLength(0)

  finish(true)
  expect(await activation).toBe(true)
  expect(input('browser.hints-clear')).toHaveLength(1)
  fixture.event(wireRequest, fixture.ownerOrigin, 'key', { key: 'Escape', code: 'Escape' })
  expect(routed).toHaveLength(1)
  unsubscribe()
  fixture.adapter.dispose()
})

test('routes only keys owned by the matching request and opaque origin', async () => {
  const fixture = setup()
  await fixture.adapter.discover(4, new AbortController().signal)
  const wireRequest = input('browser.hints-discover')[0].request as number
  const routed: KeyboardEvent[] = []
  fixture.adapter.subscribe(
    4,
    () => undefined,
    (event) => (routed.push(event), true),
  )
  fixture.event(wireRequest + 1, fixture.ownerOrigin, 'key', { key: 'a', code: 'KeyA' })
  fixture.event(wireRequest, fixture.ownerOrigin, 'key', {
    key: 'stale',
    code: 'KeyS',
    snapshot: 1,
  })
  fixture.event(wireRequest, 'wrong-owner', 'key', { key: 'b', code: 'KeyB' })
  fixture.event(wireRequest, fixture.ownerOrigin, 'key', {
    key: 'x',
    code: 'KeyX',
    ctrlKey: true,
  })
  expect(routed).toHaveLength(1)
  expect(routed[0]).toMatchObject({ key: 'x', code: 'KeyX', ctrlKey: true })
  fixture.adapter.dispose()
})

test.each(['light', 'dark'])(
  'forwards resolved installed Kbd appearance using actual data-theme %s stamp',
  async (theme) => {
    const fixture = setup()
    document.documentElement.dataset.theme = theme
    document.documentElement.classList.remove('dark')
    await fixture.adapter.discover(1, new AbortController().signal)
    expect(await fixture.adapter.present(1, 1, [{ id: 'target-1', key: 'a' }], presentation)).toBe(
      true,
    )
    expect(input('browser.hints-present')[0].p).toEqual({
      revision: 1,
      labels: [{ id: 'target-1', key: 'a' }],
      theme,
      presentation,
    })
    fixture.adapter.dispose()
    delete document.documentElement.dataset.theme
  },
)

test('consumed Escape cancels the selected request during delayed activation and rejects late settlement', async () => {
  const fixture = setup()
  await fixture.adapter.discover(4, new AbortController().signal)
  const wire = input('browser.hints-discover')[0]
  let finish!: (value: boolean) => void
  run.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const activation = fixture.adapter.activate(4, 'target-1')
  const route = vi.fn((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return false
    fixture.adapter.clear(4)
    return true
  })
  fixture.adapter.subscribe(4, () => undefined, route)
  fixture.event(wire.request, fixture.ownerOrigin, 'key', { key: 'Escape' })
  expect(route).toHaveBeenCalledOnce()
  expect(input('browser.hints-clear')).toEqual([wire])
  finish(true)
  expect(await activation).toBe(false)
  expect(input('browser.hints-clear')).toHaveLength(1)
  fixture.adapter.dispose()
})
