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
 *
 * **The second pane is real now.** The shape was paid for early precisely so
 * that this would be an addition rather than a rewrite, and it was: `splitPane`,
 * `closePane`, `focusPane` and `openInNewPane` below, plus one strengthening of
 * a rule that was already there — see `findTab`.
 */

import { atom } from 'jotai'
import type { PaneDropZone } from '@/lib/tab-drop'

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

/**
 * A tab is not a note (architecture.md). The `preview` flag ports VS Code's
 * two-state model: a preview tab (italic) is the single one that a single-click
 * *replaces* rather than adding to, so browsing a vault costs one tab. Absent or
 * false means pinned. The board tab has no flag — it is pinned by construction,
 * being unique.
 */
/** The unique surfaces: one board, one agenda, one mail. Opened from a nav
 *  button rather than from a file, and pinned by construction.
 *
 *  **Named, not derived.** This was `Exclude<Tab, {kind:'note'}>['kind']`, which
 *  encoded "every tab that is not a note is unique" — true until vault apps, of
 *  which there are as many as the vault holds. Derived, `openSingleton(w,'app')`
 *  typechecked and would have opened a tab with no `appId` at all.
 *
 *  **Settings is one of these rather than a modal** (#16): a modal blocks the
 *  window while you compare a setting against the vault it applies to, and a tab
 *  is splittable beside the note you are changing it for.
 *
 *  **History joined them for the same reason.** It was a full-screen modal, and
 *  reading what a commit changed is exactly the thing you want beside the note
 *  it changed. The per-NOTE history side panel is untouched: that one is the
 *  first of a set of sidebars a note unfolds, which is a different surface from
 *  a vault-wide one. */
export type SingletonTab = 'board' | 'agenda' | 'mail' | 'settings' | 'history'

/**
 * The two categories are now named rather than derived (see `SingletonTab`): a
 * tab is either *of* something — a note by path, an app by id — or it is one of
 * the singleton surfaces.
 */
export type Tab =
  | { kind: 'note'; path: string; preview?: boolean }
  /** A vault app (D74), identified by its directory name under `.holi/apps/`.
   *  There is one tab per app, not one per vault. */
  | { kind: 'app'; appId: string }
  /**
   * One of the vault's agent sessions (D101), by the id main minted for it.
   *
   * One tab per session, as with an app. **Closing the tab does not end the
   * session** — it keeps running, and the sidebar's list is how you get back to
   * it. That split is new: in the drawer a tab WAS the session, so closing one
   * killed it and had to ask first. A tab is a view now, and a view is free to
   * close.
   */
  | { kind: 'session'; id: string }
  /** The board, the Google agenda, mail (D67), settings and history — one of
   *  each, ever. */
  | { kind: SingletonTab }

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
 *  answer would go (`notes-editor.md` §Panes). */
export const workspaceAtom = atom<Workspace>(emptyWorkspace())

function sameTab(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'note' && b.kind === 'note') return a.path === b.path
  if (a.kind === 'app' && b.kind === 'app') return a.appId === b.appId
  if (a.kind === 'session' && b.kind === 'session') return a.id === b.id
  // Everything left is a singleton, of which there is one, ever. A kind that
  // carries an identity and is NOT listed above falls in here and reads as
  // "already open" whatever it names — which is how two different sessions
  // briefly shared one tab.
  return true
}

/**
 * Where a tab already is, across **every** pane — or null.
 *
 * One buffer per file was a per-pane rule while there was one pane, and a second
 * pane turns it into a hole: the same note open in two panes is two `EditorPane`
 * instances over one path, each holding its own `base` and each autosaving on
 * its own debounce, with the other one's write arriving as an "external" change
 * to reconcile. That is the data-loss-shaped bug the rule exists to prevent, and
 * it does not care which pane the second buffer is in.
 *
 * So the rule is now global, and it is the reason a split cannot simply
 * duplicate the tab it was invoked on.
 */
function findTab(workspace: Workspace, tab: Tab): { pane: number; tab: number } | null {
  for (let p = 0; p < workspace.panes.length; p++) {
    const i = workspace.panes[p]!.tabs.findIndex((t) => sameTab(t, tab))
    if (i !== -1) return { pane: p, tab: i }
  }
  return null
}

/** Focus a pane, and a tab within it. The workhorse behind "it is already open
 *  over there" — every opener routes through this rather than adding a copy. */
function focusExisting(workspace: Workspace, at: { pane: number; tab: number }): Workspace {
  return {
    panes: workspace.panes.map((pane, i) => (i === at.pane ? { ...pane, active: at.tab } : pane)),
    active: at.pane,
  }
}

/**
 * Open a tab in the active pane, or focus it if it is already there.
 *
 * Focusing rather than appending is not tidiness: two tabs over one file means
 * two buffers over one path, each with its own `base`, racing each other's
 * saves. The editor's whole reload story assumes one buffer per file.
 */
export function openTab(workspace: Workspace, tab: Tab): Workspace {
  const existing = findTab(workspace, tab)
  if (existing !== null) return focusExisting(workspace, existing)
  return updatePane(workspace, (pane) => ({ tabs: [...pane.tabs, tab], active: pane.tabs.length }))
}

/**
 * Open a singleton surface — always a leftmost tab.
 *
 * The non-note surfaces are unique, so each gets a fixed home rather than
 * landing wherever it was opened. If it is already open, focus it **in place**
 * (do not move it, or a second click would shuffle the strip under the user);
 * otherwise insert it at the front and the notes slide right.
 */
export function openSingleton(workspace: Workspace, kind: SingletonTab): Workspace {
  const existing = findTab(workspace, { kind })
  if (existing !== null) return focusExisting(workspace, existing)
  return updatePane(workspace, (pane) => ({ tabs: [{ kind }, ...pane.tabs], active: 0 }))
}

export function openBoard(workspace: Workspace): Workspace {
  return openSingleton(workspace, 'board')
}

export function openAgenda(workspace: Workspace): Workspace {
  return openSingleton(workspace, 'agenda')
}

export function openMail(workspace: Workspace): Workspace {
  return openSingleton(workspace, 'mail')
}

export function openSettings(workspace: Workspace): Workspace {
  return openSingleton(workspace, 'settings')
}

/** The vault's commit history, as a tab. */
export function openHistory(workspace: Workspace): Workspace {
  return openSingleton(workspace, 'history')
}

/** Open a vault app in the active pane, or focus it if it is already there.
 *  Dedupes by `appId`, exactly as `openTab` dedupes a note by path — two frames
 *  over one app are two running copies of it, and the second is not the one you
 *  were looking at. Appended rather than inserted leftmost: an app is opened
 *  from the sidebar like a file, not from the nav rail like a singleton. */
export function openApp(workspace: Workspace, appId: string): Workspace {
  return openTab(workspace, { kind: 'app', appId })
}

/** Show one agent session in the active pane, or focus its tab if it is already
 *  open somewhere. Deduped by session id for the same reason an app is deduped
 *  by its id: two terminals over one PTY would both be attached to it, and only
 *  one of them would be the one you had scrolled. */
export function openSession(workspace: Workspace, id: string): Workspace {
  return openTab(workspace, { kind: 'session', id })
}

/**
 * A pane with one tab removed, its active index following the **document**.
 *
 * Closing the active tab falls back to its left-hand neighbour; removing any
 * other one keeps whatever was active where it now sits. Shared, because a move
 * performs exactly the same removal — and two copies of this rule would be two
 * chances to silently put the user on a different file.
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
 * The active tab follows the *document*, not the index. Closing a tab to the
 * left of the active one shifts every index after it, so keeping the number
 * would silently move the user to a different file — a data-loss-shaped bug in
 * a UI that autosaves.
 *
 * **An emptied pane goes, unless it is the last one.** Closing the final tab of
 * a split is how you unsplit — anything else would leave a permanent empty
 * column that only a second, separate gesture could remove. The last pane always
 * stays: an empty pane is the empty-editor state, and a workspace with no panes
 * has nothing to render into.
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
 * Derived by RUNNING `closeTab` rather than by restating its rule — "the pane
 * had one tab and it is not the last pane" is easy to write down and easy to let
 * drift from the thing it describes. Running it means the answer is always
 * exactly what the close is about to do.
 *
 * The caller is the shell, which has to know BEFORE it closes: a pane that is
 * going needs to play its exit first, and React unmounts it the instant state
 * says it is gone.
 */
export function closingTabRemovesPane(workspace: Workspace, index: number): boolean {
  return closeTab(workspace, index).panes.length < workspace.panes.length
}

/**
 * Single-click open: reuse the one preview tab (FR-15).
 *
 * If the note is already open, just focus it — clicking it again does not change
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

/** `pinTab` against a named pane. `openPinned` needs it: the note it is asked to
 *  pin may already be open in a pane that is not the active one, and focusing it
 *  there is the whole point of the cross-pane lookup. */
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
export function retargetTabs(
  workspace: Workspace,
  moves: { from: string; to: string }[],
): Workspace {
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
 * Follow a renamed app to its new id, in every pane.
 *
 * `retargetTabs` cannot do this: it keys on `path`, and an app tab has no path —
 * its identity is `appId`, which is the directory name under `.holi/apps/` and
 * the `holi-app://` host both. So a rename that only ran `retargetTabs` would
 * leave the open tab pointing at an id with nothing behind it, and the frame
 * would render the "was deleted" tombstone for an app that is very much alive.
 */
export function retargetAppTab(workspace: Workspace, from: string, to: string): Workspace {
  if (from === to) return workspace
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) =>
        tab.kind === 'app' && tab.appId === from ? { ...tab, appId: to } : tab,
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
  return closeTabsWhere(workspace, (t) => t.kind === 'note' && paths.includes(t.path))
}

/**
 * Close the tabs of sessions that are no longer in main's list.
 *
 * A session leaves that list when it is **ended**, not when it exits: an exited
 * session keeps its place, and its tab with it, so the last thing it printed is
 * still there to read. What this closes is a terminal attached to a session that
 * has been disposed of — by the End action, by a vault switch, or by the app
 * closing the vault under it.
 */
export function closeSessionTabs(workspace: Workspace, liveIds: string[]): Workspace {
  return closeTabsWhere(workspace, (t) => t.kind === 'session' && !liveIds.includes(t.id))
}

/**
 * Every pane with the matching tabs removed, each pane's active index following
 * the **document** rather than the position.
 *
 * Shared by both callers above, and by the two for one reason: the rule for
 * where the selection lands when tabs are removed underneath it is fiddly
 * enough that a second copy would be a second answer.
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
 *
 * The array has held more than one element since the first commit; these are the
 * operations that finally put something in it.
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
 * Empty, and not a copy of the active tab, which is what VS Code and Obsidian
 * both do. They can: their editors tolerate two views of one buffer. Holi's does
 * not — one buffer per file is the rule the whole external-reload story rests on
 * (`findTab` above), so duplicating the tab would be handing the user two
 * autosaves racing over one path, which is worse than an empty pane.
 *
 * So a split makes room, and the next thing you open fills it. The richer
 * gesture is `openInNewPane` — "open THIS beside what I am reading" — which is
 * what the tree and the apps list offer, and what people actually reach for.
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
 * Already open somewhere? Focus it there. That is not a shortcut — it is the
 * one-buffer rule again, and it means the menu item is safe to hit twice.
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
 * The board's card click. `openInNewPane` is the wrong tool for it: that always
 * makes a pane, so clicking five cards would leave you with five panes and one
 * board squeezed against the edge. This reuses the pane to the right if there is
 * one and splits only when there is not, which is what "open it next to what I
 * am looking at" actually means when you do it repeatedly.
 *
 * Preview rather than pinned, for the same reason the file tree's single click
 * is: browsing the board costs one tab, and the first edit pins it.
 *
 * Already open anywhere? Focus it there. That is the one-buffer rule (`findTab`)
 * and it is the whole reason the board no longer holds a detail panel of its
 * own: two editors over one task file is two autosaves racing over one path.
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
 * Close a whole pane. **The last one never goes** — an empty pane is the
 * empty-editor state, and a workspace with no panes has nothing to render into.
 *
 * Focus lands on the neighbour, chosen the same way `closeTab` chooses one: the
 * left-hand pane, unless the closed one was leftmost.
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
 * Moving a tab (D78)
 *
 * A move is the one thing a split deliberately cannot do. `splitPane` refuses to
 * duplicate the tab it was invoked on because two views of one path are two
 * buffers racing each other's autosave (see `findTab`) — but *relocating* that
 * buffer breaks nothing, because there is still exactly one of it. Remove, then
 * insert; never copy.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A tab as it should land after a drag: pinned.
 *
 * Dragging is intent, the way editing is (`pinActive`). Without this the gesture
 * eats itself — place a preview tab deliberately, then single-click anything in
 * the tree, and `openPreview` replaces it *in place*, destroying the tab you
 * just positioned. The `preview` key is dropped rather than set false, matching
 * what `pinTabIn` writes.
 */
function dragged(tab: Tab): Tab {
  return tab.kind === 'note' && tab.preview ? { kind: 'note', path: tab.path } : tab
}

/**
 * Move a tab to `dest` — one function for a reorder *and* a cross-pane move.
 *
 * The caller passes the tab's **identity**, not its location: `findTab` already
 * spans the workspace, so a strip never has to learn where a dropped tab came
 * from, and a drag carries a name rather than a pair of indices that could go
 * stale between the `dragstart` and the `drop`.
 *
 * `dest.index` is read against the destination pane's tabs **as they are now** —
 * "insert before whatever currently sits there". So a rightward move within one
 * pane must decrement after the removal, or the target slides out from under the
 * drop and everything lands one place short.
 *
 * **A reorder rearranges; it does not navigate.** Within a pane, the active tab
 * follows the *document* (`closeTab`'s rule) — tidying a full strip while
 * reading one file must not drop you into whichever tab you happened to drag. A
 * cross-pane move is different in kind: the destination shows what you dropped
 * into it, and the workspace focuses that pane, because that is where you are
 * now looking.
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
  // What the source pane was looking at, held as the document rather than as a
  // number — the only form of it that survives a removal.
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

  // An emptied source pane goes — `closeTab`'s rule, and the difference between
  // unsplitting by dragging your last tab away and a permanent empty column.
  // It can never be the *last* pane: emptying one requires a different pane to
  // move into, so reaching here means there were at least two.
  if (removed.tabs.length === 0) {
    return {
      panes: panes.filter((_, p) => p !== found.pane),
      active: dest.pane > found.pane ? dest.pane - 1 : dest.pane,
    }
  }
  return { panes, active: dest.pane }
}

/**
 * Move a tab into a brand-new pane, inserted at `at` — the edge-drop.
 *
 * `at` is an index into `panes` (`0..panes.length`), read against the array as
 * it is now: dropping on pane `i`'s left edge is `i`, its right edge `i + 1`.
 *
 * **One drop is a no-op, and only one.** A pane's *only* tab dropped on that
 * pane's *own* edge would remove the column and rebuild an identical one in the
 * same place — a flicker, not a move. The guard has to be exactly this narrow:
 * that same sole tab dropped on a *different* pane's edge is an ordinary move,
 * and it does collapse the pane it came from.
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
    // same operation, so the "last pane never goes" rule would leave an empty
    // column beside the new one rather than protect anything.
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
 * drift from what a drop actually does — and it drifted the moment there were
 * two panes. Pane 1's left edge and pane 0's right edge are *the same gap*, so a
 * sole tab dragged out of pane 0 has **three** inert edges around it, not two;
 * a rule written out by hand had only ever counted its own pane's. That edge lit
 * up, accepted the drop, and did nothing.
 *
 * The middle is the one zone decided here rather than derived: the pane a drag
 * came **from** never offers it, even when a drop there would move something
 * (to the end of its own strip). Every split gesture crosses the body on the way
 * to an edge, and a full-pane wash on all of them is noise — the strip already
 * expresses that move anyway.
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
