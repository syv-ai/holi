import { describe, expect, test } from "vitest"

import {
  allTabs,
  closeOtherTabs,
  closePane,
  closeTab,
  dropTab,
  emptyWorkspace,
  focusedPane,
  MAX_PANES,
  moveTab,
  openBeside,
  openNewTab,
  openInSplit,
  openTab,
  reopenClosed,
  retargetTabs,
  splitRight,
  stepTab,
  type ShellWorkspace,
} from "../shell-workspace"
import { AGENTS_HOME_KEY, sessionKey } from "../tab-descriptor"

const A = "Notes/A.md"
const B = "Notes/B.md"
const C = "Notes/C.md"
const S = sessionKey({ owner: "chat", id: "s1" })

function withTabs(...keys: string[]): ShellWorkspace {
  return keys.reduce((ws, key) => openTab(ws, key), emptyWorkspace())
}

function shares(ws: ShellWorkspace): number[] {
  return ws.panes.map((p) => Math.round(p.share * 100) / 100)
}

describe("opening", () => {
  test("a tab opens after the active one and comes forward", () => {
    const ws = withTabs(A, B)
    expect(focusedPane(ws).tabs).toEqual([A, B])
    expect(focusedPane(ws).active).toBe(B)
  })

  test("an open tab is focused where it is, in any pane, not opened twice", () => {
    let ws = withTabs(A, S)
    ws = splitRight(ws, ws.focused, A)
    const right = ws.focused
    ws = openTab(ws, S)
    expect(allTabs(ws).filter((t) => t === S)).toHaveLength(1)
    expect(ws.focused).not.toBe(right)
    expect(focusedPane(ws).active).toBe(S)
    expect(openTab(ws, S)).toBe(ws)
  })

  test("a New tab gives its place to what is opened from it", () => {
    let ws = openNewTab(withTabs(A))
    const blank = focusedPane(ws).active!
    ws = openTab(ws, B)
    expect(focusedPane(ws).tabs).toEqual([A, B])
    expect(allTabs(ws)).not.toContain(blank)
  })

  test("a session takes the Agents home's place when asked to", () => {
    let ws = withTabs(A, AGENTS_HOME_KEY)
    ws = openTab(ws, S, (key) => key === AGENTS_HOME_KEY)
    expect(focusedPane(ws).tabs).toEqual([A, S])
  })

  test("stepping wraps within the focused pane", () => {
    const ws = withTabs(A, B)
    expect(focusedPane(stepTab(ws, 1)).active).toBe(A)
    expect(focusedPane(stepTab(ws, -1)).active).toBe(A)
  })
})

describe("closing", () => {
  test("closing the active tab hands focus to its neighbour", () => {
    let ws = withTabs(A, B, C)
    ws = openTab(ws, B)
    ws = closeTab(ws, B)
    expect(focusedPane(ws).active).toBe(C)
  })

  test("closing a split pane's last tab closes the pane, and its share goes", () => {
    let ws = withTabs(A, B)
    ws = splitRight(ws, ws.focused, B)
    expect(ws.panes).toHaveLength(2)
    ws = closeTab(ws, B)
    expect(ws.panes).toHaveLength(1)
    expect(shares(ws)).toEqual([1])
    expect(focusedPane(ws).active).toBe(A)
  })

  test("the last pane stays, empty", () => {
    const ws = closeTab(withTabs(A), A)
    expect(ws.panes).toHaveLength(1)
    expect(focusedPane(ws).active).toBeNull()
  })

  test("close others keeps the pointed-at tab, in front", () => {
    let ws = withTabs(A, B, C)
    ws = closeOtherTabs(ws, A)
    expect(focusedPane(ws).tabs).toEqual([A])
    expect(focusedPane(ws).active).toBe(A)
  })

  test("a closed tab reopens; a closed pane's tabs too", () => {
    let ws = withTabs(A, B)
    ws = closeTab(ws, B)
    ws = reopenClosed(ws)
    expect(focusedPane(ws).active).toBe(B)
    ws = splitRight(ws, ws.focused, B)
    ws = closePane(ws, ws.focused)
    expect(ws.panes).toHaveLength(1)
    ws = reopenClosed(ws)
    expect(allTabs(ws)).toContain(B)
  })
})

describe("panes", () => {
  test("split right opens a focused pane after, with half the share", () => {
    const ws = splitRight(withTabs(A))
    expect(ws.panes).toHaveLength(2)
    expect(ws.focused).toBe(ws.panes[1]!.id)
    expect(focusedPane(ws).tabs).toHaveLength(1)
    expect(shares(ws)).toEqual([0.5, 0.5])
    // A split never copies a tab: the new pane gets a New tab.
    expect(allTabs(ws).filter((t) => t === A)).toHaveLength(1)
  })

  test("split right on a tab moves it, unless it is the pane's only one", () => {
    let ws = withTabs(A, B)
    ws = splitRight(ws, ws.focused, A)
    expect(ws.panes.map((p) => p.tabs)).toEqual([[B], [A]])
    const sole = splitRight(withTabs(A), undefined, A)
    expect(sole.panes[0]!.tabs).toEqual([A])
  })

  test("there are at most MAX_PANES panes", () => {
    let ws = withTabs(A)
    for (let i = 0; i < MAX_PANES + 2; i++) ws = splitRight(ws)
    expect(ws.panes).toHaveLength(MAX_PANES)
  })

  test("moving a tab to the other pane focuses it there", () => {
    let ws = withTabs(A, B, C)
    ws = splitRight(ws, ws.focused, C)
    const [left, right] = ws.panes
    ws = moveTab(ws, A, right!.id)
    expect(ws.panes[0]!.tabs).toEqual([B])
    expect(ws.panes[1]!.tabs).toContain(A)
    expect(ws.focused).toBe(right!.id)
    expect(focusedPane(ws).active).toBe(A)
    // Moving the last tab out of a pane closes it.
    ws = moveTab(ws, B, right!.id)
    expect(ws.panes).toHaveLength(1)
    expect(ws.panes[0]!.id).toBe(right!.id)
    expect(left).toBeDefined()
  })

  test("open beside fills the pane to the right, splitting while there is room", () => {
    let ws = withTabs(A)
    ws = openBeside(ws, S)
    expect(ws.panes.map((p) => p.tabs)).toEqual([[A], [S]])
    ws = openTab(ws, B)
    ws = openBeside(focusPaneFirst(ws), C)
    expect(ws.panes[1]!.tabs).toContain(C)
  })
})

describe("split view", () => {
  test("a tab dropped on a pane's edge opens a pane of its own on that side", () => {
    let ws = withTabs(A, B)
    const only = ws.panes[0]!.id
    ws = dropTab(ws, A, only, "right")
    expect(ws.panes.map((p) => p.tabs)).toEqual([[B], [A]])
    expect(ws.focused).toBe(ws.panes[1]!.id)
    expect(shares(ws)).toEqual([0.5, 0.5])
    // On the left edge of the right pane: a third pane between them.
    ws = openTab(ws, C)
    ws = dropTab(ws, C, ws.panes[1]!.id, "left")
    expect(ws.panes.map((p) => p.tabs)).toEqual([[B], [C], [A]])
    expect(shares(ws)).toEqual([0.5, 0.25, 0.25])
  })

  test("a tab dropped in a pane's middle moves into it", () => {
    let ws = splitRight(withTabs(A, B), undefined, B)
    const [left, right] = ws.panes
    ws = dropTab(ws, A, right!.id, "center")
    // The left pane, emptied, goes; its share with it.
    expect(ws.panes.map((p) => p.tabs)).toEqual([[B, A]])
    expect(ws.panes[0]!.id).toBe(right!.id)
    expect(left).toBeDefined()
  })

  test("at MAX_PANES an edge drop moves into the pane instead", () => {
    let ws = withTabs(A, B, C)
    ws = splitRight(ws, ws.focused, C)
    ws = splitRight(ws, ws.focused, undefined)
    expect(ws.panes).toHaveLength(MAX_PANES)
    ws = dropTab(ws, A, ws.panes[2]!.id, "right")
    expect(ws.panes).toHaveLength(MAX_PANES)
    expect(ws.panes[2]!.tabs).toContain(A)
  })

  test("a drop that changes nothing is the same workspace", () => {
    const ws = withTabs(A, B)
    const only = ws.panes[0]!.id
    expect(dropTab(ws, A, only, "center")).toBe(ws)
    const sole = withTabs(A)
    expect(dropTab(sole, A, sole.panes[0]!.id, "right")).toBe(sole)
    expect(dropTab(ws, "Notes/Nope.md", only, "right")).toBe(ws)
  })

  test("open in split view moves a tab right, splitting while there is room", () => {
    let ws = withTabs(A, B)
    ws = openInSplit(ws, A)
    expect(ws.panes.map((p) => p.tabs)).toEqual([[B], [A]])
    // Already split: into the pane on the right.
    ws = openTab(focusPaneFirst(ws), C)
    ws = openInSplit(ws, C)
    expect(ws.panes.map((p) => p.tabs)).toEqual([[B], [A, C]])
    expect(focusedPane(ws).active).toBe(C)
  })

  test("open in split view on a pane's only tab leaves a New tab behind", () => {
    const ws = openInSplit(withTabs(A), A)
    expect(ws.panes).toHaveLength(2)
    expect(ws.panes[1]!.tabs).toEqual([A])
    expect(ws.panes[0]!.tabs).toHaveLength(1)
    expect(ws.panes[0]!.tabs[0]).toMatch(/^holi:new:/)
    expect(ws.focused).toBe(ws.panes[1]!.id)
  })

  test("open in split view from the last of MAX_PANES goes left", () => {
    let ws = withTabs(A, B, C)
    ws = splitRight(ws, ws.focused, C)
    ws = splitRight(ws, ws.focused)
    const last = ws.panes[2]!
    ws = openTab(ws, S)
    expect(ws.panes[2]!.tabs).toContain(S)
    ws = openInSplit(ws, S)
    expect(ws.panes[1]!.tabs).toContain(S)
    expect(last).toBeDefined()
  })
})

describe("files", () => {
  test("a moved file's tab follows it, in every pane", () => {
    let ws = withTabs(A, B)
    ws = splitRight(ws, ws.focused, B)
    ws = retargetTabs(ws, [{ from: B, to: "Archive/B.md" }])
    expect(ws.panes[1]!.tabs).toEqual(["Archive/B.md"])
    expect(ws.panes[1]!.active).toBe("Archive/B.md")
    expect(retargetTabs(ws, [{ from: "x.md", to: "y.md" }])).toBe(ws)
  })
})

function focusPaneFirst(ws: ShellWorkspace): ShellWorkspace {
  return { ...ws, focused: ws.panes[0]!.id }
}
