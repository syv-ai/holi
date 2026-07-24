/**
 * What is on screen: panes, each holding tabs.
 *
 * **A tab is not a note.** `architecture.md` constrains the pane system with
 * exactly that sentence, `vault-apps.md` §Tabs depends on it, and
 * `notes-editor.md` §Panes names the shape that forecloses it — a flat
 * `Map<path, …>`. So a tab is a discriminated union and the state is
 * `panes[] → tabs[]` from the first commit, even though plan 5 renders
 * `panes[0]` and nothing else. Adding a second pane later is then a second
 * element, not a rewrite.
 *
 * Preview-vs-pinned (VS Code's two-state model) is **plan 7**. Adding a
 * `pinned` flag later is additive; guessing its promotion rules now is not.
 */

import { atom } from 'jotai'

/** Open a note as a preview tab in the active pane — the action behind a
 *  wiki-link click from a surface that is not the editor (e.g. a task
 *  description on the board), which switches the view to that note. */
export const openNoteTabAtom = atom(null, (_get, set, path: string) => {
  set(workspaceAtom, (w) => openPreview(w, path))
})

/**
 * A tab is not a note (architecture.md). The `preview` flag ports VS Code's
 * two-state model: a preview tab (italic) is the single one that a single-click
 * *replaces* rather than adding to, so browsing a vault costs one tab. Absent or
 * false means pinned. The board tab has no flag — it is pinned by construction,
 * being unique.
 */
export type Tab = { kind: 'note'; path: string; preview?: boolean } | { kind: 'board' }

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
 *  is an open product question, and `.holi/settings.local.json` is where the
 *  answer would go (`notes-editor.md` §Panes). */
export const workspaceAtom = atom<Workspace>(emptyWorkspace())

function sameTab(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'note' && b.kind === 'note' ? a.path === b.path : true
}

/**
 * Open a tab in the active pane, or focus it if it is already there.
 *
 * Focusing rather than appending is not tidiness: two tabs over one file means
 * two buffers over one path, each with its own `base`, racing each other's
 * saves. The editor's whole reload story assumes one buffer per file.
 */
export function openTab(workspace: Workspace, tab: Tab): Workspace {
  return updatePane(workspace, (pane) => {
    const existing = pane.tabs.findIndex((t) => sameTab(t, tab))
    if (existing !== -1) return { ...pane, active: existing }
    return { tabs: [...pane.tabs, tab], active: pane.tabs.length }
  })
}

/**
 * Open the board — always the leftmost tab (index 0).
 *
 * The board is the one non-note surface and there is only ever one of it, so it
 * gets a fixed home rather than landing wherever it was opened. If it is already
 * open, focus it in place (do not move it); otherwise insert it at the front and
 * the notes slide right.
 */
export function openBoard(workspace: Workspace): Workspace {
  return updatePane(workspace, (pane) => {
    const existing = pane.tabs.findIndex((t) => t.kind === 'board')
    if (existing !== -1) return { ...pane, active: existing }
    return { tabs: [{ kind: 'board' }, ...pane.tabs], active: 0 }
  })
}

/**
 * Close a tab in the active pane.
 *
 * The active tab follows the *document*, not the index. Closing a tab to the
 * left of the active one shifts every index after it, so keeping the number
 * would silently move the user to a different file — a data-loss-shaped bug in
 * a UI that autosaves.
 *
 * An emptied pane stays. Plan 5 renders `panes[0]`, so a pane that deleted
 * itself with its last tab would leave nothing to render into; an empty pane is
 * the empty-editor state.
 */
export function closeTab(workspace: Workspace, index: number): Workspace {
  return updatePane(workspace, (pane) => {
    if (index < 0 || index >= pane.tabs.length) return pane
    const tabs = pane.tabs.filter((_, i) => i !== index)
    if (tabs.length === 0) return { tabs, active: -1 }
    // Closing the active tab falls back to its left-hand neighbour; closing any
    // other one keeps whatever was active where it now sits.
    const active =
      index === pane.active
        ? Math.max(0, index - 1)
        : pane.active > index
          ? pane.active - 1
          : pane.active
    return { tabs, active }
  })
}

/**
 * Single-click open: reuse the one preview tab (FR-15).
 *
 * If the note is already open, just focus it — clicking it again does not change
 * whether it is pinned. Otherwise, if a preview tab exists, replace it in place
 * (browsing costs one tab); if none does, add one. The new tab is a *preview*.
 */
export function openPreview(workspace: Workspace, path: string): Workspace {
  return updatePane(workspace, (pane) => {
    const existing = pane.tabs.findIndex(
      (t) => t.kind === 'note' && t.path === path,
    )
    if (existing !== -1) return { ...pane, active: existing }
    const previewIdx = pane.tabs.findIndex((t) => t.kind === 'note' && t.preview)
    const tab: Tab = { kind: 'note', path, preview: true }
    if (previewIdx !== -1) {
      return { ...pane, tabs: pane.tabs.map((t, i) => (i === previewIdx ? tab : t)), active: previewIdx }
    }
    return { tabs: [...pane.tabs, tab], active: pane.tabs.length }
  })
}

/** Double-click open (or open-and-pin): a pinned tab, focused. Pins the tab in
 *  place if it was already open as a preview. */
export function openPinned(workspace: Workspace, path: string): Workspace {
  return updatePane(workspace, (pane) => {
    const existing = pane.tabs.findIndex((t) => t.kind === 'note' && t.path === path)
    if (existing !== -1) {
      return {
        ...pane,
        tabs: pane.tabs.map((t, i) => (i === existing ? { kind: 'note', path } : t)),
        active: existing,
      }
    }
    return { tabs: [...pane.tabs, { kind: 'note', path }], active: pane.tabs.length }
  })
}

/** Promote a tab to pinned — the double-click-a-tab and edit-a-preview rules.
 *  No-op if the index is out of range or the tab is not a preview note. */
export function pinTab(workspace: Workspace, index: number): Workspace {
  return updatePane(workspace, (pane) => {
    const tab = pane.tabs[index]
    if (tab === undefined || tab.kind !== 'note' || !tab.preview) return pane
    return { ...pane, tabs: pane.tabs.map((t, i) => (i === index ? { kind: 'note', path: tab.path } : t)) }
  })
}

/** Pin whatever is active — the "editing promotes a preview tab" rule, so you
 *  can never lose your place by clicking away from something you typed in. */
export function pinActive(workspace: Workspace): Workspace {
  const pane = workspace.panes[workspace.active]
  return pane === undefined ? workspace : pinTab(workspace, pane.active)
}

/**
 * Point every open tab at a renamed note's new path (FR-11).
 *
 * A rename moves bytes, not tabs — indices and the active selection are
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

/** `retargetTab` for a whole batch (FR-11, folder/multi-move). One map, applied
 *  across all panes; a tab whose path is a `from` follows to its `to`. */
export function retargetTabs(workspace: Workspace, moves: { from: string; to: string }[]): Workspace {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) =>
        tab.kind === 'note' && map.has(tab.path) ? { ...tab, path: map.get(tab.path)! } : tab,
      ),
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
  const gone = (t: Tab) => t.kind === 'note' && paths.includes(t.path)
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => {
      if (!pane.tabs.some(gone)) return pane
      const activeTab = pane.tabs[pane.active]
      const tabs = pane.tabs.filter((t) => !gone(t))
      if (tabs.length === 0) return { tabs, active: -1 }
      if (activeTab !== undefined && !gone(activeTab)) return { tabs, active: tabs.indexOf(activeTab) }
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
