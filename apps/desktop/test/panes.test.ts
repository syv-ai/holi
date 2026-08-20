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
  closeTabsForPaths,
  emptyWorkspace,
  openApp,
  openPinned,
  openPreview,
  openSingleton,
  openTab,
  pinActive,
  pinTab,
  retargetAppTab,
  retargetTab,
  retargetTabs,
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
