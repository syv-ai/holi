import { describe, expect, test } from "vitest"

import {
  activeSplit,
  allTabs,
  closeAllTabs,
  closeEntry,
  closeFocused,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  closeTabsWhere,
  dropOnStrip,
  dropTab,
  emptyWorkspace,
  entryIds,
  focusedTab,
  focusMember,
  gotoTab,
  isSplit,
  MAX_SPLIT,
  moveEntry,
  moveOut,
  openInSplit,
  openNewTab,
  openTab,
  reopenClosed,
  replaceWithNew,
  retargetTabs,
  selectEntry,
  separate,
  setShares,
  splitActive,
  stepMember,
  stepTab,
  type ShellSplit,
  type ShellWorkspace,
} from "../shell-workspace"
import { AGENTS_HOME_KEY, parseTabKey, sessionKey } from "../tab-descriptor"

const A = "Notes/A.md"
const B = "Notes/B.md"
const C = "Notes/C.md"
const D = "Notes/D.md"
const S = sessionKey({ owner: "chat", id: "s1" })

function withTabs(...keys: string[]): ShellWorkspace {
  return keys.reduce((ws, key) => openTab(ws, key), emptyWorkspace())
}

function split(ws: ShellWorkspace): ShellSplit {
  const s = activeSplit(ws)
  expect(s).not.toBeNull()
  return s!
}

const isNew = (key: string) => parseTabKey(key)?.kind === "new"

/** The strip as views: a tab's key, a split's keys. */
function strip(ws: ShellWorkspace): (string | string[])[] {
  return ws.entries.map((e) => (isSplit(e) ? e.views : e))
}

/** A, B and C as tabs, A and B then made one split. */
function pair(): ShellWorkspace {
  return openInSplit(selectEntry(withTabs(A, B, C), A), B)
}

describe("the strip", () => {
  test("a tab opens after the active one and comes forward", () => {
    let ws = withTabs(A, B)
    ws = selectEntry(ws, A)
    ws = openTab(ws, C)
    expect(strip(ws)).toEqual([A, C, B])
    expect(focusedTab(ws)).toBe(C)
  })

  test("an open tab is selected where it is, not opened twice", () => {
    const ws = withTabs(A, B)
    const next = openTab(ws, A)
    expect(next.active).toBe(A)
    expect(allTabs(next)).toEqual([A, B])
    expect(openTab(next, A)).toBe(next)
  })

  test("a New tab gives its place to what is opened from it", () => {
    let ws = openNewTab(withTabs(A))
    ws = openTab(ws, B)
    expect(strip(ws)).toEqual([A, B])
  })

  test("a session takes the Agents home's place when asked to", () => {
    let ws = withTabs(A, AGENTS_HOME_KEY)
    ws = openTab(ws, S, (key) => key === AGENTS_HOME_KEY)
    expect(strip(ws)).toEqual([A, S])
  })

  test("⌘T's New tab goes at the strip's end", () => {
    let ws = selectEntry(withTabs(A, B), A)
    ws = openNewTab(ws)
    expect(ws.entries).toHaveLength(3)
    expect(isNew(entryIds(ws)[2]!)).toBe(true)
    expect(ws.active).toBe(entryIds(ws)[2])
  })

  test("stepping and ⌘1–9 go over entries, a split being one", () => {
    let ws = splitActive(withTabs(A, B))
    ws = openNewTab(ws)
    const ids = entryIds(ws)
    expect(ids).toHaveLength(3)
    expect(isSplit(ws.entries[1])).toBe(true)
    expect(stepTab(ws, 1).active).toBe(ids[0])
    expect(gotoTab(ws, 1).active).toBe(ids[1])
    expect(gotoTab(ws, 8).active).toBe(ids[2])
  })

  test("an entry drags to another place in the strip", () => {
    const ws = withTabs(A, B, C)
    expect(strip(moveEntry(ws, C, 0))).toEqual([C, A, B])
    expect(strip(moveEntry(ws, A, 3))).toEqual([B, C, A])
    expect(moveEntry(ws, A, 1)).toBe(ws)
  })
})

describe("making a split", () => {
  test("⌘\\ on a tab makes a split of it and a New tab, focused on the right", () => {
    const ws = splitActive(withTabs(A, B))
    expect(ws.entries).toHaveLength(2)
    const s = split(ws)
    expect(s.views[0]).toBe(B)
    expect(isNew(s.views[1]!)).toBe(true)
    expect(s.focused).toBe(s.views[1])
    expect(s.shares).toEqual([0.5, 0.5])
  })

  test("open in split view pairs the active tab with that tab, whose own entry goes", () => {
    let ws = selectEntry(withTabs(A, B, C), A)
    ws = openInSplit(ws, C)
    expect(strip(ws)).toEqual([[A, C], B])
    expect(focusedTab(ws)).toBe(C)
  })

  test("open in split view on a split with room adds a member", () => {
    const ws = openInSplit(pair(), C)
    expect(strip(ws)).toEqual([[A, B, C]])
  })

  test("a split holds at most MAX_SPLIT views; ⌘\\ then does nothing", () => {
    const ws = openInSplit(pair(), C)
    expect(split(ws).views).toHaveLength(MAX_SPLIT)
    expect(splitActive(ws)).toBe(ws)
  })

  test("a tab dropped on the content's edge splits with it there", () => {
    const ws = withTabs(A, B)
    expect(strip(dropTab(ws, A, B, "right"))).toEqual([[B, A]])
    expect(strip(dropTab(ws, A, B, "left"))).toEqual([[A, B]])
    expect(dropTab(ws, A, B, "center")).toBe(ws)
    expect(dropTab(ws, B, B, "center")).toBe(ws)
  })

  test("the tab in front dropped on its own edge splits with its neighbour", () => {
    const ws = selectEntry(withTabs(A, B, C), B)
    expect(strip(dropTab(ws, B, B, "right"))).toEqual([[A, B], C])
    expect(strip(dropTab(ws, B, B, "left"))).toEqual([[B, A], C])
    expect(focusedTab(dropTab(ws, B, B, "right"))).toBe(B)
    const alone = dropTab(withTabs(A), A, A, "right")
    expect(isSplit(alone.entries[0]!)).toBe(true)
    expect(focusedTab(alone)).toBe(A)
  })

  test("a tab dropped on a member replaces it, the replaced one keeping a tab", () => {
    const ws = dropTab(pair(), C, A, "center")
    expect(strip(ws)).toEqual([[C, B], A])
    expect(focusedTab(ws)).toBe(C)
  })

  test("at three members an edge drop replaces instead of splitting", () => {
    let ws = selectEntry(withTabs(A, B, C, D), A)
    ws = openInSplit(openInSplit(ws, B), C)
    ws = dropTab(ws, D, B, "right")
    expect(strip(ws)).toEqual([[A, D, C], B])
  })

  test("within a split a drop reorders or swaps", () => {
    const ws = pair()
    expect(strip(dropTab(ws, B, A, "left"))).toEqual([[B, A], C])
    expect(strip(dropTab(ws, A, B, "center"))).toEqual([[B, A], C])
    expect(dropTab(ws, A, B, "left")).toBe(ws)
  })
})

describe("inside a split", () => {
  test("closing a member of a 2-split turns it back into a tab", () => {
    const ws = closeTab(pair(), B)
    expect(strip(ws)).toEqual([A, C])
    expect(ws.active).toBe(A)
    expect(ws.closed).toEqual([B])
  })

  test("⌘W closes the focused member inside a split, else the tab", () => {
    let ws = closeFocused(pair())
    expect(strip(ws)).toEqual([A, C])
    ws = closeFocused(ws)
    expect(strip(ws)).toEqual([C])
  })

  test("separate puts every member back as a tab, the focused one in front", () => {
    const ws = pair()
    const out = separate(ws, split(ws).id)
    expect(strip(out)).toEqual([A, B, C])
    expect(out.active).toBe(B)
  })

  test("move out of split makes a member its own tab, after the split", () => {
    let ws = openInSplit(pair(), C)
    ws = moveOut(ws, A)
    expect(strip(ws)).toEqual([[B, C], A])
    expect(ws.active).toBe(A)
  })

  test("a member's header dropped on the strip leaves the split there", () => {
    const ws = dropOnStrip(pair(), A, 0)
    expect(strip(ws)).toEqual([A, B, C])
  })

  test("replace with… puts a New tab in the member, keeping the old view", () => {
    const ws = replaceWithNew(pair(), A)
    const s = split(ws)
    expect(isNew(s.views[0]!)).toBe(true)
    expect(s.focused).toBe(s.views[0])
    expect(strip(ws).slice(1)).toEqual([A, C])
  })

  test("opening in a split lands in the focused member; the old view keeps a tab", () => {
    const ws = openTab(pair(), D)
    expect(strip(ws)).toEqual([[A, D], B, C])
    expect(focusedTab(ws)).toBe(D)
  })

  test("a New tab member is simply given up to what opens in it", () => {
    const ws = openTab(splitActive(withTabs(A)), B)
    expect(strip(ws)).toEqual([[A, B]])
  })

  test("opening an already-open member selects its split and focuses it", () => {
    let ws = selectEntry(pair(), C)
    ws = openTab(ws, A)
    expect(ws.active).toBe(split(ws).id)
    expect(focusedTab(ws)).toBe(A)
  })

  test("stepping members wraps; focusing one selects the split", () => {
    let ws = pair()
    expect(focusedTab(stepMember(ws, 1))).toBe(A)
    const id = split(ws).id
    ws = selectEntry(ws, C)
    ws = focusMember(ws, id, A)
    expect(ws.active).toBe(id)
    expect(focusedTab(ws)).toBe(A)
  })

  test("shares belong to the split and sum to one", () => {
    let ws = pair()
    ws = setShares(ws, split(ws).id, [3, 1])
    expect(split(ws).shares).toEqual([0.75, 0.25])
  })
})

describe("closing and reopening", () => {
  test("closing the active tab hands over to the next, else the previous", () => {
    let ws = selectEntry(withTabs(A, B, C), B)
    ws = closeTab(ws, B)
    expect(ws.active).toBe(C)
    ws = closeTab(ws, C)
    expect(ws.active).toBe(A)
  })

  test("close others and close to the right", () => {
    const ws = selectEntry(withTabs(A, B, C), C)
    expect(strip(closeOtherTabs(ws, B))).toEqual([B])
    const right = closeTabsToRight(ws, A)
    expect(strip(right)).toEqual([A])
    expect(right.active).toBe(A)
    expect(closeAllTabs(ws).entries).toEqual([])
  })

  test("a closed split reopens as the split it was", () => {
    let ws = pair()
    ws = setShares(ws, split(ws).id, [2, 1])
    ws = closeEntry(ws, split(ws).id)
    expect(strip(ws)).toEqual([C])
    ws = reopenClosed(ws)
    expect(strip(ws)).toEqual([C, [A, B]])
    expect(split(ws).shares.map((s) => Math.round(s * 100))).toEqual([67, 33])
  })

  test("reopen skips New tabs", () => {
    let ws = openNewTab(withTabs(A))
    ws = closeTab(ws, entryIds(ws)[1]!)
    ws = closeTab(ws, A)
    const back = reopenClosed(ws)
    expect(strip(back)).toEqual([A])
    expect(back.closed).toHaveLength(1)
  })
})

describe("files", () => {
  test("a moved file's tab follows it, inside a split and in Reopen", () => {
    let ws = closeTab(pair(), C)
    ws = retargetTabs(ws, [
      { from: A, to: "Notes/A2.md" },
      { from: C, to: "Notes/C2.md" },
    ])
    expect(strip(ws)).toEqual([["Notes/A2.md", B]])
    expect(ws.closed).toEqual(["Notes/C2.md"])
    ws = focusMember(ws, split(ws).id, "Notes/A2.md")
    ws = retargetTabs(ws, [{ from: "Notes/A2.md", to: "Notes/A3.md" }])
    expect(focusedTab(ws)).toBe("Notes/A3.md")
  })

  test("a single active tab's move keeps it active", () => {
    const ws = retargetTabs(withTabs(A), [{ from: A, to: B }])
    expect(ws.active).toBe(B)
  })

  test("gone views close wherever they are, not offered to Reopen", () => {
    const ws = closeTabsWhere(pair(), (k) => k === B || k === C)
    expect(strip(ws)).toEqual([A])
    expect(ws.closed).toEqual([])
  })

  test("a no-op returns the same workspace", () => {
    const ws = withTabs(A)
    expect(retargetTabs(ws, [{ from: C, to: D }])).toBe(ws)
    expect(closeTabsWhere(ws, () => false)).toBe(ws)
  })
})
