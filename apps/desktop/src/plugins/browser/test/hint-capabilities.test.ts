import { presentation } from './hint-presentation'
import { beforeEach, expect, test, vi } from 'vitest'
import { browserHintCapabilities, type BrowserHintPages } from '../main/capabilities'

const owner = {
  tab: 'tab-1',
  nonce: 'document-1',
  attachment: 'attachment-1',
  request: 3,
  origin: 'opaque-request-token',
  snapshot: 1,
  geometry: 0,
}

const pages = {
  discoverHints: vi.fn(async () => ({
    owner,
    targets: [{ id: '0', label: 'Next', x: 4, y: 5 }],
  })),
  presentHints: vi.fn(async () => true),
  clearHints: vi.fn(async () => undefined),
  activateHint: vi.fn(async () => true),
} as unknown as BrowserHintPages
const capabilities = browserHintCapabilities(pages)
beforeEach(() => {
  vi.mocked(pages.discoverHints).mockClear()
  vi.mocked(pages.presentHints).mockClear()
  vi.mocked(pages.clearHints).mockClear()
  vi.mocked(pages.activateHint).mockClear()
})
const call = async (name: keyof typeof capabilities, wire: unknown) => {
  const capability = capabilities[name]
  const params = capability.params(wire)
  return capability.run({} as never, params as never)
}

test('routes parsed scope and nested owner operation arguments to actual handlers', async () => {
  const scope = { tab: owner.tab, nonce: owner.nonce, attachment: owner.attachment, request: 3 }
  expect(await call('browser.hints-discover', scope)).toMatchObject({ owner })
  expect(pages.discoverHints).toHaveBeenCalledWith(scope)
  expect(
    await call('browser.hints-present', {
      owner,
      p: { revision: 1, labels: [{ id: '0', key: 'next' }], theme: 'light', presentation },
    }),
  ).toBe(true)
  expect(pages.presentHints).toHaveBeenCalledWith(
    owner,
    1,
    [{ id: '0', key: 'next' }],
    'light',
    presentation,
  )
  expect(await call('browser.hints-activate', { owner, p: { id: '0' } })).toBe(true)
  expect(pages.activateHint).toHaveBeenCalledWith(owner, '0')
  expect(await call('browser.hints-clear', scope)).toEqual({ cleared: true })
  expect(pages.clearHints).toHaveBeenCalledWith(scope)
})

test('rejects uppercase labels and oversized nested DTOs before handlers', async () => {
  await expect(
    call('browser.hints-present', {
      owner,
      p: { revision: 1, labels: [{ id: '0', key: 'A' }], theme: 'light', presentation },
    }),
  ).rejects.toThrow()
  await expect(
    call('browser.hints-present', {
      owner,
      p: {
        revision: 1,
        labels: Array.from({ length: 201 }, (_, i) => ({ id: String(i), key: 'a' })),
        theme: 'light',
        presentation,
      },
    }),
  ).rejects.toThrow()
  expect(pages.presentHints).not.toHaveBeenCalled()
})

test.each([
  { ...presentation, fontSize: Infinity },
  { ...presentation, height: -1 },
  { ...presentation, color: 'red;position:fixed' },
  { ...presentation, backgroundColor: 'url(https://evil.example)' },
  { ...presentation, fontFamily: 'Arial; background:red' },
  { ...presentation, borderRadius: 1000 },
  { ...presentation, extra: 'arbitrary css' },
])('rejects unbounded or CSS-bearing presentation DTOs', async (invalid) => {
  await expect(
    call('browser.hints-present', {
      owner,
      p: { revision: 1, labels: [], theme: 'light', presentation: invalid },
    }),
  ).rejects.toThrow()
  expect(pages.presentHints).not.toHaveBeenCalled()
})
