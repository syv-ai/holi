import { act, renderHook, waitFor } from '@/test/render'
import { emptyVaultSnapshot, THEME_FILE, THEME_LOCAL_FILE, type ResolvedTheme } from '@holi/shared'
import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVaultTheme } from '../vault-theme'
import { colorSchemeAtom } from '../color-scheme'
import { activeRemoteAtom, snapshotAtom } from '../vaults'

const readTheme = vi.fn<(input: { remote: string }) => Promise<ResolvedTheme>>()
vi.mock('@/lib/trpc', () => ({
  trpc: { theme: { read: { query: (input: { remote: string }) => readTheme(input) } } },
}))

const resolved = (light: Record<string, string>, dark: Record<string, string>) => ({
  light,
  dark,
  warnings: [],
})

function setup(remote = 'owner/first') {
  const store = createStore()
  store.set(activeRemoteAtom, remote)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const hook = renderHook(() => useVaultTheme(), { wrapper })
  return { store, ...hook }
}

function files(store: ReturnType<typeof createStore>, committed?: string, local?: string) {
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: [
      ...(committed === undefined ? [] : [{ path: THEME_FILE, updatedAt: committed }]),
      ...(local === undefined ? [] : [{ path: THEME_LOCAL_FILE, updatedAt: local }]),
    ] as never,
  })
}

afterEach(() => {
  readTheme.mockReset()
  document.documentElement.style.removeProperty('--primary')
  document.documentElement.style.removeProperty('--radius')
})

describe('useVaultTheme', () => {
  it('loads per-vault themes, follows mode and both theme file fingerprints, and clears deleted tokens', async () => {
    readTheme.mockResolvedValueOnce(
      resolved({ primary: 'lightblue' }, { primary: 'darkred', radius: '1rem' }),
    )
    const { store } = setup()
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('darkred'),
    )

    readTheme.mockResolvedValueOnce(resolved({ primary: 'lightblue' }, { primary: 'darkred' }))
    act(() => store.set(colorSchemeAtom, 'light'))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('lightblue'),
    )
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('')

    readTheme.mockResolvedValueOnce(resolved({ primary: 'newlocal' }, { primary: 'darkred' }))
    act(() => files(store, 'one', 'two'))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('newlocal'),
    )

    readTheme.mockResolvedValueOnce(resolved({}, {}))
    act(() => files(store, 'one'))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(''),
    )
    expect(readTheme).toHaveBeenCalledTimes(4)
  })

  it('fences a slow previous vault read after switching and signing out', async () => {
    let resolveFirst!: (value: ReturnType<typeof resolved>) => void
    readTheme.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
    const { store } = setup()
    readTheme.mockResolvedValueOnce(resolved({}, { primary: 'second' }))
    act(() => store.set(activeRemoteAtom, 'owner/second'))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('second'),
    )

    await act(async () => resolveFirst(resolved({}, { primary: 'stale' })))
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('second')
    act(() => store.set(activeRemoteAtom, null))
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })

  it('does not apply an asynchronous result after unmount', async () => {
    let resolve!: (value: ReturnType<typeof resolved>) => void
    readTheme.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const hook = setup()
    hook.unmount()
    await act(async () => resolve(resolved({}, { primary: 'late' })))
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })
})
