/**
 * The fresh shell's tabs and split views (docs/features/tabs-panes.md), as
 * pure functions over a `ShellWorkspace`, after Arc's: **one strip** of
 * entries, one of them active. An entry is either a single view (a tab key,
 * `state/tab-descriptor.ts`) or a **split**: one strip entry holding two or
 * three views side by side, one of them focused. Selecting a split shows its
 * members side by side; selecting any other entry shows that view alone, the
 * split staying in the strip as its own entry.
 *
 * **A view is open once**, as an entry or as one member of one split: every
 * opener selects it where it is, and putting a view into a split takes it
 * out of its old place. Two editors on one document would race two
 * autosaves.
 *
 * Every function returns the same workspace when it changes nothing, so a
 * caller (a drop target asking whether to take a drop) can tell a no-op.
 */
import { parseTabKey, tabForPath, tabKey } from "./tab-descriptor"

/** Up to four views in a split: a session beside a document beside the
 *  board beside an app, each still wide enough to use on a laptop. */
export const MAX_SPLIT = 4

/** A split view: one strip entry, its members side by side. */
export interface ShellSplit {
  /** `holi:split:<n>`: a `holi:` key no tab kind parses, so it never meets
   *  a tab key (`tabKey` only writes kinds it knows). */
  id: string
  /** Its members' tab keys, left to right; two or three. */
  views: string[]
  /** Each member's share of the width, 0 to 1, summing to 1. */
  shares: number[]
  /** The focused member's key: where "open" lands, what ⌘W closes. */
  focused: string
}

/** A strip entry: one view by its tab key, or a split. */
export type ShellEntry = string | ShellSplit

/** What Reopen closed tab brings back: a tab, or a split as a split. */
export type ClosedEntry = string | { views: string[]; shares: number[] }

export interface ShellWorkspace {
  /** The strip, in order. */
  entries: ShellEntry[]
  /** The active entry's id (`entryId`), or null with nothing open. */
  active: string | null
  /** Closed entries, last closed last, for Reopen closed tab. */
  closed: ClosedEntry[]
  /** The last number handed out, to New tabs and to splits. */
  seq: number
}

export function emptyWorkspace(): ShellWorkspace {
  return { entries: [], active: null, closed: [], seq: 0 }
}

// ------------------------------------------------------------------ reading

export function isSplit(
  entry: ShellEntry | null | undefined
): entry is ShellSplit {
  return typeof entry === "object" && entry !== null
}

/** An entry's id: a single view's key, a split's own id. */
export function entryId(entry: ShellEntry): string {
  return isSplit(entry) ? entry.id : entry
}

/** The views an entry holds. */
export function entryViews(entry: ShellEntry): string[] {
  return isSplit(entry) ? entry.views : [entry]
}

export function activeEntry(ws: ShellWorkspace): ShellEntry | null {
  if (ws.active === null) return null
  return ws.entries.find((e) => entryId(e) === ws.active) ?? null
}

/** The active entry when it is a split, else null. */
export function activeSplit(ws: ShellWorkspace): ShellSplit | null {
  const entry = activeEntry(ws)
  return isSplit(entry) ? entry : null
}

/** The view in front: the active single entry, or the active split's
 *  focused member. What the sidebar marks and the keys act on. */
export function focusedTab(ws: ShellWorkspace): string | null {
  const entry = activeEntry(ws)
  if (entry === null) return null
  return isSplit(entry) ? entry.focused : entry
}

/** The entry holding `key`, as itself or as a member, or null. */
export function entryOf(ws: ShellWorkspace, key: string): ShellEntry | null {
  return ws.entries.find((e) => entryViews(e).includes(key)) ?? null
}

/** Every open view, entry by entry. */
export function allTabs(ws: ShellWorkspace): string[] {
  return ws.entries.flatMap(entryViews)
}

/** The strip's entry ids, in order. */
export function entryIds(ws: ShellWorkspace): string[] {
  return ws.entries.map(entryId)
}

function isNewKey(key: string | null): boolean {
  return key !== null && parseTabKey(key)?.kind === "new"
}

// ------------------------------------------------------------------ helpers

function indexOfEntry(ws: ShellWorkspace, id: string): number {
  return ws.entries.findIndex((e) => entryId(e) === id)
}

function evenShares(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

function normalise(shares: number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0)
  return sum > 0 ? shares.map((s) => s / sum) : evenShares(shares.length)
}

function nextSplitId(ws: ShellWorkspace): { id: string; seq: number } {
  const seq = ws.seq + 1
  return { id: `holi:split:${seq}`, seq }
}

function replaceEntryAt(
  ws: ShellWorkspace,
  at: number,
  entry: ShellEntry
): ShellEntry[] {
  return ws.entries.map((e, i) => (i === at ? entry : e))
}

/** A split without `key`: its share goes to the neighbour before it (else
 *  after), its focus to the member after it (else before). A split left
 *  with one view is that view's tab. */
function splitWithout(split: ShellSplit, key: string): ShellEntry {
  const at = split.views.indexOf(key)
  if (at === -1) return split
  const views = split.views.filter((v) => v !== key)
  if (views.length === 1) return views[0]!
  const shares = split.shares.filter((_, i) => i !== at)
  const heir = at > 0 ? at - 1 : 0
  shares[heir] = (shares[heir] ?? 0) + (split.shares[at] ?? 0)
  const focused =
    split.focused === key
      ? views[Math.min(at, views.length - 1)]!
      : split.focused
  return { ...split, views, shares: normalise(shares), focused }
}

/**
 * The workspace with `key` taken out of wherever it is (its own entry, or a
 * split's member), with nothing pushed to Reopen. A split left with one view
 * becomes that view's tab, in place; the active entry follows.
 */
function detach(ws: ShellWorkspace, key: string): ShellWorkspace {
  const at = ws.entries.findIndex((e) => entryViews(e).includes(key))
  if (at === -1) return ws
  const entry = ws.entries[at]!
  if (!isSplit(entry)) {
    const entries = ws.entries.filter((_, i) => i !== at)
    const heir = entries[Math.min(at, entries.length - 1)]
    const active =
      ws.active === key
        ? heir === undefined
          ? null
          : entryId(heir)
        : ws.active
    return { ...ws, entries, active }
  }
  const left = splitWithout(entry, key)
  const entries = replaceEntryAt(ws, at, left)
  const active = ws.active === entry.id ? entryId(left) : ws.active
  return { ...ws, entries, active }
}

/** Insert `entry` at strip `index` (clamped), making it active unless
 *  `select` is false. */
function insertEntry(
  ws: ShellWorkspace,
  entry: ShellEntry,
  index: number,
  select = true
): ShellWorkspace {
  const at = Math.max(0, Math.min(index, ws.entries.length))
  const entries = [...ws.entries.slice(0, at), entry, ...ws.entries.slice(at)]
  return { ...ws, entries, active: select ? entryId(entry) : ws.active }
}

/** Where a new entry goes: after the active one, else at the end. */
function afterActive(ws: ShellWorkspace): number {
  const at = ws.active === null ? -1 : indexOfEntry(ws, ws.active)
  return at === -1 ? ws.entries.length : at + 1
}

/**
 * The split `splitId` with its member `member` replaced by `key`, focused
 * and active. The view replaced keeps a tab of its own right after the
 * split, so nothing is lost, unless `drop` says it is a blank to give up (a
 * New tab). `key` must not be open anywhere (detach it first).
 */
function replaceIn(
  ws: ShellWorkspace,
  splitId: string,
  member: string,
  key: string,
  drop: (key: string) => boolean = isNewKey
): ShellWorkspace {
  const at = indexOfEntry(ws, splitId)
  const split = ws.entries[at]
  if (!isSplit(split) || !split.views.includes(member)) return ws
  const views = split.views.map((v) => (v === member ? key : v))
  const next: ShellSplit = { ...split, views, focused: key }
  const out: ShellWorkspace = {
    ...ws,
    entries: replaceEntryAt(ws, at, next),
    active: split.id,
  }
  return drop(member) ? out : insertEntry(out, member, at + 1, false)
}

/**
 * `key` (not open anywhere) beside the active entry: with a single tab, the
 * two make a split in the tab's place; on a split with room it joins on
 * `side` of `beside` (of the whole split without it); on a full split it
 * takes the place of `beside` (else the focused member), which gets a tab of
 * its own. Focused either way. With nothing open it is a tab.
 */
function addToActive(
  ws: ShellWorkspace,
  key: string,
  side: "left" | "right",
  beside?: string
): ShellWorkspace {
  const entry = activeEntry(ws)
  if (entry === null) return insertEntry(ws, key, ws.entries.length)
  const at = indexOfEntry(ws, entryId(entry))
  if (!isSplit(entry)) {
    const { id, seq } = nextSplitId(ws)
    const views = side === "left" ? [key, entry] : [entry, key]
    const split: ShellSplit = { id, views, shares: evenShares(2), focused: key }
    return { ...ws, seq, entries: replaceEntryAt(ws, at, split), active: id }
  }
  if (entry.views.length >= MAX_SPLIT) {
    return replaceIn(ws, entry.id, beside ?? entry.focused, key)
  }
  const anchor = beside === undefined ? -1 : entry.views.indexOf(beside)
  const index =
    anchor === -1
      ? side === "left"
        ? 0
        : entry.views.length
      : anchor + (side === "left" ? 0 : 1)
  const views = [...entry.views]
  views.splice(index, 0, key)
  const n = views.length
  // The newcomer takes an even share; the others keep their proportions.
  const shares = entry.shares.map((s) => (s * (n - 1)) / n)
  shares.splice(index, 0, 1 / n)
  const split: ShellSplit = {
    ...entry,
    views,
    shares: normalise(shares),
    focused: key,
  }
  return { ...ws, entries: replaceEntryAt(ws, at, split), active: entry.id }
}

// ------------------------------------------------------------------ opening

/**
 * Open a view, or select it where it is (its tab, or its split with it
 * focused). Not open yet:
 *
 * - while a split is active it opens **in the focused member**, as a link
 *   followed in an Arc split stays in that side; the view it replaces keeps
 *   a tab of its own right after the split, unless `replaces` says it is a
 *   blank to give up (a New tab);
 * - else from a blank (`replaces`, a New tab by default) it takes that
 *   tab's place, as in a browser;
 * - else it is a new tab after the active one.
 */
export function openTab(
  ws: ShellWorkspace,
  key: string,
  replaces: (active: string) => boolean = isNewKey
): ShellWorkspace {
  const holder = entryOf(ws, key)
  if (holder !== null) {
    return isSplit(holder)
      ? focusMember(ws, holder.id, key)
      : selectEntry(ws, key)
  }
  const split = activeSplit(ws)
  if (split !== null) {
    return replaceIn(ws, split.id, split.focused, key, replaces)
  }
  const active = activeEntry(ws)
  if (typeof active === "string" && replaces(active)) {
    const at = indexOfEntry(ws, active)
    return { ...ws, entries: replaceEntryAt(ws, at, key), active: key }
  }
  return insertEntry(ws, key, afterActive(ws))
}

/** A New tab of its own at the strip's end, selected (⌘T, +). */
export function openNewTab(ws: ShellWorkspace): ShellWorkspace {
  const seq = ws.seq + 1
  const key = tabKey({ kind: "new", n: seq })
  return insertEntry({ ...ws, seq }, key, ws.entries.length)
}

/** Select an entry by its id. A member's key selects its split, focused
 *  on it. */
export function selectEntry(ws: ShellWorkspace, id: string): ShellWorkspace {
  if (indexOfEntry(ws, id) === -1) {
    const holder = entryOf(ws, id)
    return isSplit(holder) ? focusMember(ws, holder.id, id) : ws
  }
  return ws.active === id ? ws : { ...ws, active: id }
}

/** Select a split with `key` its focused member, as a click in it does. */
export function focusMember(
  ws: ShellWorkspace,
  splitId: string,
  key: string
): ShellWorkspace {
  const at = indexOfEntry(ws, splitId)
  const split = ws.entries[at]
  if (!isSplit(split) || !split.views.includes(key)) return ws
  if (ws.active === splitId && split.focused === key) return ws
  return {
    ...ws,
    entries: replaceEntryAt(ws, at, { ...split, focused: key }),
    active: splitId,
  }
}

/** The active split's member `step` places from the focused one, wrapping.
 *  Nothing without an active split. */
export function stepMember(ws: ShellWorkspace, step: number): ShellWorkspace {
  const split = activeSplit(ws)
  if (split === null) return ws
  const n = split.views.length
  const at = split.views.indexOf(split.focused)
  return focusMember(ws, split.id, split.views[(((at + step) % n) + n) % n]!)
}

/** The entry `step` places from the active one, wrapping (⌃Tab). */
export function stepTab(ws: ShellWorkspace, step: number): ShellWorkspace {
  const ids = entryIds(ws)
  if (ids.length === 0) return ws
  const at = ws.active === null ? -1 : ids.indexOf(ws.active)
  const from = at < 0 ? (step > 0 ? -1 : 0) : at
  const n = ids.length
  return selectEntry(ws, ids[(((from + step) % n) + n) % n]!)
}

/** The entry at `index`; 8 is the last, as ⌘9 in a browser. */
export function gotoTab(ws: ShellWorkspace, index: number): ShellWorkspace {
  const ids = entryIds(ws)
  const id = index === 8 ? ids[ids.length - 1] : ids[index]
  return id === undefined ? ws : selectEntry(ws, id)
}

// ------------------------------------------------------------------ closing

/**
 * Close a view wherever it is. Its own tab goes, the active one handing over
 * to the entry after it, else before; a split's member goes from its split,
 * and a split left with one view turns back into that view's tab.
 */
export function closeTab(ws: ShellWorkspace, key: string): ShellWorkspace {
  if (entryOf(ws, key) === null) return ws
  return { ...detach(ws, key), closed: [...ws.closed, key] }
}

function closedOf(entry: ShellEntry): ClosedEntry {
  return isSplit(entry)
    ? { views: [...entry.views], shares: [...entry.shares] }
    : entry
}

/** Close a whole entry: a tab, or a split with every member (reopened as
 *  the split it was). */
export function closeEntry(ws: ShellWorkspace, id: string): ShellWorkspace {
  const at = indexOfEntry(ws, id)
  if (at === -1) return closeTab(ws, id)
  const entries = ws.entries.filter((_, i) => i !== at)
  const heir = entries[Math.min(at, entries.length - 1)]
  const active =
    ws.active === id ? (heir === undefined ? null : entryId(heir)) : ws.active
  return {
    ...ws,
    entries,
    active,
    closed: [...ws.closed, closedOf(ws.entries[at]!)],
  }
}

/** ⌘W: the focused member inside a split, else the active tab. */
export function closeFocused(ws: ShellWorkspace): ShellWorkspace {
  const key = focusedTab(ws)
  return key === null ? ws : closeTab(ws, key)
}

function closeWhere(
  ws: ShellWorkspace,
  keep: (index: number) => boolean,
  active: string | null
): ShellWorkspace {
  const gone = ws.entries.filter((_, i) => !keep(i))
  if (gone.length === 0) {
    return active === ws.active ? ws : { ...ws, active }
  }
  const entries = ws.entries.filter((_, i) => keep(i))
  const ids = entries.map(entryId)
  return {
    ...ws,
    entries,
    active: active !== null && ids.includes(active) ? active : null,
    closed: [...ws.closed, ...gone.map(closedOf)],
  }
}

/** Close every entry but `id`, which comes forward. */
export function closeOtherTabs(ws: ShellWorkspace, id: string): ShellWorkspace {
  const at = indexOfEntry(ws, id)
  if (at === -1) return ws
  return closeWhere(ws, (i) => i === at, id)
}

/** Close the entries after `id`; `id` comes forward when the active one
 *  went with them. */
export function closeTabsToRight(
  ws: ShellWorkspace,
  id: string
): ShellWorkspace {
  const at = indexOfEntry(ws, id)
  if (at === -1) return ws
  const kept = ws.active !== null && indexOfEntry(ws, ws.active) <= at
  return closeWhere(ws, (i) => i <= at, kept ? ws.active : id)
}

/** Close every entry. */
export function closeAllTabs(ws: ShellWorkspace): ShellWorkspace {
  return closeWhere(ws, () => false, null)
}

/**
 * The last closed entry, open again after the active one: a tab as a tab, a
 * split as a split of those of its views not open elsewhere by now (a tab
 * when only one is left). Closed New tabs are not worth it.
 */
export function reopenClosed(ws: ShellWorkspace): ShellWorkspace {
  const closed = [...ws.closed]
  for (;;) {
    const entry = closed.pop()
    if (entry === undefined) {
      return ws.closed.length === 0 ? ws : { ...ws, closed }
    }
    const base = { ...ws, closed }
    if (typeof entry === "string") {
      if (isNewKey(entry) || entryOf(ws, entry) !== null) continue
      return insertEntry(base, entry, afterActive(base))
    }
    const keep = entry.views
      .map((v, i) => ({ v, share: entry.shares[i] ?? 0 }))
      .filter(({ v }) => !isNewKey(v) && entryOf(ws, v) === null)
    if (keep.length === 0) continue
    if (keep.length === 1) {
      return insertEntry(base, keep[0]!.v, afterActive(base))
    }
    const { id, seq } = nextSplitId(base)
    const split: ShellSplit = {
      id,
      views: keep.map(({ v }) => v),
      shares: normalise(keep.map(({ share }) => share)),
      focused: keep[0]!.v,
    }
    return insertEntry({ ...base, seq }, split, afterActive(base))
  }
}

// ------------------------------------------------------------------ splits

/**
 * Split view (⌘\): the active tab and a New tab on its right, focused, one
 * split in the tab's place. On a split with room, a New tab joins it at the
 * end. At `MAX_SPLIT`, or with nothing open, nothing happens.
 */
export function splitActive(ws: ShellWorkspace): ShellWorkspace {
  const entry = activeEntry(ws)
  if (entry === null) return ws
  if (isSplit(entry) && entry.views.length >= MAX_SPLIT) return ws
  const seq = ws.seq + 1
  return addToActive({ ...ws, seq }, tabKey({ kind: "new", n: seq }), "right")
}

/**
 * Open in split view (a tab's menu, `openTabAtom`'s `beside`): `key` beside
 * the active entry, taken out of wherever it was (its own tab goes). On the
 * active tab itself it is ⌘\ (that tab and a New tab); a view not open yet
 * joins the same way.
 */
export function openInSplit(ws: ShellWorkspace, key: string): ShellWorkspace {
  const entry = activeEntry(ws)
  if (entry === null) return insertEntry(ws, key, ws.entries.length)
  if (entryViews(entry).includes(key)) {
    return isSplit(entry) ? focusMember(ws, entry.id, key) : splitActive(ws)
  }
  // `key` is not in the active entry, so taking it out leaves that alone.
  return addToActive(detach(ws, key), key, "right")
}

/** Separate a split: every member back to a tab of its own, in place, the
 *  focused one active. */
export function separate(ws: ShellWorkspace, splitId: string): ShellWorkspace {
  const at = indexOfEntry(ws, splitId)
  const split = ws.entries[at]
  if (!isSplit(split)) return ws
  const entries = [
    ...ws.entries.slice(0, at),
    ...split.views,
    ...ws.entries.slice(at + 1),
  ]
  const active = ws.active === splitId ? split.focused : ws.active
  return { ...ws, entries, active }
}

/**
 * Move out of split: a member becomes a tab of its own, right after the
 * split or at strip `index` (its header dragged to the strip), and comes
 * forward. A 2-split it leaves turns back into a tab.
 */
export function moveOut(
  ws: ShellWorkspace,
  key: string,
  index?: number
): ShellWorkspace {
  const holder = entryOf(ws, key)
  if (!isSplit(holder)) return ws
  const at = indexOfEntry(ws, holder.id)
  return insertEntry(detach(ws, key), key, index ?? at + 1)
}

/** Replace with…: the member's place goes to a New tab, focused; the view
 *  it held keeps a tab of its own. */
export function replaceWithNew(
  ws: ShellWorkspace,
  member: string
): ShellWorkspace {
  const holder = entryOf(ws, member)
  if (!isSplit(holder) || isNewKey(member)) return ws
  const seq = ws.seq + 1
  const blank = tabKey({ kind: "new", n: seq })
  return replaceIn({ ...ws, seq }, holder.id, member, blank)
}

/** Move an entry to strip position `index` (0 to the count: before the
 *  entry there now). */
export function moveEntry(
  ws: ShellWorkspace,
  id: string,
  index: number
): ShellWorkspace {
  const from = indexOfEntry(ws, id)
  if (from === -1) return ws
  const to = Math.max(
    0,
    Math.min(from < index ? index - 1 : index, ws.entries.length - 1)
  )
  if (to === from) return ws
  const entries = ws.entries.filter((_, i) => i !== from)
  entries.splice(to, 0, ws.entries[from]!)
  return { ...ws, entries }
}

/**
 * A drop on the strip at `index`: an entry dragged along the strip moves
 * there; a split member's header dragged to the strip leaves its split for a
 * tab of its own there.
 */
export function dropOnStrip(
  ws: ShellWorkspace,
  dragged: string,
  index: number
): ShellWorkspace {
  if (indexOfEntry(ws, dragged) !== -1) return moveEntry(ws, dragged, index)
  return moveOut(ws, dragged, index)
}

/** Where a view dropped on the content goes: beside the view under it, or
 *  in its place. */
export type DropZone = "left" | "right" | "center"

/**
 * A view dragged onto the content (docs/features/tabs-panes.md, Making a
 * split), over `target`, the active tab or one member of the active split:
 *
 * - on an edge it splits with it there, taken out of where it was; at
 *   `MAX_SPLIT` the edge replaces instead;
 * - in a member's middle it replaces that member, which gets a tab of its
 *   own (within one split, the two swap); a single tab's middle takes
 *   nothing;
 * - the tab in front dropped on its own edge splits there with its
 *   neighbour in the strip (the tab before it, else after it), or with a
 *   New tab when it is the only one: the gesture of dragging a tab beside
 *   what is open.
 *
 * A drop that would change nothing (a view onto itself, a split's id) is
 * the same workspace, which is how a drop target tells whether to take it.
 */
export function dropTab(
  ws: ShellWorkspace,
  key: string,
  target: string,
  zone: DropZone
): ShellWorkspace {
  const entry = activeEntry(ws)
  if (entry === null) return ws
  if (key === target) {
    return !isSplit(entry) && zone !== "center" ? splitOwn(ws, key, zone) : ws
  }
  if (!entryViews(entry).includes(target) || entryOf(ws, key) === null) {
    return ws
  }
  if (!isSplit(entry)) {
    if (zone === "center") return ws
    return addToActive(detach(ws, key), key, zone)
  }
  if (entry.views.includes(key)) {
    const views = [...entry.views]
    if (zone === "center") {
      views[views.indexOf(key)] = target
      views[entry.views.indexOf(target)] = key
    } else {
      views.splice(views.indexOf(key), 1)
      views.splice(views.indexOf(target) + (zone === "right" ? 1 : 0), 0, key)
    }
    if (views.every((v, i) => v === entry.views[i])) return ws
    const at = indexOfEntry(ws, entry.id)
    const split: ShellSplit = { ...entry, views, focused: key }
    return { ...ws, entries: replaceEntryAt(ws, at, split), active: entry.id }
  }
  const out = detach(ws, key)
  if (zone === "center" || entry.views.length >= MAX_SPLIT) {
    return replaceIn(out, entry.id, target, key)
  }
  return addToActive(out, key, zone, target)
}

/** The active tab `key` dropped on its own `side`: beside its neighbour in
 *  the strip, else beside a New tab. */
function splitOwn(
  ws: ShellWorkspace,
  key: string,
  side: "left" | "right"
): ShellWorkspace {
  const at = indexOfEntry(ws, key)
  const near = [ws.entries[at - 1], ws.entries[at + 1]].find(
    (e) => e !== undefined && !isSplit(e)
  )
  if (near !== undefined) {
    return addToActive(detach({ ...ws, active: entryId(near) }, key), key, side)
  }
  const seq = ws.seq + 1
  const fresh = tabKey({ kind: "new", n: seq })
  const views = side === "left" ? [key, fresh] : [fresh, key]
  const next = nextSplitId({ ...ws, seq })
  const split: ShellSplit = {
    id: next.id,
    views,
    shares: evenShares(2),
    focused: key,
  }
  return {
    ...ws,
    seq: next.seq,
    entries: replaceEntryAt(ws, at, split),
    active: next.id,
  }
}

/** A split's shares, in member order, normalised to sum to 1. */
export function setShares(
  ws: ShellWorkspace,
  splitId: string,
  shares: number[]
): ShellWorkspace {
  const at = indexOfEntry(ws, splitId)
  const split = ws.entries[at]
  if (!isSplit(split) || shares.length !== split.views.length) return ws
  const sum = shares.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return ws
  const next = shares.map((s) => s / sum)
  if (next.every((s, i) => Math.abs(s - split.shares[i]!) < 1e-4)) return ws
  return { ...ws, entries: replaceEntryAt(ws, at, { ...split, shares: next }) }
}

// ------------------------------------------------------------------ files

/** A moved document's tab follows it to its new path: as a tab, inside a
 *  split, in front, and in Reopen. */
export function retargetTabs(
  ws: ShellWorkspace,
  moves: readonly { from: string; to: string }[]
): ShellWorkspace {
  const to = new Map(
    moves.map((m) => [tabKey(tabForPath(m.from)), tabKey(tabForPath(m.to))])
  )
  const move = (key: string) => to.get(key) ?? key
  const inClosed = ws.closed.some((c) =>
    typeof c === "string" ? to.has(c) : c.views.some((v) => to.has(v))
  )
  if (!allTabs(ws).some((k) => to.has(k)) && !inClosed) return ws
  return {
    ...ws,
    entries: ws.entries.map((e) =>
      isSplit(e)
        ? { ...e, views: e.views.map(move), focused: move(e.focused) }
        : move(e)
    ),
    active: ws.active === null ? null : move(ws.active),
    closed: ws.closed.map((c) =>
      typeof c === "string" ? move(c) : { ...c, views: c.views.map(move) }
    ),
  }
}

/** Close the views `gone` says are gone (a deleted file, a removed
 *  session), wherever they are, without offering them to Reopen. */
export function closeTabsWhere(
  ws: ShellWorkspace,
  gone: (key: string) => boolean
): ShellWorkspace {
  return allTabs(ws).filter(gone).reduce(detach, ws)
}
