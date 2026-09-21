/**
 * The pane exit and the vault switch as atoms (D102), so that a command can
 * drive them. What moved out of Shell was a timer and a confirm; what these
 * pin is that the timing and the asking survived the move.
 */
import { createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../src/renderer/src/lib/motion', () => ({
  prefersReducedMotion: () => motion.reduced,
  motionDurationMs: () => 190,
}))

import { agentSessionsAtom, type AgentSession } from '../src/renderer/src/state/agent'
import {
  closeActiveTabWithExitAtom,
  closePaneWithExitAtom,
  closeTabWithExitAtom,
  leavingPaneAtom,
} from '../src/renderer/src/state/pane-exit'
import {
  emptyWorkspace,
  openPreview,
  splitPane,
  workspaceAtom,
  type Workspace,
} from '../src/renderer/src/state/panes'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import {
  applyVaultSwitchAtom,
  leavingVaultAtom,
  switchVaultAtom,
} from '../src/renderer/src/state/vault-switch'

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

beforeEach(() => {
  vi.useFakeTimers()
  motion.reduced = false
})
afterEach(() => vi.useRealTimers())

describe('closing the last tab of a split', () => {
  it('marks the pane leaving, then applies after the motion duration', () => {
    const store = createStore()
    store.set(workspaceAtom, split())

    store.set(closeTabWithExitAtom, 1, 0)

    expect(store.get(leavingPaneAtom)).toBe(1)
    expect(store.get(workspaceAtom).panes).toHaveLength(2)
    vi.advanceTimersByTime(190)
    expect(store.get(leavingPaneAtom)).toBeNull()
    expect(store.get(workspaceAtom).panes).toHaveLength(1)
    expect(store.get(workspaceAtom).active).toBe(0)
  })

  it('applies at once under reduced motion', () => {
    motion.reduced = true
    const store = createStore()
    store.set(workspaceAtom, split())

    store.set(closeTabWithExitAtom, 1, 0)

    expect(store.get(leavingPaneAtom)).toBeNull()
    expect(store.get(workspaceAtom).panes).toHaveLength(1)
  })

  it('a second close before the first lands replaces the timer rather than doubling it', () => {
    const store = createStore()
    store.set(workspaceAtom, {
      panes: [
        { tabs: [{ kind: 'note', path: 'a.md' }], active: 0 },
        { tabs: [{ kind: 'note', path: 'b.md' }], active: 0 },
        { tabs: [{ kind: 'note', path: 'c.md' }], active: 0 },
      ],
      active: 2,
    })

    store.set(closePaneWithExitAtom, 2)
    vi.advanceTimersByTime(100)
    store.set(closePaneWithExitAtom, 2)
    vi.advanceTimersByTime(190)

    // One pane went for the two gestures that landed on the same one.
    expect(store.get(workspaceAtom).panes).toHaveLength(2)
  })
})

describe('closing a tab that does not empty its pane', () => {
  it('applies at once, no exit', () => {
    const store = createStore()
    store.set(workspaceAtom, openPreview(openPreview(emptyWorkspace(), 'a.md'), 'b.md'))

    store.set(closeTabWithExitAtom, 0, 1)

    expect(store.get(leavingPaneAtom)).toBeNull()
    expect(store.get(workspaceAtom).panes[0]!.tabs).toHaveLength(1)
  })
})

describe('⌘W', () => {
  it('closes the focused pane’s active tab', () => {
    const store = createStore()
    store.set(workspaceAtom, split())

    store.set(closeActiveTabWithExitAtom)
    vi.advanceTimersByTime(190)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
  })

  it('takes an empty pane out of a split: ⌘\\ then ⌘W', () => {
    const store = createStore()
    store.set(workspaceAtom, splitPane(openPreview(emptyWorkspace(), 'a.md')))

    store.set(closeActiveTabWithExitAtom)
    vi.advanceTimersByTime(190)

    expect(store.get(workspaceAtom).panes).toHaveLength(1)
    expect(store.get(workspaceAtom).active).toBe(0)
  })

  it('does nothing with nothing open', () => {
    const store = createStore()
    const one = emptyWorkspace()
    store.set(workspaceAtom, one)

    store.set(closeActiveTabWithExitAtom)

    expect(store.get(workspaceAtom)).toEqual(one)
  })
})

const live = (id: string): AgentSession =>
  ({ id, name: id, state: 'working', exited: false, hadTurn: true }) as AgentSession

describe('switching vault', () => {
  it('asks first when a session would be lost, and does not move the remote', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(agentSessionsAtom, [live('s1')])

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
    store.set(agentSessionsAtom, [live('s1')])

    store.set(switchVaultAtom, 'o/a')

    expect(store.get(leavingVaultAtom)).toBeNull()
  })
})
