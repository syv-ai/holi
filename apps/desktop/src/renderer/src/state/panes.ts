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

export type Tab = { kind: 'note'; path: string } | { kind: 'board' }

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
        tab.kind === 'note' && tab.path === from ? { kind: 'note', path: to } : tab,
      ),
    })),
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
