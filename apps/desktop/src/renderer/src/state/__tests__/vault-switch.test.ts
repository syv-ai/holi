/**
 * Switching vaults: a switch asks first when leaving would cost something,
 * and each vault keeps its own tabs.
 */
import { atom, createStore } from 'jotai'
import { describe, expect, it } from 'vitest'

import { installedPluginsAtom } from '@/state/plugins'
import { openTabAtom, shellWorkspaceAtom } from '@/state/shell-tabs'
import { allTabs } from '@/state/shell-workspace'
import { activeRemoteAtom } from '@/state/vaults'
import { applyVaultSwitchAtom, leavingVaultAtom, switchVaultAtom } from '@/state/vault-switch'

/** A test-only plugin for which leaving costs something. */
const busy = (store: ReturnType<typeof createStore>): void =>
  store.set(installedPluginsAtom, [
    {
      info: { id: 'busy', label: 'Busy', default: true },
      leaveGuard: atom<string | null>('A turn is running.'),
    },
  ])

describe('switching vault', () => {
  it('asks first when leaving would cost something, and does not move the remote', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    busy(store)

    store.set(switchVaultAtom, 'o/b')

    expect(store.get(leavingVaultAtom)).toEqual({ kind: 'switch', remote: 'o/b' })
    expect(store.get(activeRemoteAtom)).toBe('o/a')
  })

  it('switches at once with nothing to ask about, to that vault’s own tabs', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(openTabAtom, { kind: 'doc', path: 'a.md' })

    store.set(switchVaultAtom, 'o/b')

    expect(store.get(activeRemoteAtom)).toBe('o/b')
    expect(allTabs(store.get(shellWorkspaceAtom))).toEqual([])
    expect(store.get(leavingVaultAtom)).toBeNull()
    store.set(switchVaultAtom, 'o/a')
    expect(allTabs(store.get(shellWorkspaceAtom))).toEqual(['a.md'])
  })

  it('confirming applies the pending switch and clears the question', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(leavingVaultAtom, { kind: 'switch', remote: 'o/b' })

    store.set(applyVaultSwitchAtom, 'o/b')

    expect(store.get(activeRemoteAtom)).toBe('o/b')
    expect(store.get(leavingVaultAtom)).toBeNull()
  })

  it('is a no-op on the active vault', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    busy(store)

    store.set(switchVaultAtom, 'o/a')

    expect(store.get(leavingVaultAtom)).toBeNull()
  })
})
