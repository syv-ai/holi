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
  activePane,
  activeTab,
  closePane,
  closeTab,
  closeTabsForPaths,
  emptyWorkspace,
  openApp,
  openBoard,
  openInNewPane,
  openPinned,
  openPreview,
  openSingleton,
  openTab,
  pinActive,
  pinTab,
  retargetAppTab,
  retargetTab,
  retargetTabs,
  splitPane,
  focusPane,
  moveTab,
  moveTabToNewPane,
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

  it('preserves the preview flag across a rename', () => {
    const w = openPreview(emptyWorkspace(), 'a.md')
    const next = retargetTab(w, 'a.md', 'b.md')
    expect(next.panes[0]!.tabs).toEqual([{ kind: 'note', path: 'b.md', preview: true }])
  })
})

const tabs = (w: Workspace) => w.panes[0]!.tabs

describe('preview vs pinned', () => {
  it('replaces the preview tab when browsing, so it costs one tab', () => {
    let w = openPreview(emptyWorkspace(), 'a.md')
    w = openPreview(w, 'b.md')
    expect(tabs(w)).toEqual([{ kind: 'note', path: 'b.md', preview: true }])
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'b.md', preview: true })
  })

  it('focuses an already-open path instead of duplicating it', () => {
    let w = openPinned(emptyWorkspace(), 'a.md')
    w = openPreview(w, 'b.md') // pinned a.md + preview b.md
    w = openPreview(w, 'a.md') // clicking a.md again just focuses it
    expect(tabs(w)).toEqual([
      { kind: 'note', path: 'a.md' },
      { kind: 'note', path: 'b.md', preview: true },
    ])
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'a.md' })
  })

  it('keeps a pinned tab and adds a preview beside it', () => {
    let w = openPinned(emptyWorkspace(), 'a.md')
    w = openPreview(w, 'b.md')
    expect(tabs(w)).toEqual([
      { kind: 'note', path: 'a.md' },
      { kind: 'note', path: 'b.md', preview: true },
    ])
  })

  it('pinActive clears the preview flag on the active tab', () => {
    const w = pinActive(openPreview(emptyWorkspace(), 'a.md'))
    expect(tabs(w)).toEqual([{ kind: 'note', path: 'a.md' }])
  })

  it('openPinned pins an existing preview tab in place', () => {
    let w = openPreview(emptyWorkspace(), 'a.md')
    w = openPinned(w, 'a.md')
    expect(tabs(w)).toEqual([{ kind: 'note', path: 'a.md' }])
  })

  it('pinTab is a no-op on an out-of-range index', () => {
    const w = openPreview(emptyWorkspace(), 'a.md')
    expect(pinTab(w, 5)).toEqual(w)
  })
})

describe('retargetTabs', () => {
  it('points every open tab at its moved path, across panes, leaving others alone', () => {
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = openTab(w, { kind: 'note', path: 'keep.md' })
    w = retargetTabs(w, [{ from: 'a.md', to: 'sub/a.md' }])
    expect(w.panes[0]!.tabs).toEqual([
      { kind: 'note', path: 'sub/a.md' },
      { kind: 'note', path: 'keep.md' },
    ])
  })
})

describe('closeTabsForPaths', () => {
  it('closes deleted tabs and keeps the user on a surviving document', () => {
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'a.md' }) // idx 0
    w = openTab(w, { kind: 'note', path: 'b.md' }) // idx 1
    w = openTab(w, { kind: 'note', path: 'c.md' }) // idx 2, active
    w = closeTabsForPaths(w, ['a.md']) // delete one to the left of active
    expect(w.panes[0]!.tabs).toEqual([
      { kind: 'note', path: 'b.md' },
      { kind: 'note', path: 'c.md' },
    ])
    expect(w.panes[0]!.active).toBe(1) // still on c.md
  })

  it('falls back to a neighbour when the active tab is deleted, and empties cleanly', () => {
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = openTab(w, { kind: 'note', path: 'b.md' }) // active
    expect(closeTabsForPaths(w, ['b.md']).panes[0]!.active).toBe(0)
    expect(closeTabsForPaths(w, ['a.md', 'b.md']).panes[0]).toEqual({ tabs: [], active: -1 })
  })
})

describe('openApp', () => {
  it('opens an app tab and focuses it', () => {
    const w = openApp(emptyWorkspace(), 'retro')
    expect(w.panes[0]!.tabs).toEqual([{ kind: 'app', appId: 'retro' }])
    expect(w.panes[0]!.active).toBe(0)
  })

  it('focuses an app that is already open instead of opening it twice', () => {
    // Same rule as a note, for the same reason: two frames over one app are two
    // running copies of it, and the second one is not the one you were looking at.
    let w = openApp(emptyWorkspace(), 'retro')
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = openApp(w, 'retro')
    expect(w.panes[0]!.tabs).toHaveLength(2)
    expect(w.panes[0]!.active).toBe(0)
  })

  it('keeps two different apps apart', () => {
    let w = openApp(emptyWorkspace(), 'a')
    w = openApp(w, 'b')
    expect(w.panes[0]!.tabs).toEqual([
      { kind: 'app', appId: 'a' },
      { kind: 'app', appId: 'b' },
    ])
    expect(w.panes[0]!.active).toBe(1)
  })

  it('behaves like any other tab when closed', () => {
    let w = openApp(emptyWorkspace(), 'retro')
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = closeTab(w, 0)
    expect(w.panes[0]!.tabs).toEqual([{ kind: 'note', path: 'a.md' }])
  })

  it('is not a singleton — the type says so', () => {
    // The regression this reshape exists to prevent. SingletonTab used to be
    // DERIVED (`Exclude<Tab, {kind:'note'}>['kind']`), which quietly meant
    // "every non-note tab is unique" — so this call would have typechecked and
    // opened a tab with no appId at all.
    // @ts-expect-error 'app' is not a singleton surface
    openSingleton(emptyWorkspace(), 'app')
  })
})

describe('retargetAppTab', () => {
  const kinds = (w: Workspace) =>
    w.panes[0]!.tabs.map((t) => (t.kind === 'app' ? `app:${t.appId}` : t.kind))

  it('follows a renamed app to its new id, in place', () => {
    let w = emptyWorkspace()
    w = openApp(w, 'retro')
    w = openApp(w, 'burndown')

    const next = retargetAppTab(w, 'retro', 'standup')

    expect(kinds(next)).toEqual(['app:standup', 'app:burndown'])
    // The active selection is untouched — the user stays on what they were on.
    expect(next.panes[0]!.active).toBe(w.panes[0]!.active)
  })

  it('leaves a note tab whose path merely mentions the id alone', () => {
    // The app id is a directory name, not a path: a note called `retro.md` is
    // not the app, and a rename must not touch it.
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'retro.md' })

    expect(retargetAppTab(w, 'retro', 'standup')).toEqual(w)
  })

  it('is a no-op when the renamed app has no tab open', () => {
    let w = emptyWorkspace()
    w = openApp(w, 'burndown')

    expect(retargetAppTab(w, 'retro', 'standup')).toEqual(w)
  })
})

/* ── Panes ──────────────────────────────────────────────────────────────── */

/** A workspace of two panes: `a.md`+`b.md` on the left, `c.md` on the right. */
function split(): Workspace {
  return {
    panes: [
      { tabs: [{ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'b.md' }], active: 1 },
      { tabs: [{ kind: 'note', path: 'c.md' }], active: 0 },
    ],
    active: 0,
  }
}

const layout = (w: Workspace) =>
  w.panes.map((p) => p.tabs.map((t) => (t.kind === 'note' ? t.path : t.kind)))

describe('splitPane', () => {
  it('adds an empty pane beside the active one and focuses it', () => {
    const w = splitPane(openPreview(emptyWorkspace(), 'a.md'))

    expect(layout(w)).toEqual([['a.md'], []])
    expect(w.active).toBe(1)
    expect(activeTab(w)).toBeNull()
  })

  it('does NOT duplicate the active tab', () => {
    // The one-buffer rule: two views of one path are two EditorPanes each
    // autosaving over it. VS Code can copy; this cannot.
    const w = splitPane(openPreview(emptyWorkspace(), 'a.md'))

    expect(layout(w).flat().filter((p) => p === 'a.md')).toHaveLength(1)
  })

  it('inserts beside the active pane, not at the end', () => {
    const w = splitPane(split())

    expect(w.panes).toHaveLength(3)
    expect(layout(w)).toEqual([['a.md', 'b.md'], [], ['c.md']])
    expect(w.active).toBe(1)
  })
})

describe('openInNewPane', () => {
  it('opens the tab in a fresh pane beside the active one', () => {
    const w = openInNewPane(openPreview(emptyWorkspace(), 'a.md'), { kind: 'note', path: 'b.md' })

    expect(layout(w)).toEqual([['a.md'], ['b.md']])
    expect(w.active).toBe(1)
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'b.md' })
  })

  it('focuses the existing tab rather than opening a second copy', () => {
    // Safe to hit twice, and safe to hit on something already open elsewhere.
    const w = openInNewPane(split(), { kind: 'note', path: 'c.md' })

    expect(layout(w)).toEqual([['a.md', 'b.md'], ['c.md']])
    expect(w.active).toBe(1)
  })
})

describe('one buffer per file, across panes', () => {
  it('openPreview focuses a note already open in another pane', () => {
    const w = openPreview(split(), 'c.md')

    expect(layout(w)).toEqual([['a.md', 'b.md'], ['c.md']])
    expect(w.active).toBe(1)
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'c.md' })
  })

  it('openPinned pins it where it already is', () => {
    const w = openPinned(
      { panes: [{ tabs: [], active: -1 }, { tabs: [{ kind: 'note', path: 'c.md', preview: true }], active: 0 }], active: 0 },
      'c.md',
    )

    expect(w.active).toBe(1)
    expect(w.panes[1]!.tabs[0]).toEqual({ kind: 'note', path: 'c.md' })
  })

  it('openApp focuses an app already open in another pane', () => {
    const w = openApp(
      { panes: [{ tabs: [], active: -1 }, { tabs: [{ kind: 'app', appId: 'dash' }], active: 0 }], active: 0 },
      'dash',
    )

    expect(w.panes.flatMap((p) => p.tabs)).toHaveLength(1)
    expect(w.active).toBe(1)
  })

  it('a singleton surface is one for the whole workspace', () => {
    const w = openBoard({ panes: [{ tabs: [], active: -1 }, { tabs: [{ kind: 'board' }], active: 0 }], active: 0 })

    expect(w.panes.flatMap((p) => p.tabs)).toEqual([{ kind: 'board' }])
    expect(w.active).toBe(1)
  })
})

describe('closePane', () => {
  it('removes the pane and lands on its neighbour', () => {
    const w = closePane(split(), 1)

    expect(layout(w)).toEqual([['a.md', 'b.md']])
    expect(w.active).toBe(0)
  })

  it('keeps focus on the same pane when an earlier one goes', () => {
    const w = closePane({ ...split(), active: 1 }, 0)

    expect(layout(w)).toEqual([['c.md']])
    expect(w.active).toBe(0)
  })

  it('never removes the last pane — an empty pane is a state, no panes is not', () => {
    const one = emptyWorkspace()

    expect(closePane(one, 0)).toEqual(one)
  })
})

describe('closing the last tab of a split', () => {
  it('takes the pane with it — that is how you unsplit', () => {
    const w = closeTab({ ...split(), active: 1 }, 0)

    expect(layout(w)).toEqual([['a.md', 'b.md']])
    expect(w.active).toBe(0)
  })

  it('but the only pane stays, empty', () => {
    const w = closeTab(openPreview(emptyWorkspace(), 'a.md'), 0)

    expect(w.panes).toHaveLength(1)
    expect(activePane(w)).toEqual({ tabs: [], active: -1 })
  })
})

describe('focusPane', () => {
  it('moves the focus', () => {
    expect(focusPane(split(), 1).active).toBe(1)
  })

  it('ignores an index that is not a pane', () => {
    const w = split()

    expect(focusPane(w, 5)).toBe(w)
    expect(focusPane(w, -1)).toBe(w)
  })
})

/* ── Moving a tab ───────────────────────────────────────────────────────── */

/** Four tabs in one pane, `d.md` active. Enough width to reorder in both
 *  directions and still have a tab either side of the move. */
function four(): Workspace {
  return {
    panes: [
      {
        tabs: ['a.md', 'b.md', 'c.md', 'd.md'].map((path) => ({ kind: 'note', path }) as const),
        active: 3,
      },
    ],
    active: 0,
  }
}

describe('moveTab', () => {
  it('reorders leftward, landing before the tab that was there', () => {
    const w = moveTab(four(), { kind: 'note', path: 'd.md' }, { pane: 0, index: 1 })

    expect(layout(w)).toEqual([['a.md', 'd.md', 'b.md', 'c.md']])
    // `d.md` was active and still is — it moved, so its number changed, and the
    // active index follows the document to it.
    expect(w.panes[0]!.active).toBe(1)
  })

  it('reorders rightward, still landing before the tab that was there', () => {
    // The off-by-one this whole function turns on. `index: 3` means "before
    // whatever is at 3 right now", which is `d.md` — so removing `b.md` first
    // must NOT shift the target out from under the drop.
    const w = moveTab(four(), { kind: 'note', path: 'b.md' }, { pane: 0, index: 3 })

    expect(layout(w)).toEqual([['a.md', 'c.md', 'b.md', 'd.md']])
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'd.md' })
  })

  it('is a no-op onto its own position, and onto the one after it', () => {
    // Both describe the same gap in the strip. Returned by reference so React
    // bails rather than re-rendering every pane for a drag that went nowhere.
    const w = four()

    expect(moveTab(w, { kind: 'note', path: 'b.md' }, { pane: 0, index: 1 })).toBe(w)
    expect(moveTab(w, { kind: 'note', path: 'b.md' }, { pane: 0, index: 2 })).toBe(w)
  })

  it('appends when the index is past the end', () => {
    const w = moveTab(four(), { kind: 'note', path: 'a.md' }, { pane: 0, index: 99 })

    expect(layout(w)).toEqual([['b.md', 'c.md', 'd.md', 'a.md']])
  })

  it('moves a tab into another pane, at the named index', () => {
    const w = moveTab(split(), { kind: 'note', path: 'a.md' }, { pane: 1, index: 0 })

    expect(layout(w)).toEqual([['b.md'], ['a.md', 'c.md']])
  })

  it('never leaves two copies of the moved tab', () => {
    // One buffer per file, stated as an assertion rather than trusted. A move
    // is safe where a copy is not, and this is the line between them.
    const w = moveTab(split(), { kind: 'note', path: 'a.md' }, { pane: 1, index: 1 })

    expect(layout(w).flat().filter((p) => p === 'a.md')).toHaveLength(1)
  })

  it('rearranges without navigating — a reorder is not a way to change file', () => {
    // `closeTab`'s rule, and the reason a reorder differs from a cross-pane
    // move: tidying a strip while reading `d.md` must not drop you into the tab
    // you happened to drag. You did not ask to read it.
    const w = moveTab(four(), { kind: 'note', path: 'a.md' }, { pane: 0, index: 4 })

    expect(activeTab(w)).toEqual({ kind: 'note', path: 'd.md' })
  })

  it('falls back to the left-hand neighbour when the moved tab was the active one', () => {
    const start: Workspace = {
      panes: [
        {
          tabs: [
            { kind: 'note', path: 'a.md' },
            { kind: 'note', path: 'b.md' },
            { kind: 'note', path: 'c.md' },
          ],
          active: 1,
        },
        { tabs: [], active: -1 },
      ],
      active: 0,
    }

    const w = moveTab(start, { kind: 'note', path: 'b.md' }, { pane: 1, index: 0 })

    expect(layout(w)).toEqual([['a.md', 'c.md'], ['b.md']])
    expect(w.panes[0]!.active).toBe(0)
  })

  it('focuses the moved tab in its destination, and the destination pane', () => {
    const w = moveTab(split(), { kind: 'note', path: 'a.md' }, { pane: 1, index: 1 })

    expect(w.active).toBe(1)
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'a.md' })
  })

  it('pins a preview note — dragging is intent, the way editing is', () => {
    // Without this the gesture eats itself: the next single-click in the tree
    // replaces the preview tab in place, destroying the one just positioned.
    const start: Workspace = {
      panes: [
        {
          tabs: [{ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'b.md', preview: true }],
          active: 1,
        },
      ],
      active: 0,
    }

    const w = moveTab(start, { kind: 'note', path: 'b.md' }, { pane: 0, index: 0 })

    expect(w.panes[0]!.tabs[0]).toEqual({ kind: 'note', path: 'b.md' })
  })

  it('takes the source pane with it when the move empties it', () => {
    // The same rule `closeTab` applies, and the difference between "unsplit by
    // dragging my last tab away" and a permanent empty column.
    const start: Workspace = {
      panes: [
        { tabs: [{ kind: 'note', path: 'x.md' }], active: 0 },
        { tabs: [{ kind: 'note', path: 'y.md' }], active: 0 },
        { tabs: [{ kind: 'note', path: 'z.md' }], active: 0 },
      ],
      active: 0,
    }

    const w = moveTab(start, { kind: 'note', path: 'x.md' }, { pane: 2, index: 0 })

    expect(layout(w)).toEqual([['y.md'], ['x.md', 'z.md']])
    // The destination was pane 2 and is now pane 1 — focus has to follow the
    // pane, not the number it had before the source collapsed.
    expect(w.active).toBe(1)
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'x.md' })
  })

  it('cannot empty the only pane, because a move needs somewhere to go', () => {
    // Not a guard, an impossibility: `dest.pane` must be a real pane, so a
    // workspace with one pane can only move within it, which never empties it.
    const w = moveTab(four(), { kind: 'note', path: 'a.md' }, { pane: 0, index: 4 })

    expect(w.panes).toHaveLength(1)
    expect(w.panes[0]!.tabs).toHaveLength(4)
  })

  it('ignores a tab that is open nowhere, and a pane that is not there', () => {
    const w = four()

    expect(moveTab(w, { kind: 'note', path: 'nope.md' }, { pane: 0, index: 0 })).toBe(w)
    expect(moveTab(w, { kind: 'note', path: 'a.md' }, { pane: 7, index: 0 })).toBe(w)
  })
})

describe('moveTabToNewPane', () => {
  it('puts the tab in a fresh pane before the one it was dropped on', () => {
    const w = moveTabToNewPane(split(), { kind: 'note', path: 'b.md' }, 0)

    expect(layout(w)).toEqual([['b.md'], ['a.md'], ['c.md']])
    expect(w.active).toBe(0)
    expect(activeTab(w)).toEqual({ kind: 'note', path: 'b.md' })
  })

  it('and after it, when the drop was on the other edge', () => {
    const w = moveTabToNewPane(split(), { kind: 'note', path: 'b.md' }, 1)

    expect(layout(w)).toEqual([['a.md'], ['b.md'], ['c.md']])
    expect(w.active).toBe(1)
  })

  it('leaves the source pane holding the rest', () => {
    // `a.md` onto its own pane's right edge — legal, because pane 0 has another
    // tab to keep the column alive.
    const w = moveTabToNewPane(split(), { kind: 'note', path: 'a.md' }, 1)

    expect(layout(w)).toEqual([['b.md'], ['a.md'], ['c.md']])
    expect(w.panes).toHaveLength(3)
  })

  it('does nothing when a pane’s only tab is dropped on that pane’s own edge', () => {
    // Removing the column and rebuilding an identical one in the same place is
    // a flicker, not a move. `c.md` is alone in pane 1, so both of its own
    // edges describe the workspace it is already in.
    const w = split()

    expect(moveTabToNewPane(w, { kind: 'note', path: 'c.md' }, 1)).toBe(w)
    expect(moveTabToNewPane(w, { kind: 'note', path: 'c.md' }, 2)).toBe(w)
  })

  it('but the same sole tab on ANOTHER pane’s edge is an ordinary move', () => {
    // The narrowness of that guard is the whole point: this collapses the pane
    // `c.md` came from and builds a new one elsewhere, which is a real change.
    const w = moveTabToNewPane(split(), { kind: 'note', path: 'c.md' }, 0)

    expect(layout(w)).toEqual([['c.md'], ['a.md', 'b.md']])
    expect(w.panes).toHaveLength(2)
    expect(w.active).toBe(0)
  })

  it('shifts the insertion point down when the collapsing source sat before it', () => {
    const start: Workspace = {
      panes: [
        { tabs: [{ kind: 'note', path: 'x.md' }], active: 0 },
        { tabs: [{ kind: 'note', path: 'y.md' }], active: 0 },
        { tabs: [{ kind: 'note', path: 'z.md' }], active: 0 },
      ],
      active: 0,
    }

    // "After pane 1" is index 2 while pane 0 still exists; once pane 0 goes it
    // is index 1, and the tab must land between y.md and z.md either way.
    const w = moveTabToNewPane(start, { kind: 'note', path: 'x.md' }, 2)

    expect(layout(w)).toEqual([['y.md'], ['x.md'], ['z.md']])
    expect(w.active).toBe(1)
  })

  it('pins a preview note, the same way a move within the strip does', () => {
    const start: Workspace = {
      panes: [
        {
          tabs: [{ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'b.md', preview: true }],
          active: 1,
        },
      ],
      active: 0,
    }

    const w = moveTabToNewPane(start, { kind: 'note', path: 'b.md' }, 1)

    expect(w.panes[1]!.tabs).toEqual([{ kind: 'note', path: 'b.md' }])
  })

  it('ignores a tab that is open nowhere', () => {
    const w = split()

    expect(moveTabToNewPane(w, { kind: 'note', path: 'nope.md' }, 0)).toBe(w)
  })
})
