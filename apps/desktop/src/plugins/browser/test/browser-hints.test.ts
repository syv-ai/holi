import { beforeEach, expect, test, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))

import { createBrowserHintAdapter, dispatchBrowserHintEvent } from '../renderer/browser-hints'

const owner = document.createElement('div')
const scope = { tab: 'tab-1', nonce: 'doc-1', attachment: 'attach-1', request: 7 }
const result = {
  owner: { ...scope, origin: 'https://example.test', snapshot: 2, geometry: 3 },
  targets: [{ id: 'target-1', label: 'Continue', x: 20, y: 30 }],
}
const input = (name: string) =>
  run.mock.calls
    .map(([call]) => call as { name: string; paramsJson?: string })
    .filter((call) => call.name === name)
    .map((call) => (call.paramsJson ? JSON.parse(call.paramsJson) : undefined))

beforeEach(() => {
  run.mockReset()
  run.mockImplementation(({ name, paramsJson }: { name: string; paramsJson?: string }) =>
    Promise.resolve(
      name === 'browser.hints-discover'
        ? {
            ...result,
            owner: { ...result.owner, ...(paramsJson ? JSON.parse(paramsJson) : {}) },
          }
        : name === 'browser.hints-activate'
          ? true
          : name === 'browser.hints-present'
            ? true
            : { cleared: true },
    ),
  )
})

function setup(current = () => true) {
  return createBrowserHintAdapter({
    remote: 'owner/vault',
    tab: 'tab-1',
    nonce: 'doc-1',
    attachment: 'attach-1',
    origin: 'https://example.test',
    ownerElement: owner,
    current,
  })
}

test('discovers in page scope and routes the exact owned snapshot through present and activate', async () => {
  const adapter = setup()
  const controller = new AbortController()
  const targets = await adapter.discover(1, controller.signal)
  expect(targets).toEqual([{ id: 'target-1', label: 'Continue', x: 20, y: 30 }])
  const discoveredScope = input('browser.hints-discover')[0] as typeof scope
  expect(discoveredScope).toMatchObject({
    tab: scope.tab,
    nonce: scope.nonce,
    attachment: scope.attachment,
  })
  const owner = { ...result.owner, ...discoveredScope }
  expect(await adapter.present(1, 1, [{ id: 'target-1', key: 'A' }])).toBe(true)
  expect(input('browser.hints-present')).toEqual([
    {
      owner,
      p: {
        revision: 1,
        labels: [{ id: 'target-1', key: 'A' }],
        theme: 'light',
      },
    },
  ])
  expect(await adapter.activate(1, 'target-1')).toBe(true)
  expect(input('browser.hints-activate')).toEqual([{ owner, p: { id: 'target-1' } }])
  adapter.dispose()
})

test('ignores sibling, old document, attachment and origin events', () => {
  const adapter = setup()
  let invalidate = 0
  adapter.subscribe(
    1,
    () => invalidate++,
    () => false,
  )
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    tab: 'other',
    origin: 'https://example.test',
    type: 'revoke',
  })
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    nonce: 'old',
    origin: 'https://example.test',
    type: 'revoke',
  })
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    attachment: 'old',
    origin: 'https://example.test',
    type: 'revoke',
  })
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    origin: 'https://sibling.test',
    type: 'revoke',
  })
  expect(invalidate).toBe(0)
  adapter.dispose()
})

test('aborts pending discovery and refuses publication after ownership changes', async () => {
  let resolve!: (value: typeof result) => void
  run.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  let alive = true
  const adapter = setup(() => alive)
  const controller = new AbortController()
  const discovery = adapter.discover(9, controller.signal)
  alive = false
  controller.abort()
  resolve(result)
  expect(await discovery).toBeNull()
  expect(await adapter.present(9, 2, [])).toBe(false)
  adapter.dispose()
})

test('host-origin requests continue the wire high-water across adapter remounts', async () => {
  const first = setup()
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    origin: 'https://example.test',
    type: 'request',
  })
  await first.discover(1, new AbortController().signal)
  first.dispose()
  const next = setup()
  await next.discover(2, new AbortController().signal)
  expect(input('browser.hints-discover')).toEqual([scope, { ...scope, request: 8 }])
  next.dispose()
})

test('an earlier request clear cannot clear a later ownership scope', async () => {
  const adapter = setup()
  await adapter.discover(1, new AbortController().signal)
  const oldScope = input('browser.hints-discover')[0]
  adapter.clear(1)
  await adapter.discover(2, new AbortController().signal)
  expect(input('browser.hints-clear')).toEqual([oldScope])
  expect(await adapter.present(2, 1, [{ id: 'target-1', key: 'B' }])).toBe(true)
  adapter.dispose()
})

test('routes only keys for the current owner and request to the host interpreter', async () => {
  const adapter = setup()
  await adapter.discover(4, new AbortController().signal)
  const routed: KeyboardEvent[] = []
  const unsubscribe = adapter.subscribe(
    4,
    () => undefined,
    (event) => {
      routed.push(event)
      return true
    },
  )
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    request: 8,
    origin: 'https://example.test',
    type: 'key',
    key: 'a',
    code: 'KeyA',
  })
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    origin: 'https://other.test',
    type: 'key',
    key: 'b',
    code: 'KeyB',
  })
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    origin: 'https://example.test',
    type: 'key',
    key: 'x',
    code: 'KeyX',
    ctrlKey: true,
  })
  expect(routed).toHaveLength(1)
  expect(routed[0]).toMatchObject({ key: 'x', code: 'KeyX', ctrlKey: true })
  unsubscribe()
  adapter.dispose()
})

test('page-origin request reuses its wire request number', async () => {
  const adapter = setup()
  dispatchBrowserHintEvent('owner/vault', {
    ...scope,
    origin: 'https://example.test',
    type: 'request',
  })
  const request = run.mock.calls
  expect(request).toHaveLength(0)
  const promise = adapter.discover(3, new AbortController().signal)
  expect(await promise).toEqual([{ id: 'target-1', label: 'Continue', x: 20, y: 30 }])
  expect(input('browser.hints-discover')).toEqual([scope])
  adapter.dispose()
})
