/**
 * Closing panes and switching vaults as atoms, so that a command can drive
 * them. What these pin: a close lands at once, and a switch still asks.
 */
import { atom, createStore } from 'jotai'
import { describe, expect, it } from 'vitest'

import { installedPluginsAtom } from '@/state/plugins'
import { closeActiveTabAtom, closePaneAtom, closeTabAtom } from '@/state/pane-exit'
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
  it('takes the pane at once: a close never waits on motion', () => {
    const store = createStore()
    store.set(workspaceAtom, split())

    store.set(closeTabAtom, 1, 0)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
  })
})

describe('closing a pane', () => {
  it('applies at once', () => {
    const store = createStore()
    store.set(workspaceAtom, split())

    store.set(closePaneAtom, 0)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
    expect(store.get(workspaceAtom).panes[0]!.tabs[0]).toEqual({ kind: 'note', path: 'c.md' })
  })
})

describe('closing a tab that does not empty its pane', () => {
  it('applies at once', () => {
    const store = createStore()
    store.set(workspaceAtom, openPreview(openPreview(emptyWorkspace(), 'a.md'), 'b.md'))

    store.set(closeTabAtom, 0, 1)

    expect(store.get(workspaceAtom).panes[0]!.tabs).toHaveLength(1)
  })
})

describe('⌘W', () => {
  it('closes the focused pane’s active tab', () => {
    const store = createStore()
    store.set(workspaceAtom, split())

    store.set(closeActiveTabAtom)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
  })

  it('takes an empty pane out of a split: ⌘\\ then ⌘W', () => {
    const store = createStore()
    store.set(workspaceAtom, splitPane(openPreview(emptyWorkspace(), 'a.md')))

    store.set(closeActiveTabAtom)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
    expect(store.get(workspaceAtom).active).toBe(0)
  })

  it('does nothing with nothing open', () => {
    const store = createStore()
    const one = emptyWorkspace()
    store.set(workspaceAtom, one)

    store.set(closeActiveTabAtom)

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

  it('switches at once with nothing to ask about, and empties the workspace', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(workspaceAtom, split())

    store.set(switchVaultAtom, 'o/b')

    expect(store.get(activeRemoteAtom)).toBe('o/b')
    expect(store.get(workspaceAtom)).toEqual(emptyWorkspace())
    expect(store.get(leavingVaultAtom)).toBeNull()
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
