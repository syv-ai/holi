/**
 * What is on screen: panes, each holding tabs (`docs/features/tabs-panes.md`).
 *
 * **A tab is not a note** (`architecture.md`). A flat `Map<path, …>` would
 * foreclose session and surface tabs, so a tab is a discriminated union and
 * the state is `panes[] → tabs[]`.
 */

import { atom } from 'jotai'
import type { SurfaceTab, Tab } from '@/lib/tab'

export type { Tab }

/**
 * A directory that is one document, as the panes need it: the surface its
 * tabs are, by path, and the entry file whose move or delete says where the
 * directory went (`PathClaim.folder`).
 */
export interface FolderSurface {
  surface: string
  entry: string
  match(path: string): boolean
}

/** Open a note as a preview tab in the active pane — the action behind a
 *  wiki-link click from a surface that is not the editor (e.g. a task
 *  description on the board), which switches the view to that note. */
export const openNoteTabAtom = atom(null, (_get, set, path: string) => {
  set(workspaceAtom, (w) => openPreview(w, path))
})

interface Pane {
  tabs: Tab[]
  /** Index into `tabs`. `-1` when the pane is empty, which is the empty-editor
   *  state rather than a pane that should disappear. */
  active: number
}

export interface Workspace {
  panes: Pane[]
  active: number
}

export function emptyWorkspace(): Workspace {
  return { panes: [{ tabs: [], active: -1 }], active: 0 }
}

/** Where the tabs actually live. Not persisted: whether tabs survive a restart
 *  is an open product question, and `.holi/settings/app.local.yaml` is where the
 *  answer would go (`docs/features/tabs-panes.md`). */
export const workspaceAtom = atom<Workspace>(emptyWorkspace())

function sameTab(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'note' && b.kind === 'note') return a.path === b.path
  if (a.kind === 'surface' && b.kind === 'surface') {
    return a.surface === b.surface && a.id === b.id
  }
  return false
}

/**
 * Where a tab already is, across **every** pane, or null.
 *
 * One buffer per file is a global rule: the same note open in two panes is two
 * `EditorPane` instances over one path, each holding its own `base` and each
 * autosaving on its own debounce, with the other one's write arriving as an
 * "external" change to reconcile. It is also why a split cannot simply
 * duplicate the tab it was invoked on.
 */
function findTab(workspace: Workspace, tab: Tab): { pane: number; tab: number } | null {
  for (let p = 0; p < workspace.panes.length; p++) {
    const i = workspace.panes[p]!.tabs.findIndex((t) => sameTab(t, tab))
    if (i !== -1) return { pane: p, tab: i }
  }
  return null
}

/** Focus a pane, and a tab within it. Every opener routes through this when the
 *  tab is already open, rather than adding a copy. */
function focusExisting(workspace: Workspace, at: { pane: number; tab: number }): Workspace {
  return {
    panes: workspace.panes.map((pane, i) => (i === at.pane ? { ...pane, active: at.tab } : pane)),
    active: at.pane,
  }
}

/** Open a tab in the active pane, or focus it if it is already open anywhere
 *  (the one-buffer rule, see `findTab`). */
export function openTab(workspace: Workspace, tab: Tab): Workspace {
  const existing = findTab(workspace, tab)
  if (existing !== null) return focusExisting(workspace, existing)
  return updatePane(workspace, (pane) => ({ tabs: [...pane.tabs, tab], active: pane.tabs.length }))
}

/**
 * Open a surface, or focus it where it is.
 *
 * A surface is a leftmost tab: if it is already open, it is focused **in
 * place** (moving it would shuffle the strip under the user on a second
 * click); otherwise it goes in at the front. A surface tab with an `id` is one
 * thing among many, a vault app say, opened like a file, so it is appended.
 * Deduped by id: two frames over one app are two running copies of it. Home
 * goes through `openHomeAtom` instead, which decides what Home is.
 */
export function openSurface(workspace: Workspace, surface: string, id?: string): Workspace {
  if (id !== undefined) return openTab(workspace, { kind: 'surface', surface, id })
  const tab: SurfaceTab = { kind: 'surface', surface }
  const existing = findTab(workspace, tab)
  if (existing !== null) return focusExisting(workspace, existing)
  return updatePane(workspace, (pane) => ({ tabs: [tab, ...pane.tabs], active: 0 }))
}

/**
 * A pane with one tab removed, its active index following the **document**.
 *
 * Closing the active tab falls back to its left-hand neighbour; removing any
 * other one keeps whatever was active where it now sits. Shared with the moves,
 * which perform exactly the same removal.
 */
function withoutTabAt(pane: Pane, index: number): Pane {
  const tabs = pane.tabs.filter((_, i) => i !== index)
  if (tabs.length === 0) return { tabs, active: -1 }
  const active =
    index === pane.active
      ? Math.max(0, index - 1)
      : pane.active > index
        ? pane.active - 1
        : pane.active
  return { tabs, active }
}

/**
 * Close a tab in the active pane.
 *
 * The active tab follows the *document*, not the index: keeping the number would
 * silently move the user to a different file in a UI that autosaves.
 *
 * **An emptied pane goes, unless it is the last one.** Closing the final tab of
 * a split is how you unsplit. The last pane always stays: an empty pane is the
 * empty-editor state, and a workspace with no panes has nothing to render into.
 */
export function closeTab(workspace: Workspace, index: number): Workspace {
  const closed = updatePane(workspace, (pane) =>
    index < 0 || index >= pane.tabs.length ? pane : withoutTabAt(pane, index),
  )
  const pane = closed.panes[closed.active]
  if (pane !== undefined && pane.tabs.length === 0 && closed.panes.length > 1) {
    return closePane(closed, closed.active)
  }
  return closed
}

/**
 * Single-click open: reuse the one preview tab.
 *
 * If the note is already open, just focus it: clicking it again does not change
 * whether it is pinned. Otherwise, if a preview tab exists, replace it in place
 * (browsing costs one tab); if none does, add one. The new tab is a *preview*.
 */
export function openPreview(workspace: Workspace, path: string): Workspace {
  const existing = findTab(workspace, { kind: 'note', path })
  if (existing !== null) return focusExisting(workspace, existing)
  return updatePane(workspace, (pane) => {
    const previewIdx = pane.tabs.findIndex((t) => t.kind === 'note' && t.preview)
    const tab: Tab = { kind: 'note', path, preview: true }
    if (previewIdx !== -1) {
      return {
        ...pane,
        tabs: pane.tabs.map((t, i) => (i === previewIdx ? tab : t)),
        active: previewIdx,
      }
    }
    return { tabs: [...pane.tabs, tab], active: pane.tabs.length }
  })
}

/** Double-click open (or open-and-pin): a pinned tab, focused. Pins the tab in
 *  place if it was already open as a preview. */
export function openPinned(workspace: Workspace, path: string): Workspace {
  const existing = findTab(workspace, { kind: 'note', path })
  if (existing !== null) {
    const focused = focusExisting(workspace, existing)
    return pinTabIn(focused, existing.pane, existing.tab)
  }
  return updatePane(workspace, (pane) => ({
    tabs: [...pane.tabs, { kind: 'note', path }],
    active: pane.tabs.length,
  }))
}

/** `pinTab` against a named pane: `openPinned` may find the note open in a pane
 *  that is not the active one. */
function pinTabIn(workspace: Workspace, paneIndex: number, index: number): Workspace {
  return {
    ...workspace,
    panes: workspace.panes.map((pane, p) => {
      if (p !== paneIndex) return pane
      const tab = pane.tabs[index]
      if (tab === undefined || tab.kind !== 'note' || !tab.preview) return pane
      return {
        ...pane,
        tabs: pane.tabs.map((t, i) => (i === index ? { kind: 'note', path: tab.path } : t)),
      }
    }),
  }
}

/**
 * Point every open tab at a renamed note's new path.
 *
 * A rename moves bytes, not tabs: indices and the active selection are
 * untouched, so the user stays on whatever they were looking at, now under its
 * new name. Spans all panes, not just the active one: a note can be open in
 * more than one, and a missed tab would point at a path that no longer exists.
 */
export function retargetTab(workspace: Workspace, from: string, to: string): Workspace {
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) =>
        tab.kind === 'note' && tab.path === from ? { ...tab, path: to } : tab,
      ),
    })),
  }
}

/**
 * `retargetTab` for a whole batch (folder or multi-move).
 *
 * A folder document's tab (a vault app's) follows its directory, and the
 * moves name files, so the directory is followed by its entry file:
 * `A.app/index.html` to `B/A.app/index.html` moves the tab to `B/A.app`. Only
 * the entry file, and only to another directory its claim matches: a note
 * dragged out of an expanded app is not the app moving.
 */
export function retargetTabs(
  workspace: Workspace,
  moves: { from: string; to: string }[],
  folders: readonly FolderSurface[] = [],
): Workspace {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  const folderTo = (tab: SurfaceTab): string | undefined => {
    const folder = folders.find((f) => f.surface === tab.surface)
    if (folder === undefined || tab.id === undefined) return undefined
    const to = map.get(`${tab.id}/${folder.entry}`)
    if (to === undefined || !to.endsWith(`/${folder.entry}`)) return undefined
    const dest = to.slice(0, -folder.entry.length - 1)
    return folder.match(dest) ? dest : undefined
  }
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => {
        if (tab.kind === 'note' && map.has(tab.path)) return { ...tab, path: map.get(tab.path)! }
        if (tab.kind !== 'surface') return tab
        const to = folderTo(tab)
        return to === undefined ? tab : { ...tab, id: to }
      }),
    })),
  }
}

/**
 * Close every tab pointing at a deleted path, in every pane.
 *
 * The active selection follows the *document*: if what was active survives, the
 * user stays on it (its index is re-found after the removals); if it was one of
 * the deleted, the pane falls back to the nearest surviving neighbour, and an
 * emptied pane stays as the empty-editor state (`active: -1`), never disappears.
 */
export function closeTabsForPaths(
  workspace: Workspace,
  paths: string[],
  folders: readonly FolderSurface[] = [],
): Workspace {
  // A folder document goes with its entry file: deleting the directory from
  // the tree closes its tab.
  const entryOf = (t: SurfaceTab): string | null => {
    const folder = folders.find((f) => f.surface === t.surface)
    return folder === undefined || t.id === undefined ? null : `${t.id}/${folder.entry}`
  }
  return closeTabsWhere(
    workspace,
    (t) =>
      (t.kind === 'note' && paths.includes(t.path)) ||
      (t.kind === 'surface' && paths.includes(entryOf(t) ?? '')),
  )
}

/** Close the tabs of `surface` whose id is not in `keep`: what its plugin
 *  says no longer exists, such as a terminal that has exited. */
export function closeSurfaceTabsExcept(
  workspace: Workspace,
  surface: string,
  keep: readonly string[],
): Workspace {
  const gone = (t: Tab) =>
    t.kind === 'surface' && t.surface === surface && t.id !== undefined && !keep.includes(t.id)
  if (!workspace.panes.some((p) => p.tabs.some(gone))) return workspace
  return closeTabsWhere(workspace, gone)
}

/** The ids of every `surface` tab, across every pane, in pane order. */
export function surfaceTabIds(workspace: Workspace, surface: string): string[] {
  return workspace.panes.flatMap((p) =>
    p.tabs.flatMap((t) =>
      t.kind === 'surface' && t.surface === surface && t.id !== undefined ? [t.id] : [],
    ),
  )
}

/**
 * Close the tabs of surfaces that are no longer registered: their plugin was
 * turned off, by the same path as a tab whose file was deleted.
 */
export function closeSurfaceTabs(workspace: Workspace, live: ReadonlySet<string>): Workspace {
  const gone = (t: Tab) => t.kind === 'surface' && !live.has(t.surface)
  // By reference when nothing goes, so a registry change that closes nothing
  // re-renders nothing.
  if (!workspace.panes.some((p) => p.tabs.some(gone))) return workspace
  return closeTabsWhere(workspace, gone)
}

/**
 * Every pane with the matching tabs removed, each pane's active index following
 * the **document** rather than the position. Shared so there is one answer to
 * where the selection lands.
 */
function closeTabsWhere(workspace: Workspace, gone: (tab: Tab) => boolean): Workspace {
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => {
      if (!pane.tabs.some(gone)) return pane
      const activeTab = pane.tabs[pane.active]
      const tabs = pane.tabs.filter((t) => !gone(t))
      if (tabs.length === 0) return { tabs, active: -1 }
      if (activeTab !== undefined && !gone(activeTab))
        return { tabs, active: tabs.indexOf(activeTab) }
      return { tabs, active: Math.max(0, Math.min(pane.active, tabs.length - 1)) }
    }),
  }
}

/** What the editor should be showing, or null when the pane is empty. */
export function activeTab(workspace: Workspace): Tab | null {
  const pane = workspace.panes[workspace.active]
  if (pane === undefined || pane.active < 0) return null
  return pane.tabs[pane.active] ?? null
}

function updatePane(workspace: Workspace, fn: (pane: Pane) => Pane): Workspace {
  return {
    ...workspace,
    panes: workspace.panes.map((pane, i) => (i === workspace.active ? fn(pane) : pane)),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Panes
 * ──────────────────────────────────────────────────────────────────────────── */

/** Focus a pane. Clicking anywhere in a pane makes it the one that "open" means,
 *  so the tree, the nav chips and every keyboard action land where you are
 *  looking rather than where you last were. */
export function focusPane(workspace: Workspace, index: number): Workspace {
  if (index < 0 || index >= workspace.panes.length || index === workspace.active) return workspace
  return { ...workspace, active: index }
}

/**
 * Split: a new, **empty** pane beside the active one, focused.
 *
 * Empty, not a copy of the active tab as in VS Code and Obsidian: their editors
 * tolerate two views of one buffer, Holi's does not (`findTab`). A split makes
 * room and the next thing you open fills it; `openInNewPane` is the richer
 * gesture the tree and apps list offer.
 */
export function splitPane(workspace: Workspace): Workspace {
  const at = workspace.active + 1
  return {
    panes: [
      ...workspace.panes.slice(0, at),
      { tabs: [], active: -1 },
      ...workspace.panes.slice(at),
    ],
    active: at,
  }
}

/**
 * Open a tab in a new pane beside the active one.
 *
 * Already open somewhere? Focus it there (the one-buffer rule), which also makes
 * the menu item safe to hit twice.
 */
export function openInNewPane(workspace: Workspace, tab: Tab): Workspace {
  const existing = findTab(workspace, tab)
  if (existing !== null) return focusExisting(workspace, existing)
  const at = workspace.active + 1
  return {
    panes: [
      ...workspace.panes.slice(0, at),
      { tabs: [tab], active: 0 },
      ...workspace.panes.slice(at),
    ],
    active: at,
  }
}

/**
 * Close a whole pane. **The last one never goes** (see `closeTab`). Focus lands
 * on the left-hand neighbour, unless the closed one was leftmost.
 * @public exported for its test
 */
export function closePane(workspace: Workspace, index: number): Workspace {
  if (workspace.panes.length <= 1 || index < 0 || index >= workspace.panes.length) return workspace
  const panes = workspace.panes.filter((_, i) => i !== index)
  const active =
    workspace.active > index ? workspace.active - 1 : Math.min(workspace.active, panes.length - 1)
  return { panes, active }
}

