import { createStore } from 'jotai'
import { describe, expect, it, vi } from 'vitest'
import type { RendererPlugin } from '@/state/plugin-types'
import { hostPluginVaults, installedPluginsAtom } from '@/state/plugins'
import { activeRemoteAtom, openedRemoteAtom } from '../vaults'

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

    store.set(openedRemoteAtom, 'owner/a')
    store.set(activeRemoteAtom, 'owner/a')
    expect(vault).toHaveBeenCalledWith('owner/a', store)

    store.set(activeRemoteAtom, 'owner/b')
    expect(stopVault).toHaveBeenCalledOnce()
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
