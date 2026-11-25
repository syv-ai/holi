import { readyVaultAtom } from '@/plugin-api'
import { emptyVaultSnapshot } from '@holi/shared'
import { createStore } from 'jotai'
import { describe, expect, it, vi } from 'vitest'
import type { RendererPlugin } from '@/state/plugin-types'
import { hostPluginVaults, installedPluginsAtom } from '@/state/plugins'
import { activeRemoteAtom, openedRemoteAtom, loadVaultsAtom, openVaultAtom } from '../vaults'

describe('hostPluginVaults', () => {
  it('starts enabled vault hooks only after main finishes opening the active vault', () => {
    const store = createStore()
    const stopVault = vi.fn()
    const vault = vi.fn(() => stopVault)
    const plugin = {
      info: { id: 'review', label: 'Review', default: true },
      vault,
    } as unknown as RendererPlugin
    store.set(installedPluginsAtom, [plugin])
    const stop = hostPluginVaults(store)

    store.set(activeRemoteAtom, 'owner/a')
    store.set(openedRemoteAtom, 'owner/a')
    expect(vault).toHaveBeenCalledWith('owner/a', store)

    store.set(activeRemoteAtom, 'owner/b')
    expect(stopVault).toHaveBeenCalledOnce()
    expect(vault).toHaveBeenCalledTimes(1)
    // A late completion from the prior vault is not readiness for B.
    store.set(openedRemoteAtom, 'owner/a')
    expect(vault).toHaveBeenCalledTimes(1)

    // The switch's main open is still pending. Do not start B's plugin watch
    // until its completion signal arrives; then returning to A does the same.
    store.set(openedRemoteAtom, 'owner/b')
    expect(vault).toHaveBeenLastCalledWith('owner/b', store)
    store.set(activeRemoteAtom, 'owner/a')
    expect(stopVault).toHaveBeenCalledTimes(2)
    expect(vault).toHaveBeenCalledTimes(2)
    store.set(openedRemoteAtom, 'owner/a')
    expect(vault).toHaveBeenLastCalledWith('owner/a', store)

    stop()
  })
})

vi.mock('@/lib/trpc', () => ({
  trpc: {
    vaults: {
      list: {
        query: async () => [{ remote: 'owner/a', name: 'a', path: '/unused', lastOpenedAt: '' }],
      },
      open: { mutate: () => open() },
    },
  },
}))
const open = vi.fn()

it('projects readiness only for completed public opens, including a same-vault reopen', async () => {
  const store = createStore()
  await store.set(loadVaultsAtom)
  expect(store.get(readyVaultAtom)).toBeNull()
  let complete!: () => void
  let started!: () => void
  let openingStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  open.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = () => resolve(emptyVaultSnapshot())
        started()
      }),
  )
  const firstOpen = store.set(openVaultAtom, 'owner/a')
  await openingStarted
  expect(store.get(readyVaultAtom)).toBeNull()
  complete()
  await firstOpen
  const first = store.get(readyVaultAtom)
  expect(first?.remote).toBe('owner/a')
  openingStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const reopening = store.set(openVaultAtom, 'owner/a')
  await openingStarted
  expect(store.get(readyVaultAtom)).toBeNull()
  complete()
  await reopening
  expect(store.get(readyVaultAtom)?.remote).toBe('owner/a')
  expect(store.get(readyVaultAtom)).not.toBe(first)
})
