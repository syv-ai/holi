/** Switching vaults keeps each vault's workspace and flushes before departure. */
import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'
import { openTabAtom, shellWorkspaceAtom, workspaceOfAtom } from '@/state/shell-tabs'
import { allTabs } from '@/state/shell-workspace'
import { activeRemoteAtom } from '@/state/vaults'
import { switchVaultAtom } from '@/state/vault-switch'

describe('switching vault', () => {
  it('switches without stopping background sessions and preserves each vault’s tabs', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(openTabAtom, { kind: 'doc', path: 'a.md' })

    await store.set(switchVaultAtom, 'o/b')

    expect(store.get(activeRemoteAtom)).toBe('o/b')
    expect(allTabs(store.get(shellWorkspaceAtom))).toEqual([])
    await store.set(switchVaultAtom, 'o/a')
    expect(allTabs(store.get(workspaceOfAtom)('o/a'))).toEqual(['a.md'])
  })

  it('does not change selection when the requested vault is already active', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    await store.set(switchVaultAtom, 'o/a')
    expect(store.get(activeRemoteAtom)).toBe('o/a')
  })
})
