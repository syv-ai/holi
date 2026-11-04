/**
 * Closing panes and switching vaults as atoms, so that a command can drive
 * them. A close waits for persistence, not motion; a switch still asks.
 */
import { atom, createStore } from 'jotai'
import { describe, expect, it, vi } from 'vitest'
import { registerBuffer } from '@/lib/buffer-registry'

import { installedPluginsAtom } from '@/state/plugins'
import { closeActiveTabAtom, closeTabAtom } from '@/state/pane-exit'
import {
  emptyWorkspace,
  openPreview,
  splitPane,
  workspaceAtom,
  type Workspace,
} from '@/state/panes'
import { activeRemoteAtom } from '@/state/vaults'
import { applyVaultSwitchAtom, leavingVaultAtom, switchVaultAtom } from '@/state/vault-switch'

/** `a.md` in the left pane, `c.md` alone in the right one, right focused. */
function split(): Workspace {
  return {
    panes: [
      { tabs: [{ kind: 'note', path: 'a.md' }], active: 0 },
      { tabs: [{ kind: 'note', path: 'c.md' }], active: 0 },
    ],
    active: 1,
  }
}

describe('closing the last tab of a split', () => {
  it('takes the pane after saving, without waiting on motion', async () => {
    const store = createStore()
    store.set(workspaceAtom, split())

    await store.set(closeTabAtom, 1, 0)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
  })
})

describe('saving before closing', () => {
  it('keeps the tab mounted until the write completes', async () => {
    const store = createStore()
    store.set(workspaceAtom, split())
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const freeze = vi.fn()
    const unregister = registerBuffer(() => pending, undefined, freeze)
    try {
      const closing = store.set(closeTabAtom, 1, 0)
      expect(store.get(workspaceAtom).panes).toHaveLength(2)
      expect(freeze).toHaveBeenCalledWith(true)
      finish()
      await closing
      expect(store.get(workspaceAtom).panes).toHaveLength(1)
      expect(freeze).toHaveBeenLastCalledWith(false)
    } finally {
      finish()
      unregister()
    }
  })

  it('retains the tab on failure and permits a later close retry', async () => {
    const store = createStore()
    store.set(workspaceAtom, split())
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const freeze = vi.fn()
    const unregister = registerBuffer(save, undefined, freeze)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await store.set(closeActiveTabAtom)
      expect(store.get(workspaceAtom).panes).toHaveLength(2)
      expect(freeze).toHaveBeenLastCalledWith(false)
      await store.set(closeActiveTabAtom)
      expect(store.get(workspaceAtom).panes).toHaveLength(1)
      expect(save).toHaveBeenCalledTimes(2)
    } finally {
      unregister()
      log.mockRestore()
    }
  })
})

describe('closing a tab that does not empty its pane', () => {
  it('applies after saving', async () => {
    const store = createStore()
    store.set(workspaceAtom, openPreview(openPreview(emptyWorkspace(), 'a.md'), 'b.md'))

    await store.set(closeTabAtom, 0, 1)

    expect(store.get(workspaceAtom).panes[0]!.tabs).toHaveLength(1)
  })
})

describe('⌘W', () => {
  it('closes the focused pane’s active tab', async () => {
    const store = createStore()
    store.set(workspaceAtom, split())

    await store.set(closeActiveTabAtom)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
  })

  it('takes an empty pane out of a split: ⌘\\ then ⌘W', async () => {
    const store = createStore()
    store.set(workspaceAtom, splitPane(openPreview(emptyWorkspace(), 'a.md')))

    await store.set(closeActiveTabAtom)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
    expect(store.get(workspaceAtom).active).toBe(0)
  })

  it('does nothing with nothing open', async () => {
    const store = createStore()
    const one = emptyWorkspace()
    store.set(workspaceAtom, one)

    await store.set(closeActiveTabAtom)

    expect(store.get(workspaceAtom)).toEqual(one)
  })
})

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

  it('switches at once with nothing to ask about, and empties the workspace', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(workspaceAtom, split())

    await store.set(switchVaultAtom, 'o/b')

    expect(store.get(activeRemoteAtom)).toBe('o/b')
    expect(store.get(workspaceAtom)).toEqual(emptyWorkspace())
    expect(store.get(leavingVaultAtom)).toBeNull()
  })

  it('confirming applies the pending switch and clears the question', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(leavingVaultAtom, { kind: 'switch', remote: 'o/b' })

    await store.set(applyVaultSwitchAtom, 'o/b')

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
