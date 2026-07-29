/**
 * `historyTargetPathAtom` — which file the history drawer follows. It keys off the
 * focused workspace tab (NOT `activeDocAtom`, which follows opening a note, not
 * focusing a tab), so switching between open tabs swaps the timeline.
 */
import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'
import { historyTargetPathAtom } from '../src/renderer/src/state/history'
import { workspaceAtom, type Tab, type Workspace } from '../src/renderer/src/state/panes'

const ws = (tabs: Tab[], active = tabs.length - 1): Workspace => ({
  panes: [{ tabs, active }],
  active: 0,
})

describe('historyTargetPathAtom', () => {
  it('follows the focused tab, not the last-opened doc', () => {
    const store = createStore()
    const tabs: Tab[] = [
      { kind: 'note', path: 'a.md' },
      { kind: 'note', path: 'b.md' },
    ]
    store.set(workspaceAtom, ws(tabs, 0))
    expect(store.get(historyTargetPathAtom)).toBe('a.md')
    store.set(workspaceAtom, ws(tabs, 1))
    expect(store.get(historyTargetPathAtom)).toBe('b.md')
  })

  it('is null for the board, a task file, or a non-markdown file', () => {
    const store = createStore()
    const target = (tab: Tab) => {
      store.set(workspaceAtom, ws([tab], 0))
      return store.get(historyTargetPathAtom)
    }
    expect(target({ kind: 'board' })).toBeNull()
    expect(target({ kind: 'note', path: 'task.foo.md' })).toBeNull()
    expect(target({ kind: 'note', path: 'diagram.png' })).toBeNull()
    expect(target({ kind: 'note', path: 'notes/plan.md' })).toBe('notes/plan.md')
  })

  it('is null when the pane has no active tab', () => {
    const store = createStore()
    store.set(workspaceAtom, { panes: [{ tabs: [], active: -1 }], active: 0 })
    expect(store.get(historyTargetPathAtom)).toBeNull()
  })
})
