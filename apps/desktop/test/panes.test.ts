/**
 * What is on screen, as a shape that can grow a second pane.
 *
 * `notes-editor.md` §Panes names the flat `Map<path, …>` as the thing that
 * forecloses split panes and non-note tabs, so the state is `panes[] → tabs[]`
 * and a tab is a discriminated union from the first commit. Plan 5 renders one
 * pane; the shape is the expensive half to undo, not the UI.
 */
import { describe, expect, it } from 'vitest'
import {
  activeTab,
  closeTab,
  emptyWorkspace,
  openTab,
  retargetTab,
  type Workspace,
} from '../src/renderer/src/state/panes'

const paths = (w: Workspace) => w.panes[0]!.tabs.map((t) => (t.kind === 'note' ? t.path : t.kind))

describe('openTab', () => {
  it('focuses a note that is already open instead of opening it twice', () => {
    // The bug this exists to prevent: clicking the same note twice in the tree
    // giving two tabs over one file, each with its own buffer, racing each
    // other's saves onto the same path.
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = openTab(w, { kind: 'note', path: 'b.md' })

    w = openTab(w, { kind: 'note', path: 'a.md' })

    expect(paths(w)).toEqual(['a.md', 'b.md'])
    expect(w.panes[0]!.active).toBe(0)
  })

  it('keeps the board tab distinct from every note', () => {
    let w = openTab(emptyWorkspace(), { kind: 'note', path: 'a.md' })
    w = openTab(w, { kind: 'board' })
    w = openTab(w, { kind: 'board' })

    expect(paths(w)).toEqual(['a.md', 'board'])
  })
})

describe('closeTab', () => {
  it('falls back to the neighbour on the left when the active tab closes', () => {
    let w = emptyWorkspace()
    for (const path of ['a.md', 'b.md', 'c.md']) w = openTab(w, { kind: 'note', path })

    w = closeTab(w, 1) // 'b.md' — 'c.md' is active, so this is not the active one

    expect(paths(w)).toEqual(['a.md', 'c.md'])
    // 'c.md' was active at index 2 and is now at index 1: the active tab must
    // follow the doc, not the number, or closing an unrelated tab silently
    // moves you to a different file.
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'c.md' })
  })

  it('leaves an empty pane rather than removing it', () => {
    // Plan 5 renders one pane, so a pane that deleted itself when its last tab
    // closed would leave nothing to render into. An empty pane IS the
    // empty-editor state.
    let w = openTab(emptyWorkspace(), { kind: 'note', path: 'only.md' })

    w = closeTab(w, 0)

    expect(w.panes).toHaveLength(1)
    expect(paths(w)).toEqual([])
    expect(activeTab(w)).toBeNull()
  })
})

describe('retargetTab', () => {
  it('swaps a renamed note tab in place, leaving indices and other tabs alone', () => {
    let w = emptyWorkspace()
    for (const path of ['a.md', 'x.md']) w = openTab(w, { kind: 'note', path })
    // x.md is active at index 1; renaming a.md must not move the active tab.
    const next = retargetTab(w, 'a.md', 'sub/b.md')

    expect(paths(next)).toEqual(['sub/b.md', 'x.md'])
    expect(activeTab(next)).toEqual({ kind: 'note', path: 'x.md' })
  })

  it('is a no-op when the renamed path is not open', () => {
    const w = openTab(emptyWorkspace(), { kind: 'note', path: 'a.md' })
    expect(retargetTab(w, 'ghost.md', 'other.md')).toEqual(w)
  })
})
