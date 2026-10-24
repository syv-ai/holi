/**
 * The fresh shell's panes and their tabs (docs/features/tabs-panes.md), as
 * pure functions over a `ShellWorkspace`: the main area is one to
 * `MAX_PANES` panes side by side, each with its own tabs and active tab, and
 * one of them focused, the one "open" means and the keys act on.
 *
 * A tab is a key (`state/tab-descriptor.ts`). **A tab is open once**, in one
 * pane: every opener focuses it where it already is, a split moves a tab
 * rather than copying it, and a move takes it out of its old pane. Two
 * editors on one document would race two autosaves.
 *
 * Every function returns the same workspace when it changes nothing, so a
 * caller can tell a no-op.
 */
import { parseTabKey, tabForPath, tabKey } from "./tab-descriptor"

/** Up to three panes: enough for a session beside a document beside the
 *  board, and the most one horizontal group of motion-panels holds flat (a
 *  sized pane each side of the one that fills). */
export const MAX_PANES = 3

export interface ShellPane {
  /** Stable for the pane's life: what its view is keyed on. */
  id: string
  /** Its tabs' keys, in strip order. */
  tabs: string[]
  /** The tab in front, or null for an empty pane. */
  active: string | null
  /** Its share of the main area's width, 0 to 1; the shares sum to 1. */
  share: number
}

export interface ShellWorkspace {
  panes: ShellPane[]
  /** The focused pane's id. */
  focused: string
  /** Closed tabs, last closed last, for Reopen closed tab. */
  closed: string[]
  /** The last number handed out, to New tabs and to panes. */
  seq: number
}

export function emptyWorkspace(): ShellWorkspace {
  return {
    panes: [{ id: "pane-0", tabs: [], active: null, share: 1 }],
    focused: "pane-0",
    closed: [],
    seq: 0,
  }
}

// ------------------------------------------------------------------ reading

export function focusedPane(ws: ShellWorkspace): ShellPane {
  return ws.panes.find((p) => p.id === ws.focused) ?? ws.panes[0]!
}

/** The focused pane's active tab. */
export function focusedTab(ws: ShellWorkspace): string | null {
  return focusedPane(ws).active
}

/** The pane holding `key`, or null. */
export function paneOf(ws: ShellWorkspace, key: string): ShellPane | null {
  return ws.panes.find((p) => p.tabs.includes(key)) ?? null
}

/** Every open tab, pane by pane. */
export function allTabs(ws: ShellWorkspace): string[] {
  return ws.panes.flatMap((p) => p.tabs)
}

function isNewKey(key: string | null): boolean {
  return key !== null && parseTabKey(key)?.kind === "new"
}

// ------------------------------------------------------------------ helpers

function withPane(
  ws: ShellWorkspace,
  id: string,
  update: (pane: ShellPane) => ShellPane
): ShellWorkspace {
  return {
    ...ws,
    panes: ws.panes.map((p) => (p.id === id ? update(p) : p)),
  }
}

/** A pane without `key`, its active tab handed to the neighbour after it,
 *  else the one before. */
function withoutTab(pane: ShellPane, key: string): ShellPane {
  const index = pane.tabs.indexOf(key)
  if (index === -1) return pane
  const tabs = pane.tabs.filter((t) => t !== key)
  const active =
    pane.active === key
      ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
      : pane.active
  return { ...pane, tabs, active }
}

/** Drop the empty panes, never the last one, handing each one's share to a
 *  neighbour and its focus to the pane that took its place. */
function dropEmptyPanes(ws: ShellWorkspace, keep?: string): ShellWorkspace {
  let next = ws
  for (;;) {
    if (next.panes.length <= 1) return next
    const at = next.panes.findIndex((p) => p.tabs.length === 0 && p.id !== keep)
    if (at === -1) return next
    next = removePaneAt(next, at)
  }
}

function removePaneAt(ws: ShellWorkspace, at: number): ShellWorkspace {
  const gone = ws.panes[at]!
  const heir = at > 0 ? at - 1 : 1
  const panes = ws.panes
    .map((p, i) => (i === heir ? { ...p, share: p.share + gone.share } : p))
    .filter((_, i) => i !== at)
  const focused = ws.focused === gone.id ? ws.panes[heir]!.id : ws.focused
  return { ...ws, panes, focused }
}

// ------------------------------------------------------------------ opening

/**
 * Open a tab, or focus it where it is (in any pane). Opened, it goes in the
 * focused pane after its active tab; from a New tab it takes that tab's place,
 * as in a browser, and so it does from any tab `replaces` says it may.
 */
export function openTab(
  ws: ShellWorkspace,
  key: string,
  replaces: (active: string) => boolean = isNewKey
): ShellWorkspace {
  const holder = paneOf(ws, key)
  if (holder !== null) {
    if (holder.id === ws.focused && holder.active === key) return ws
    return {
      ...withPane(ws, holder.id, (p) => ({ ...p, active: key })),
      focused: holder.id,
    }
  }
  const pane = focusedPane(ws)
  const blank =
    pane.active !== null && replaces(pane.active) ? pane.active : null
  return withPane(ws, pane.id, (p) => {
    if (blank !== null) {
      return {
        ...p,
        tabs: p.tabs.map((t) => (t === blank ? key : t)),
        active: key,
      }
    }
    const at = p.active === null ? p.tabs.length : p.tabs.indexOf(p.active) + 1
    return {
      ...p,
      tabs: [...p.tabs.slice(0, at), key, ...p.tabs.slice(at)],
      active: key,
    }
  })
}

/** A New tab in the focused pane, at its end. */
export function openNewTab(ws: ShellWorkspace): ShellWorkspace {
  const seq = ws.seq + 1
  const key = tabKey({ kind: "new", n: seq })
  const pane = focusedPane(ws)
  return {
    ...withPane(ws, pane.id, (p) => ({
      ...p,
      tabs: [...p.tabs, key],
      active: key,
    })),
    seq,
  }
}

/** Bring a pane's tab forward, focusing the pane. */
export function selectTab(
  ws: ShellWorkspace,
  paneId: string,
  key: string
): ShellWorkspace {
  const pane = ws.panes.find((p) => p.id === paneId)
  if (pane === undefined || !pane.tabs.includes(key)) return ws
  if (pane.active === key && ws.focused === paneId) return ws
  return {
    ...withPane(ws, paneId, (p) => ({ ...p, active: key })),
    focused: paneId,
  }
}

/** Focus a pane, as a click in it does. */
export function focusPane(ws: ShellWorkspace, paneId: string): ShellWorkspace {
  if (ws.focused === paneId || !ws.panes.some((p) => p.id === paneId)) return ws
  return { ...ws, focused: paneId }
}

/** The focused pane's tab `step` places from its active one, wrapping. */
export function stepTab(ws: ShellWorkspace, step: number): ShellWorkspace {
  const pane = focusedPane(ws)
  if (pane.tabs.length === 0) return ws
  const at = pane.active === null ? -1 : pane.tabs.indexOf(pane.active)
  const from = at < 0 ? (step > 0 ? -1 : 0) : at
  const n = pane.tabs.length
  const key = pane.tabs[(((from + step) % n) + n) % n]!
  return selectTab(ws, pane.id, key)
}

/** The focused pane's tab at `index`; 8 is its last, as ⌘9 in a browser. */
export function gotoTab(ws: ShellWorkspace, index: number): ShellWorkspace {
  const pane = focusedPane(ws)
  const key = index === 8 ? pane.tabs[pane.tabs.length - 1] : pane.tabs[index]
  return key === undefined ? ws : selectTab(ws, pane.id, key)
}

// ------------------------------------------------------------------ closing

/** Close a tab wherever it is. A split pane whose last tab closes goes with
 *  it; the last pane stays, empty. */
export function closeTab(ws: ShellWorkspace, key: string): ShellWorkspace {
  const pane = paneOf(ws, key)
  if (pane === null) return ws
  const next = {
    ...withPane(ws, pane.id, (p) => withoutTab(p, key)),
    closed: [...ws.closed, key],
  }
  return dropEmptyPanes(next)
}

/** Close every tab of `key`'s pane but `key`, which comes forward. */
export function closeOtherTabs(
  ws: ShellWorkspace,
  key: string
): ShellWorkspace {
  const pane = paneOf(ws, key)
  if (pane === null) return ws
  const others = pane.tabs.filter((t) => t !== key)
  if (others.length === 0 && pane.active === key) return ws
  return {
    ...withPane(ws, pane.id, (p) => ({ ...p, tabs: [key], active: key })),
    focused: pane.id,
    closed: [...ws.closed, ...others],
  }
}

/** Close every tab of a pane; a split pane goes with them. */
export function closePaneTabs(
  ws: ShellWorkspace,
  paneId: string
): ShellWorkspace {
  const pane = ws.panes.find((p) => p.id === paneId)
  if (pane === undefined || pane.tabs.length === 0) {
    return pane === undefined ? ws : dropEmptyPanes(ws)
  }
  const next = {
    ...withPane(ws, paneId, (p) => ({ ...p, tabs: [], active: null })),
    closed: [...ws.closed, ...pane.tabs],
  }
  return dropEmptyPanes(next)
}

/** Close a pane, tabs and all; the last pane only empties. */
export const closePane = closePaneTabs

/** The last closed tab, open again; closed New tabs are not worth it. */
export function reopenClosed(ws: ShellWorkspace): ShellWorkspace {
  const closed = [...ws.closed]
  for (;;) {
    const key = closed.pop()
    if (key === undefined)
      return ws.closed.length === 0 ? ws : { ...ws, closed }
    if (isNewKey(key) || paneOf(ws, key) !== null) continue
    return openTab({ ...ws, closed }, key)
  }
}

// ------------------------------------------------------------------ panes

/**
 * Split right: a new pane after `paneId`, focused, taking half its share.
 * With `key`, that tab moves into it, unless it is its pane's only tab, when
 * the new pane opens on a New tab instead (moving it would leave nothing
 * behind to split). At `MAX_PANES` nothing happens.
 */
export function splitRight(
  ws: ShellWorkspace,
  paneId: string = ws.focused,
  key?: string
): ShellWorkspace {
  if (ws.panes.length >= MAX_PANES) return ws
  const at = ws.panes.findIndex((p) => p.id === paneId)
  if (at === -1) return ws
  const source = ws.panes[at]!
  const seq = ws.seq + 1
  const id = `pane-${seq}`
  const moving =
    key !== undefined && source.tabs.includes(key) && source.tabs.length > 1
  const tab = moving ? key : tabKey({ kind: "new", n: seq })
  const half = source.share / 2
  const fresh: ShellPane = { id, tabs: [tab], active: tab, share: half }
  const left = moving
    ? { ...withoutTab(source, key), share: half }
    : { ...source, share: half }
  const panes = [
    ...ws.panes.slice(0, at),
    left,
    fresh,
    ...ws.panes.slice(at + 1),
  ]
  return { ...ws, panes, focused: id, seq }
}

/**
 * Move a tab into another pane, at `index` (its end by default), focusing it
 * there. The pane it leaves goes if it is left empty.
 */
export function moveTab(
  ws: ShellWorkspace,
  key: string,
  toPaneId: string,
  index?: number
): ShellWorkspace {
  const from = paneOf(ws, key)
  const to = ws.panes.find((p) => p.id === toPaneId)
  if (from === null || to === undefined) return ws
  if (from.id === to.id) {
    if (index === undefined) return selectTab(ws, to.id, key)
    const tabs = from.tabs.filter((t) => t !== key)
    const at = Math.max(0, Math.min(index, tabs.length))
    tabs.splice(at, 0, key)
    if (tabs.every((t, i) => t === from.tabs[i])) return ws
    return withPane(ws, from.id, (p) => ({ ...p, tabs }))
  }
  let next = withPane(ws, from.id, (p) => withoutTab(p, key))
  next = withPane(next, to.id, (p) => {
    const at = Math.max(0, Math.min(index ?? p.tabs.length, p.tabs.length))
    return {
      ...p,
      tabs: [...p.tabs.slice(0, at), key, ...p.tabs.slice(at)],
      active: key,
    }
  })
  return dropEmptyPanes({ ...next, focused: to.id }, to.id)
}

/** The pane beside `paneId` on `side`, or null at that edge. */
export function paneBeside(
  ws: ShellWorkspace,
  paneId: string,
  side: "left" | "right"
): ShellPane | null {
  const at = ws.panes.findIndex((p) => p.id === paneId)
  if (at === -1) return null
  return ws.panes[at + (side === "left" ? -1 : 1)] ?? null
}

/**
 * Open `key` beside the focused pane: in the pane to its right, or a new one
 * there while there is room, else the pane to its left. A tab already open
 * moves there.
 */
export function openBeside(ws: ShellWorkspace, key: string): ShellWorkspace {
  const right = paneBeside(ws, ws.focused, "right")
  const holder = paneOf(ws, key)
  if (right === null && ws.panes.length < MAX_PANES) {
    // A new pane, its New tab given over to `key`.
    const split = splitRight(ws, ws.focused)
    const fresh = focusedPane(split)
    const placed = withPane(split, fresh.id, (p) => ({
      ...p,
      tabs: [key],
      active: key,
    }))
    if (holder === null) return placed
    return dropEmptyPanes(
      withPane(placed, holder.id, (p) => withoutTab(p, key)),
      fresh.id
    )
  }
  const target = right ?? paneBeside(ws, ws.focused, "left")
  if (target === null) return openTab(ws, key)
  if (holder === null) {
    return {
      ...withPane(ws, target.id, (p) => ({
        ...p,
        tabs: [...p.tabs, key],
        active: key,
      })),
      focused: target.id,
    }
  }
  return moveTab(ws, key, target.id)
}

/** The panes' shares, in pane order, normalised to sum to 1. */
export function setShares(
  ws: ShellWorkspace,
  shares: number[]
): ShellWorkspace {
  if (shares.length !== ws.panes.length) return ws
  const sum = shares.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return ws
  const next = shares.map((s) => s / sum)
  if (next.every((s, i) => Math.abs(s - ws.panes[i]!.share) < 1e-4)) return ws
  return { ...ws, panes: ws.panes.map((p, i) => ({ ...p, share: next[i]! })) }
}

// ------------------------------------------------------------------ files

/** A moved document's tab follows it to its new path, in every pane. */
export function retargetTabs(
  ws: ShellWorkspace,
  moves: readonly { from: string; to: string }[]
): ShellWorkspace {
  const to = new Map(
    moves.map((m) => [tabKey(tabForPath(m.from)), tabKey(tabForPath(m.to))])
  )
  const move = (key: string) => to.get(key) ?? key
  if (!allTabs(ws).some((k) => to.has(k))) return ws
  return {
    ...ws,
    panes: ws.panes.map((p) => ({
      ...p,
      tabs: p.tabs.map(move),
      active: p.active === null ? null : move(p.active),
    })),
    closed: ws.closed.map(move),
  }
}

/** Close the tabs `gone` says are gone (a deleted file, a removed session),
 *  in every pane, without offering them to Reopen. */
export function closeTabsWhere(
  ws: ShellWorkspace,
  gone: (key: string) => boolean
): ShellWorkspace {
  if (!allTabs(ws).some(gone)) return ws
  let next = ws
  for (const key of allTabs(ws).filter(gone)) {
    const pane = paneOf(next, key)!
    next = withPane(next, pane.id, (p) => withoutTab(p, key))
  }
  return dropEmptyPanes(next)
}

// ------------------------------------------------------------------ split view

/** Where a tab dropped on a pane goes: beside it, or into it. */
export type DropZone = "left" | "right" | "center"

/** A new pane holding `key` on `side` of `paneId`, focused, taking half that
 *  pane's share; `key` leaves the pane it was in. */
function insertPaneWith(
  ws: ShellWorkspace,
  paneId: string,
  side: "left" | "right",
  key: string
): ShellWorkspace {
  const at = ws.panes.findIndex((p) => p.id === paneId)
  const target = ws.panes[at]!
  const seq = ws.seq + 1
  const id = `pane-${seq}`
  const half = target.share / 2
  const fresh: ShellPane = { id, tabs: [key], active: key, share: half }
  const holder = paneOf(ws, key)
  const panes = ws.panes.map((p) => {
    const left = holder !== null && p.id === holder.id ? withoutTab(p, key) : p
    return p.id === paneId ? { ...left, share: half } : left
  })
  panes.splice(side === "left" ? at : at + 1, 0, fresh)
  return dropEmptyPanes({ ...ws, panes, focused: id, seq }, id)
}

/**
 * A tab dropped on a pane (docs/features/tabs-panes.md, Split view): on its
 * left or right edge it opens a pane of its own on that side, while there is
 * room; in its middle, or at `MAX_PANES`, it moves into that pane. A drop
 * that would change nothing (a pane's only tab dropped beside itself, a tab
 * dropped into its own pane) returns the same workspace, which is how a drop
 * target tells whether to take the drop.
 */
export function dropTab(
  ws: ShellWorkspace,
  key: string,
  paneId: string,
  zone: DropZone
): ShellWorkspace {
  const target = ws.panes.find((p) => p.id === paneId)
  const holder = paneOf(ws, key)
  if (target === undefined || holder === null) return ws
  const split = zone !== "center" && ws.panes.length < MAX_PANES
  if (!split) {
    return holder.id === target.id ? ws : moveTab(ws, key, target.id)
  }
  if (holder.id === target.id && holder.tabs.length === 1) return ws
  return insertPaneWith(ws, target.id, zone as "left" | "right", key)
}

/**
 * Open in split view: `key` goes beside the pane it is in, into the pane on
 * its right, else a new pane there while there is room, else the pane on its
 * left. A pane's only tab leaves a New tab behind, so the split has two sides.
 * A tab not open yet opens beside the focused pane.
 */
export function openInSplit(ws: ShellWorkspace, key: string): ShellWorkspace {
  const holder = paneOf(ws, key)
  if (holder === null) return openBeside(ws, key)
  const right = paneBeside(ws, holder.id, "right")
  if (right !== null) return moveTab(ws, key, right.id)
  if (ws.panes.length < MAX_PANES) {
    if (holder.tabs.length > 1) {
      return insertPaneWith(ws, holder.id, "right", key)
    }
    // Its only tab: a New tab takes its place, and it moves right.
    const blank = tabKey({ kind: "new", n: ws.seq + 1 })
    const seeded = withPane({ ...ws, seq: ws.seq + 1 }, holder.id, (p) => ({
      ...p,
      tabs: [blank, key],
      active: blank,
    }))
    return insertPaneWith(seeded, holder.id, "right", key)
  }
  const left = paneBeside(ws, holder.id, "left")
  return left === null ? ws : moveTab(ws, key, left.id)
}
