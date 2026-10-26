/**
 * What is on screen, as a shape that can grow a second pane.
 *
 * A flat `Map<path, …>` forecloses split panes and non-note tabs, so the state
 * is `panes[] → tabs[]` and a tab is a discriminated union.
 */
import { describe, expect, it } from 'vitest'
import {
  activeTab,
  closePane,
  closeTab,
  closeTabsForPaths,
  emptyWorkspace,
  openInNewPane,
  openPinned,
  openPreview,
  openSurface,
  openTab,
  retargetTab,
  retargetTabs,
  splitPane,
  closeSurfaceTabs,
  focusPane,
  type FolderSurface,
  type Tab,
  type Workspace,
} from '@/state/panes'

/** A vault app's tab: the surface `app`, by bundle path. */
const activePane = (w: Workspace) => w.panes[w.active] ?? null
const app = (id: string): Tab => ({ kind: 'surface', surface: 'app', id })
const openApp = (w: Workspace, id: string): Workspace => openTab(w, app(id))
/** The app claim's folder, as the panes are told about it. */
const APPS: FolderSurface[] = [
  { surface: 'app', entry: 'index.html', match: (p) => /\.app$/.test(p) },
]

const paths = (w: Workspace) =>
  w.panes[0]!.tabs.map((t) => (t.kind === 'note' ? t.path : t.surface))

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
    w = openTab(w, { kind: 'surface', surface: 'board' })
    w = openTab(w, { kind: 'surface', surface: 'board' })

    expect(paths(w)).toEqual(['a.md', 'board'])
  })

  it('tells two tabs of one surface apart by id', () => {
    let w = openSurface(emptyWorkspace(), 'app', 'a.app')
    w = openSurface(w, 'app', 'b.app')
    w = openSurface(w, 'app', 'a.app')

    expect(w.panes[0]!.tabs).toHaveLength(2)
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
    // The last pane never goes, so a pane that deleted itself when its last tab
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

  it('openPinned pins an existing preview tab in place', () => {
    let w = openPreview(emptyWorkspace(), 'a.md')
    w = openPinned(w, 'a.md')
    expect(tabs(w)).toEqual([{ kind: 'note', path: 'a.md' }])
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
  it('closes an app whose bundle was deleted, and leaves one that only lost a file', () => {
    let w = openApp(emptyWorkspace(), 'A.app')
    w = openApp(w, 'B.app')
    const next = closeTabsForPaths(
      w,
      ['A.app/index.html', 'A.app/app.yaml', 'B.app/notes.md'],
      APPS,
    )
    expect(next.panes[0]!.tabs).toEqual([app('B.app')])
  })

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

describe('an app tab', () => {
  it('opens an app tab and focuses it', () => {
    const w = openApp(emptyWorkspace(), 'retro.app')
    expect(w.panes[0]!.tabs).toEqual([app('retro.app')])
    expect(w.panes[0]!.active).toBe(0)
  })

  it('focuses an app that is already open instead of opening it twice', () => {
    // Same rule as a note, for the same reason: two frames over one app are two
    // running copies of it, and the second one is not the one you were looking at.
    let w = openApp(emptyWorkspace(), 'retro.app')
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = openApp(w, 'retro.app')
    expect(w.panes[0]!.tabs).toHaveLength(2)
    expect(w.panes[0]!.active).toBe(0)
  })

  it('keeps two different apps apart', () => {
    let w = openApp(emptyWorkspace(), 'a.app')
    w = openApp(w, 'Sub/b.app')
    expect(w.panes[0]!.tabs).toEqual([app('a.app'), app('Sub/b.app')])
    expect(w.panes[0]!.active).toBe(1)
  })

  it('behaves like any other tab when closed', () => {
    let w = openApp(emptyWorkspace(), 'retro.app')
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = closeTab(w, 0)
    expect(w.panes[0]!.tabs).toEqual([{ kind: 'note', path: 'a.md' }])
  })
})

describe('retargetTabs, for an app', () => {
  const kinds = (w: Workspace) =>
    w.panes[0]!.tabs.map((t) => (t.kind === 'surface' ? `app:${t.id}` : t.kind))
  const moveBundle = (from: string, to: string, files = ['index.html', 'app.yaml']) =>
    files.map((f) => ({ from: `${from}/${f}`, to: `${to}/${f}` }))

  it('follows a moved bundle to its new path, in place', () => {
    let w = emptyWorkspace()
    w = openApp(w, 'retro.app')
    w = openApp(w, 'burndown.app')

    const next = retargetTabs(w, moveBundle('retro.app', 'Team/standup.app'), APPS)

    expect(kinds(next)).toEqual(['app:Team/standup.app', 'app:burndown.app'])
    // The active selection is untouched — the user stays on what they were on.
    expect(next.panes[0]!.active).toBe(w.panes[0]!.active)
  })

  it('follows a folder move that carries the bundle with it', () => {
    let w = emptyWorkspace()
    w = openApp(w, 'Team/retro.app')
    const next = retargetTabs(
      w,
      [
        { from: 'Team/notes.md', to: 'Old/Team/notes.md' },
        { from: 'Team/retro.app/index.html', to: 'Old/Team/retro.app/index.html' },
        { from: 'Team/retro.app/lib/a.js', to: 'Old/Team/retro.app/lib/a.js' },
      ],
      APPS,
    )
    expect(kinds(next)).toEqual(['app:Old/Team/retro.app'])
  })

  it('stays put when a file is dragged out of the expanded app, or within it', () => {
    let w = emptyWorkspace()
    w = openApp(w, 'A.app')
    expect(retargetTabs(w, [{ from: 'A.app/notes.md', to: 'Docs/notes.md' }], APPS)).toEqual(w)
    expect(retargetTabs(w, [{ from: 'A.app/index.html', to: 'Docs/index.html' }], APPS)).toEqual(w)
    expect(retargetTabs(w, [{ from: 'A.app/foo.md', to: 'A.app/lib/foo.md' }], APPS)).toEqual(w)
  })

  it('leaves an app alone when only a sibling whose name it prefixes moves', () => {
    let w = emptyWorkspace()
    w = openApp(w, 'retro.app')
    expect(retargetTabs(w, moveBundle('retro.apple', 'x.apple'), APPS)).toEqual(w)
  })

  it('is a no-op when the moved app has no tab open', () => {
    let w = emptyWorkspace()
    w = openApp(w, 'burndown.app')
    expect(retargetTabs(w, moveBundle('retro.app', 'standup.app'), APPS)).toEqual(w)
  })
})

/* ── Panes ──────────────────────────────────────────────────────────────── */

/** A workspace of two panes: `a.md`+`b.md` on the left, `c.md` on the right. */
function split(): Workspace {
  return {
    panes: [
      {
        tabs: [
          { kind: 'note', path: 'a.md' },
          { kind: 'note', path: 'b.md' },
        ],
        active: 1,
      },
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

    expect(
      layout(w)
        .flat()
        .filter((p) => p === 'a.md'),
    ).toHaveLength(1)
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
      {
        panes: [
          { tabs: [], active: -1 },
          { tabs: [{ kind: 'note', path: 'c.md', preview: true }], active: 0 },
        ],
        active: 0,
      },
      'c.md',
    )

    expect(w.active).toBe(1)
    expect(w.panes[1]!.tabs[0]).toEqual({ kind: 'note', path: 'c.md' })
  })

  it('openApp focuses an app already open in another pane', () => {
    const w = openApp(
      {
        panes: [
          { tabs: [], active: -1 },
          { tabs: [app('dash.app')], active: 0 },
        ],
        active: 0,
      },
      'dash.app',
    )

    expect(w.panes.flatMap((p) => p.tabs)).toHaveLength(1)
    expect(w.active).toBe(1)
  })

  it('a surface is one for the whole workspace', () => {
    const board = { kind: 'surface', surface: 'board' } as const
    const w = openSurface(
      {
        panes: [
          { tabs: [], active: -1 },
          { tabs: [board], active: 0 },
        ],
        active: 0,
      },
      'board',
    )

    expect(w.panes.flatMap((p) => p.tabs)).toEqual([board])
    expect(w.active).toBe(1)
  })

  it('closes the tabs of surfaces that left the registry, and only those', () => {
    const w: Workspace = {
      panes: [
        {
          tabs: [
            { kind: 'surface', surface: 'mail' },
            { kind: 'note', path: 'a.md' },
          ],
          active: 1,
        },
      ],
      active: 0,
    }

    expect(closeSurfaceTabs(w, new Set(['mail']))).toBe(w)
    expect(closeSurfaceTabs(w, new Set(['board'])).panes[0]).toEqual({
      tabs: [{ kind: 'note', path: 'a.md' }],
      active: 0,
    })
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

/**
 * ⌘W is `closeTab` at the focused pane's active index — the shell computes
 * exactly this, so these pin what the key does at the edges the strip's close
 * button never reaches: a pane with nothing in it.
 */
describe("⌘W: the focused pane's active tab", () => {
  const closeActive = (w: Workspace) => closeTab(w, activePane(w)!.active)

  it('closes the active tab of the focused pane, not of the first one', () => {
    const w = closeActive({ ...split(), active: 1 })

    expect(layout(w)).toEqual([['a.md', 'b.md']])
    expect(w.active).toBe(0)
  })

  it('does nothing when nothing is open', () => {
    const one = emptyWorkspace()

    expect(closeActive(one)).toEqual(one)
  })

  it('takes an empty pane out of a split, the same as emptying it would', () => {
    // ⌘\ then ⌘W: the pane ⌘\ made goes again, and focus returns.
    const w = closeActive(splitPane(openPreview(emptyWorkspace(), 'a.md')))

    expect(layout(w)).toEqual([['a.md']])
    expect(w.active).toBe(0)
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

/**
 * The shell has to know BEFORE it closes, because a pane that is going plays an
 * exit first and React unmounts it the instant state says it is gone.
 *
 * Every case asserts the predicate against what `closeTab` ACTUALLY does rather
 * than against a restatement of the rule. That agreement is the whole property,
 * and a copied rule is the thing that would rot.
 */
