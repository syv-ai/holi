/**
 * What is on screen: panes, each holding tabs (`docs/features/tabs-panes.md`).
 *
 * **A tab is not a note** (`architecture.md`). A flat `Map<path, …>` would
 * foreclose app, session and surface tabs, so a tab is a discriminated union
 * and the state is `panes[] → tabs[]`.
 */

import { isAppBundlePath } from '@holi/shared'
import { atom } from 'jotai'
import type { PaneDropZone } from '@/lib/tab-drop'

/** An app's entry document, which is what says where its bundle went. */
const APP_ENTRY = 'index.html'

/** Open a note as a preview tab in the active pane — the action behind a
 *  wiki-link click from a surface that is not the editor (e.g. a task
 *  description on the board), which switches the view to that note. */
export const openNoteTabAtom = atom(null, (_get, set, path: string) => {
  set(workspaceAtom, (w) => openPreview(w, path))
})

/** Open a note beside the active pane — the board's card click (`openBeside`). */
export const openBesideAtom = atom(null, (_get, set, path: string) => {
  set(workspaceAtom, (w) => openBeside(w, w.active, path))
})

/** A tab onto a surface from the registry (`state/plugins.ts`): Home, the
 *  board, settings, a plugin's view. `id` names which one, for a surface that
 *  is one tab per thing; without it there is one of the surface, ever. */
export interface SurfaceTab {
  kind: 'surface'
  surface: string
  id?: string
}

/**
 * A tab is either *of* something (a note or app by path, a session by id) or
 * a surface.
 *
 * The `preview` flag is VS Code's two-state model: a preview tab (italic) is the
 * single one that a single-click *replaces* rather than adding to, so browsing a
 * vault costs one tab. Absent or false means pinned.
 */
export type Tab =
  | { kind: 'note'; path: string; preview?: boolean }
  /** A vault app, identified by its bundle's path, `Finance/Budget.app`.
   * There is one tab per app, not one per vault. */
  | { kind: 'app'; path: string }
  /**
   * A terminal onto Claude Code, by the id main minted for it: the
   * agents list, or one background session.
   *
   * **Closing the tab does not end a session**: it detaches, the session keeps
   * running, and the sidebar's rows are how you get back to it. What the tab
   * shows can change under it (`←` goes back to the list), so it is named by
   * its terminal, never by a session.
   */
  | { kind: 'agent'; id: string }
  | SurfaceTab

export interface Pane {
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
  if (a.kind === 'app' && b.kind === 'app') return a.path === b.path
  if (a.kind === 'agent' && b.kind === 'agent') return a.id === b.id
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
 * Open a surface, always as a leftmost tab.
 *
 * If it is already open, focus it **in place** (moving it would shuffle the
 * strip under the user on a second click); otherwise insert it at the front.
 * Home goes through `openHomeAtom` instead, which decides what Home is.
 */
export function openSurface(workspace: Workspace, surface: string, id?: string): Workspace {
  const tab: SurfaceTab =
    id === undefined ? { kind: 'surface', surface } : { kind: 'surface', surface, id }
  const existing = findTab(workspace, tab)
  if (existing !== null) return focusExisting(workspace, existing)
  return updatePane(workspace, (pane) => ({ tabs: [tab, ...pane.tabs], active: 0 }))
}

/** Open a vault app, or focus it if already open. Deduped by `path`: two frames
 *  over one app are two running copies of it. Appended rather than inserted
 *  leftmost: an app is opened from the sidebar like a file, not from the nav
 *  rail like a surface. */
export function openApp(workspace: Workspace, path: string): Workspace {
  return openTab(workspace, { kind: 'app', path })
}

/**
 * How many times each app has been reloaded since launch, by bundle path. Both
 * reloads count here: the pane header's reload button, and the agent's `holi
 * app open` on an app that is already open, so an agent that just edited one
 * shows the new version with the command it already knows.
 */
export const appOpensAtom = atom<Record<string, number>>({})

/** Show one agent terminal, or focus its tab if already open. Deduped by id:
 *  two views over one PTY would both be attached to it. */
export function openAgentTab(workspace: Workspace, id: string): Workspace {
  return openTab(workspace, { kind: 'agent', id })
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
 * Would closing this tab take its pane with it?
 *
 * Derived by RUNNING `closeTab` rather than restating its rule, so the answer
 * cannot drift from what the close is about to do.
 *
 * The shell has to know BEFORE it closes: a pane that is going needs to play its
 * exit first, and React unmounts it the instant state says it is gone.
 */
export function closingTabRemovesPane(workspace: Workspace, index: number): boolean {
  return closeTab(workspace, index).panes.length < workspace.panes.length
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

/** Promote a tab to pinned — the double-click-a-tab and edit-a-preview rules.
 *  No-op if the index is out of range or the tab is not a preview note. */
export function pinTab(workspace: Workspace, index: number): Workspace {
  return pinTabIn(workspace, workspace.active, index)
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

/** Pin whatever is active — the "editing promotes a preview tab" rule, so you
 *  can never lose your place by clicking away from something you typed in. */
export function pinActive(workspace: Workspace): Workspace {
  const pane = workspace.panes[workspace.active]
  return pane === undefined ? workspace : pinTab(workspace, pane.active)
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
 * An app tab follows its bundle, and the moves name files, so the bundle is
 * followed by its entry document: `A.app/index.html` to `B/A.app/index.html`
 * moves the tab to `B/A.app`. Only the entry document, and only to another
 * bundle: a note dragged out of an expanded app is not the app moving.
 */
export function retargetTabs(
  workspace: Workspace,
  moves: { from: string; to: string }[],
): Workspace {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  const bundleTo = (bundle: string): string | undefined => {
    const to = map.get(`${bundle}/${APP_ENTRY}`)
    if (to === undefined || !to.endsWith(`/${APP_ENTRY}`)) return undefined
    const dest = to.slice(0, -APP_ENTRY.length - 1)
    return isAppBundlePath(dest) ? dest : undefined
  }
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => {
        if (tab.kind === 'note' && map.has(tab.path)) return { ...tab, path: map.get(tab.path)! }
        if (tab.kind !== 'app') return tab
        const to = bundleTo(tab.path)
        return to === undefined ? tab : { ...tab, path: to }
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
export function closeTabsForPaths(workspace: Workspace, paths: string[]): Workspace {
  return closeTabsWhere(
    workspace,
    (t) =>
      // An app goes with its entry document: deleting the bundle from the tree
      // closes its tab, as deleting it from the apps list does.
      (t.kind === 'note' && paths.includes(t.path)) ||
      (t.kind === 'app' && paths.includes(`${t.path}/${APP_ENTRY}`)),
  )
}

/**
 * Close the tabs of terminals that are no longer in main's list. A terminal
 * leaves it when its client exits: a detach, `/exit`, or its session stopped.
 */
export function closeAgentTabs(workspace: Workspace, liveIds: string[]): Workspace {
  return closeTabsWhere(workspace, (t) => t.kind === 'agent' && !liveIds.includes(t.id))
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
 * Open a note **beside** the pane it was asked from, as a preview.
 *
 * The board's card click. Unlike `openInNewPane`, which always makes a pane,
 * this reuses the pane to the right if there is one and splits only when there
 * is not, so clicking five cards does not leave five panes.
 *
 * Preview rather than pinned, as with the file tree's single click: browsing the
 * board costs one tab, and the first edit pins it. Already open anywhere? Focus
 * it there (`findTab`).
 */
export function openBeside(workspace: Workspace, from: number, path: string): Workspace {
  const existing = findTab(workspace, { kind: 'note', path })
  if (existing !== null) return focusExisting(workspace, existing)

  const at = from + 1
  if (at < workspace.panes.length) {
    const focused = { ...workspace, active: at }
    return openPreview(focused, path)
  }
  return {
    panes: [
      ...workspace.panes.slice(0, at),
      { tabs: [{ kind: 'note', path, preview: true }], active: 0 },
      ...workspace.panes.slice(at),
    ],
    active: at,
  }
}

/**
 * Close a whole pane. **The last one never goes** (see `closeTab`). Focus lands
 * on the left-hand neighbour, unless the closed one was leftmost.
 */
export function closePane(workspace: Workspace, index: number): Workspace {
  if (workspace.panes.length <= 1 || index < 0 || index >= workspace.panes.length) return workspace
  const panes = workspace.panes.filter((_, i) => i !== index)
  const active =
    workspace.active > index ? workspace.active - 1 : Math.min(workspace.active, panes.length - 1)
  return { panes, active }
}

/** The pane the editor is showing, or null when the workspace is somehow empty. */
export function activePane(workspace: Workspace): Pane | null {
  return workspace.panes[workspace.active] ?? null
}

/* ────────────────────────────────────────────────────────────────────────────
 * Moving a tab
 *
 * Relocating a tab keeps exactly one buffer per path (`findTab`), so a move is
 * always remove, then insert; never copy.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A tab as it should land after a drag: pinned.
 *
 * Dragging is intent, the way editing is (`pinActive`). Otherwise the next
 * single-click in the tree would make `openPreview` replace the tab you just
 * positioned. The `preview` key is dropped rather than set false, matching
 * `pinTabIn`.
 */
function dragged(tab: Tab): Tab {
  return tab.kind === 'note' && tab.preview ? { kind: 'note', path: tab.path } : tab
}

/**
 * Move a tab to `dest`: one function for a reorder *and* a cross-pane move.
 *
 * The caller passes the tab's **identity**, not its location, so a drag never
 * carries indices that could go stale between `dragstart` and `drop`.
 *
 * `dest.index` is read against the destination pane's tabs **as they are now**
 * ("insert before whatever sits there"), so a rightward move within one pane
 * must decrement after the removal or it lands one place short.
 *
 * **A reorder rearranges; it does not navigate.** Within a pane the active tab
 * follows the *document*. A cross-pane move shows what you dropped and focuses
 * that pane, because that is where you are now looking.
 */
export function moveTab(
  workspace: Workspace,
  tab: Tab,
  dest: { pane: number; index: number },
): Workspace {
  const found = findTab(workspace, tab)
  const destPane = workspace.panes[dest.pane]
  if (found === null || destPane === undefined) return workspace

  const source = workspace.panes[found.pane]!
  const samePane = found.pane === dest.pane
  // Both of these describe the same gap in the strip, so neither moves anything.
  // Returned by reference so React bails instead of re-rendering every pane for
  // a drag that went nowhere.
  if (samePane && (dest.index === found.tab || dest.index === found.tab + 1)) return workspace

  const moved = dragged(source.tabs[found.tab]!)
  // Held as the document rather than a number: the only form that survives a removal.
  const wasActive = source.tabs[source.active]
  const removed = withoutTabAt(source, found.tab)

  const target = samePane && dest.index > found.tab ? dest.index - 1 : dest.index
  const into = samePane ? removed.tabs : destPane.tabs
  const at = Math.max(0, Math.min(target, into.length))
  const insert = (tabs: Tab[]) => [...tabs.slice(0, at), moved, ...tabs.slice(at)]

  if (samePane) {
    const tabs = insert(removed.tabs)
    const active =
      source.active === found.tab || wasActive === undefined ? at : tabs.indexOf(wasActive)
    return {
      panes: workspace.panes.map((pane, p) => (p === found.pane ? { tabs, active } : pane)),
      active: dest.pane,
    }
  }

  const panes = workspace.panes.map((pane, p) =>
    p === found.pane
      ? removed
      : p === dest.pane
        ? { tabs: insert(destPane.tabs), active: at }
        : pane,
  )

  // An emptied source pane goes (`closeTab`'s rule). It can never be the *last*
  // pane: emptying one requires a different pane to move into.
  if (removed.tabs.length === 0) {
    return {
      panes: panes.filter((_, p) => p !== found.pane),
      active: dest.pane > found.pane ? dest.pane - 1 : dest.pane,
    }
  }
  return { panes, active: dest.pane }
}

/**
 * Move a tab into a brand-new pane, inserted at `at`: the edge-drop.
 *
 * `at` is an index into `panes` (`0..panes.length`), read against the array as
 * it is now: dropping on pane `i`'s left edge is `i`, its right edge `i + 1`.
 *
 * **One drop is a no-op, and only one.** A pane's *only* tab dropped on that
 * pane's *own* edge would rebuild an identical column in the same place. That
 * same sole tab dropped on a *different* pane's edge is an ordinary move.
 */
export function moveTabToNewPane(workspace: Workspace, tab: Tab, at: number): Workspace {
  const found = findTab(workspace, tab)
  if (found === null) return workspace

  const source = workspace.panes[found.pane]!
  const sole = source.tabs.length === 1
  if (sole && (at === found.pane || at === found.pane + 1)) return workspace

  const moved = dragged(source.tabs[found.tab]!)
  const removed = withoutTabAt(source, found.tab)
  let panes: Pane[] = workspace.panes.map((pane, p) => (p === found.pane ? removed : pane))
  let index = at

  if (removed.tabs.length === 0) {
    // Removed unconditionally, unlike `closeTab`: a pane is being *added* in the
    // same operation, so "last pane never goes" would only leave an empty column.
    panes = panes.filter((_, p) => p !== found.pane)
    if (index > found.pane) index -= 1
  }

  index = Math.max(0, Math.min(index, panes.length))
  return {
    panes: [...panes.slice(0, index), { tabs: [moved], active: 0 }, ...panes.slice(index)],
    active: index,
  }
}

/** Where a tab currently lives, by pane, or -1. */
function paneOfTab(workspace: Workspace, tab: Tab): number {
  return findTab(workspace, tab)?.pane ?? -1
}

/**
 * Which zones of pane `index` would actually *do* something with `tab`.
 *
 * **It asks the moves rather than restating their rules.** Both return the
 * workspace **by reference** when they would change nothing, so this cannot
 * drift from what a drop does. A hand-written rule misses that pane 1's left
 * edge and pane 0's right edge are *the same gap*: a sole tab dragged out of
 * pane 0 has three inert edges, not two.
 *
 * The middle is decided here rather than derived: the pane a drag came **from**
 * never offers it. Every split gesture crosses the body on the way to an edge,
 * and the strip already expresses that move.
 */
export function dropZones(workspace: Workspace, tab: Tab, index: number): PaneDropZone[] {
  const pane = workspace.panes[index]
  if (pane === undefined) return []
  const zones: PaneDropZone[] = []
  if (moveTabToNewPane(workspace, tab, index) !== workspace) zones.push('before')
  if (
    paneOfTab(workspace, tab) !== index &&
    moveTab(workspace, tab, { pane: index, index: pane.tabs.length }) !== workspace
  ) {
    zones.push('into')
  }
  if (moveTabToNewPane(workspace, tab, index + 1) !== workspace) zones.push('after')
  return zones
}
