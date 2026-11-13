/** Real registry surface, tab wrapper, retention hook and frame; only the
 * platform capability transport is replaced. jsdom cannot execute app code. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, screen, waitFor } from '@/test/render'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { mountVaultAppShell } from '@/test/vault-app-shell'
import { APP_SURFACE } from '../renderer/surface'

let platform: FakeHoli
let pendingReply: Promise<unknown> | null = null
const calls = vi.fn((name: string) => {
  if (name === 'apps.grants') return { codeHash: 'h', affordances: [], expiresAt: null }
  if (name === 'apps.archived') return { bundles: [] }
  return { ok: true }
})

beforeEach(() => {
  calls.mockClear()
  pendingReply = null
  platform = installFakeHoli((op) => {
    if (op.path === 'cap.run') {
      const name = (op.input as { name: string }).name
      if (name === 'apps.call' && pendingReply !== null) return pendingReply
      return calls(name)
    }
    return undefined
  })
})
afterEach(() => {
  platform.restore()
  vi.restoreAllMocks()
})

test('actual app documents lazily mount, survive switching and splits, and close/reopen starts fresh', async () => {
  const f = mountVaultAppShell(APP_SURFACE)
  expect(f.frame('One')).toBeNull()
  expect(f.frame('Two')).toBeNull()
  expect(calls).not.toHaveBeenCalledWith('apps.grants')
  f.show()
  await waitFor(() => expect(f.frame('One')).not.toBeNull())
  const one = f.frame('One')!
  expect(screen.getByRole('button', { name: 'Reload this app' })).toBeTruthy()
  f.show(f.paths[1])
  await waitFor(() => expect(f.frame('Two')).not.toBeNull())
  const two = f.frame('Two')!
  expect(f.frame('One')).toBe(one)
  expect(one.closest('[inert]')).not.toBeNull()
  expect(one).toHaveAttribute('tabindex', '-1')
  expect(one).toHaveAttribute('aria-hidden', 'true')
  const outside = screen.getByRole('button', { name: 'Outside app' })
  await act(async () => outside.focus())
  await act(async () => one.focus())
  expect(document.activeElement).toBe(outside)
  f.split()
  expect(f.frame('One')).toBe(one)
  expect(f.frame('Two')).toBe(two)
  for (const frame of [one, two]) {
    expect(frame.closest('[inert]')).toBeNull()
    expect(frame).toHaveAttribute('aria-hidden', 'false')
    expect(frame).toHaveAttribute('tabindex', '0')
  }
  f.separate()
  expect(f.frame('One')).toBe(one)
  expect(f.frame('Two')).toBe(two)
  f.away()
  for (const frame of [one, two]) expect(frame.closest('[inert]')).not.toBeNull()
  f.close()
  expect(one.isConnected).toBe(false)
  f.show()
  await waitFor(() => expect(f.frame('One')).not.toBeNull())
  expect(f.frame('One')).not.toBe(one)
})

test('disablement and vault departure dispose real frames and their bridge listeners', async () => {
  const add = vi.spyOn(window, 'addEventListener')
  const remove = vi.spyOn(window, 'removeEventListener')
  const f = mountVaultAppShell(APP_SURFACE)
  f.show()
  await waitFor(() => expect(f.frame('One')).not.toBeNull())
  const before = f.frame('One')!
  const listeners = add.mock.calls.filter(([type]) => type === 'message')
  expect(listeners.length).toBeGreaterThan(0)
  f.away()
  f.install(false)
  expect(before.isConnected).toBe(false)
  for (const call of listeners) expect(remove.mock.calls).toContainEqual(call)
  f.install(true)
  expect(f.frame('One')).toBeNull()
  f.show()
  await waitFor(() => expect(f.frame('One')).not.toBeNull())
  const next = f.frame('One')!
  expect(next).not.toBe(before)
  f.away()
  f.depart()
  expect(next.isConnected).toBe(false)
  expect(f.frame('One')).toBeNull()
  f.show()
  await waitFor(() => expect(f.frame('One')).not.toBeNull())
  expect(f.frame('One')).not.toBe(next)
  f.unmount()
  expect(f.frame('One')).toBeNull()
})

test.each(['close', 'disable', 'depart', 'unmount'] as const)(
  'a late real transport reply cannot revive a retained app after %s',
  async (disposal) => {
    const f = mountVaultAppShell(APP_SURFACE)
    f.show()
    await waitFor(() => expect(f.frame('One')).not.toBeNull())
    const old = f.frame('One')!
    const post = vi.spyOn(old.contentWindow!, 'postMessage')
    let resolve!: (value: unknown) => void
    pendingReply = new Promise((yes) => {
      resolve = yes
    })
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: old.contentWindow,
          data: { id: 'late', method: 'docs.read', params: { path: 'private.md' } },
        }),
      ),
    )
    await waitFor(() =>
      expect(
        platform.calls.some(
          (op) => op.path === 'cap.run' && (op.input as { name: string }).name === 'apps.call',
        ),
      ).toBe(true),
    )
    f.away()
    if (disposal === 'close') f.close()
    if (disposal === 'disable') f.install(false)
    if (disposal === 'depart') f.depart()
    if (disposal === 'unmount') f.unmount()
    expect(old.isConnected).toBe(false)
    if (disposal !== 'unmount') {
      if (disposal === 'disable') f.install(true)
      f.show()
      await waitFor(() => expect(f.frame('One')).not.toBeNull())
      expect(f.frame('One')).not.toBe(old)
    }
    post.mockClear()
    const nextPost = f.frame('One') ? vi.spyOn(f.frame('One')!.contentWindow!, 'postMessage') : null
    await act(async () => resolve('old vault data'))
    expect(post).not.toHaveBeenCalled()
    if (nextPost) expect(nextPost).not.toHaveBeenCalled()
  },
)
