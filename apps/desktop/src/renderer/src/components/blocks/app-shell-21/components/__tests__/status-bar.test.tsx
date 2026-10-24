/**
 * The status bar, the bottom panel and its Output
 * (docs/features/status-bar.md): what the bar's items say and do, the keys
 * that toggle the panel, and the Output's filter and follow.
 */
import { Provider, createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { act, fireEvent, render, screen, waitFor } from "@/test/render"
import {
  activityEntriesAtom,
  activityLoadAtom,
  activityFilterAtom,
  activitySeenAtom,
  activityUnseenErrorAtom,
  filterEntries,
  mergeEntries,
  type ActivityEntry,
} from "@/state/activity"
import {
  bottomPanelAtom,
  clampPanelHeight,
  togglePanel,
} from "@/state/bottom-panel"
import { afterRemoval } from "@/state/panel-terminals"
import { installedPluginsAtom, runningPluginsAtom } from "@/state/plugins"
import { useShortcutDispatcher } from "@/state/shortcuts"
import { activeRemoteAtom, syncStateAtom } from "@/state/vaults"

import { BottomPanel } from "../bottom-panel"
import { PanelOutput } from "../panel-output"
import { StatusBar, syncedAgo, syncItemView } from "../status-bar"

const calls: { name: string; input: unknown }[] = []
let syncInfo: unknown = null

vi.mock("@/lib/trpc", () => {
  const answer = (name: string): unknown => {
    if (name === "sync.info") return syncInfo
    if (name === "terminal.list") return []
    if (name === "terminal.create")
      return { ok: false, message: "node-pty did not load" }
    if (name === "activity.entries") return []
    return { ok: true }
  }
  const procedure = (name: string) => ({
    query: async (input?: unknown) => {
      calls.push({ name, input })
      return answer(name)
    },
    mutate: async (input?: unknown) => {
      calls.push({ name, input })
      return answer(name)
    },
  })
  const router = (r: string) =>
    new Proxy(
      {},
      {
        get: (_t, key) =>
          typeof key === "string" ? procedure(`${r}.${key}`) : undefined,
      }
    )
  return {
    trpc: new Proxy(
      {},
      { get: (_t, key) => (typeof key === "string" ? router(key) : undefined) }
    ),
  }
})

// xterm needs a canvas jsdom does not have; the panel's terminal stands in.
vi.mock("../panel-terminal", () => ({
  PanelTerminal: ({ id }: { id: string }) => <div data-testid={`term-${id}`} />,
}))

const entry = (
  id: number,
  over: Partial<ActivityEntry> = {}
): ActivityEntry => ({
  id,
  at: "2026-10-24T10:00:00.000Z",
  channel: "git",
  level: "info",
  message: `line ${id}`,
  ...over,
})

beforeEach(() => {
  calls.length = 0
  syncInfo = null
  document.documentElement.dataset.platform = "mac"
})
afterEach(() => {
  delete document.documentElement.dataset.platform
})

function Dispatcher() {
  useShortcutDispatcher()
  return null
}

function shell(store = createStore()) {
  render(
    <Provider store={store}>
      <Dispatcher />
      <div style={{ height: 800 }}>
        <BottomPanel onRetryOutput={() => {}} />
      </div>
      <StatusBar />
    </Provider>
  )
  return store
}

describe("pure rules", () => {
  test("togglePanel opens on a tab, switches tabs, and closes the one showing", () => {
    const closed = { open: false, tab: "output" as const, maximized: false }
    const onTerminal = togglePanel(closed, "terminal")
    expect(onTerminal).toEqual({
      open: true,
      tab: "terminal",
      maximized: false,
    })
    expect(togglePanel(onTerminal, "output")).toMatchObject({
      open: true,
      tab: "output",
    })
    expect(togglePanel({ ...onTerminal, maximized: true }, "terminal")).toEqual(
      { open: false, tab: "terminal", maximized: false }
    )
  })

  test("the panel is held between 120px and 70% of the column", () => {
    expect(clampPanelHeight(50, 1000)).toBe(120)
    expect(clampPanelHeight(900, 1000)).toBe(700)
    expect(clampPanelHeight(300, 1000)).toBe(300)
    expect(clampPanelHeight(300, 100)).toBe(120)
  })

  test("entries merge by id, oldest first, capped", () => {
    const merged = mergeEntries(
      [entry(2), entry(3)],
      [entry(1), entry(3), entry(4)],
      3
    )
    expect(merged.map((e) => e.id)).toEqual([2, 3, 4])
    expect(
      filterEntries([entry(1), entry(2, { channel: "sync" })], "sync").map(
        (e) => e.id
      )
    ).toEqual([2])
  })

  test("synced-ago reads as a person says it", () => {
    const at = Date.parse("2026-10-24T10:00:00.000Z")
    expect(syncedAgo("2026-10-24T10:00:00.000Z", at + 20_000)).toBe(
      "Synced just now"
    )
    expect(syncedAgo("2026-10-24T10:00:00.000Z", at + 120_000)).toBe(
      "Synced 2m ago"
    )
    expect(syncedAgo("2026-10-24T10:00:00.000Z", at + 3 * 3_600_000)).toBe(
      "Synced 3h ago"
    )
  })

  test("the sync item syncs when it can and opens the log when it should be read", () => {
    expect(syncItemView({ kind: "up-to-date" })).toMatchObject({
      click: "sync",
      problem: null,
    })
    expect(syncItemView({ kind: "pulling" })).toMatchObject({ busy: true })
    expect(syncItemView({ kind: "offline", count: 2 })).toMatchObject({
      click: "sync",
      problem: "offline",
    })
    expect(syncItemView({ kind: "conflict", paths: ["a.md"] })).toMatchObject({
      click: "output",
      problem: "warn",
    })
    expect(
      syncItemView({ kind: "paused", reason: "an agent turn", manual: true })
    ).toMatchObject({ problem: null })
  })

  test("removing the terminal in front brings its neighbour", () => {
    const list = ["a", "b", "c"].map((id) => ({
      id,
      title: id,
      exitCode: null,
    }))
    expect(afterRemoval(list, "b", "b").active).toBe("c")
    expect(afterRemoval(list, "c", "c").active).toBe("b")
    expect(afterRemoval(list, "a", "c").active).toBe("a")
    expect(afterRemoval([list[0]!], "a", "a").active).toBeNull()
  })

  test("an error after the last one seen lights the Output item", () => {
    const store = createStore()
    store.set(activityEntriesAtom, [entry(1), entry(2, { level: "error" })])
    expect(store.get(activityUnseenErrorAtom)).toBe(true)
    store.set(activitySeenAtom, 2)
    expect(store.get(activityUnseenErrorAtom)).toBe(false)
  })
})

describe("status bar", () => {
  test("shows the branch with a star when dirty, the counts, and when it last synced", async () => {
    syncInfo = {
      remote: "o/r",
      branch: "main",
      dirty: true,
      ahead: 0,
      behind: 2,
      lastSyncAt: new Date(Date.now() - 120_000).toISOString(),
      lastError: null,
    }
    const store = createStore()
    store.set(activeRemoteAtom, "o/r")
    shell(store)
    expect(await screen.findByText("main*")).toBeInTheDocument()
    expect(screen.getByText("2↓ 0↑")).toBeInTheDocument()
    expect(screen.getByText("Synced 2m ago")).toBeInTheDocument()
  })

  test("draws no branch or sync with no vault open", () => {
    shell()
    expect(screen.queryByText(/↓/)).toBeNull()
    expect(
      screen.getByRole("button", { name: /terminal/i })
    ).toBeInTheDocument()
  })

  test("clicking the sync item syncs now when it is up to date", async () => {
    syncInfo = {
      remote: "o/r",
      branch: "main",
      dirty: false,
      ahead: 1,
      behind: 0,
      lastSyncAt: null,
      lastError: null,
    }
    const store = createStore()
    store.set(activeRemoteAtom, "o/r")
    shell(store)
    fireEvent.click(
      await screen.findByRole("button", { name: /^Sync: up to date/ })
    )
    await waitFor(() =>
      expect(calls.some((c) => c.name === "sync.now")).toBe(true)
    )
  })

  test("clicking it on a conflict opens the Output instead", async () => {
    syncInfo = {
      remote: "o/r",
      branch: "main",
      dirty: false,
      ahead: 0,
      behind: 0,
      lastSyncAt: null,
      lastError: null,
    }
    const store = createStore()
    store.set(activeRemoteAtom, "o/r")
    store.set(syncStateAtom, { kind: "conflict", paths: ["a.md"] })
    store.set(activityLoadAtom, "ready")
    shell(store)
    fireEvent.click(
      await screen.findByRole("button", { name: /^Sync: 1 file conflict/ })
    )
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: "output",
    })
    expect(calls.some((c) => c.name === "sync.now")).toBe(false)
  })

  test("Terminal and Output toggle the panel on their tab", () => {
    const store = shell()
    const terminal = screen.getByRole("button", { name: /terminal/i })
    fireEvent.click(terminal)
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: "terminal",
    })
    expect(terminal).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: /^output$/i }))
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: "output",
    })
    fireEvent.click(screen.getByRole("button", { name: /^output$/i }))
    expect(store.get(bottomPanelAtom).open).toBe(false)
  })

  test("a new error marks Output until it is seen", async () => {
    const store = createStore()
    store.set(activityLoadAtom, "ready")
    store.set(activityEntriesAtom, [
      entry(1, { level: "error", message: "Push failed" }),
    ])
    shell(store)
    const output = screen.getByRole("button", {
      name: "Output, with a new error",
    })
    fireEvent.click(output)
    expect(await screen.findByText("Push failed")).toBeInTheDocument()
    await waitFor(() => expect(store.get(activityUnseenErrorAtom)).toBe(false))
  })

  test("a plugin's item joins the bar", () => {
    const store = createStore()
    store.set(installedPluginsAtom, [
      {
        info: { id: "x", label: "X", default: true, builtIn: true },
        statusItems: [
          { id: "hi", side: "right", Component: () => <span>2 working</span> },
        ],
      },
    ])
    expect(store.get(runningPluginsAtom)).toHaveLength(1)
    shell(store)
    expect(screen.getByText("2 working")).toBeInTheDocument()
  })
})

describe("panel keys", () => {
  test("⌃` toggles the panel on Terminal and ⇧⌘U opens Output", () => {
    const store = shell()
    act(() => {
      fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true })
    })
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: "terminal",
    })
    act(() => {
      fireEvent.keyDown(window, {
        key: "U",
        code: "KeyU",
        metaKey: true,
        shiftKey: true,
      })
    })
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: "output",
    })
    act(() => {
      fireEvent.keyDown(window, {
        key: "U",
        code: "KeyU",
        metaKey: true,
        shiftKey: true,
      })
    })
    expect(store.get(bottomPanelAtom).open).toBe(false)
  })

  test("a terminal that will not start says why, with Retry", async () => {
    const store = createStore()
    store.set(activeRemoteAtom, "o/r")
    store.set(bottomPanelAtom, {
      open: true,
      tab: "terminal",
      maximized: false,
    })
    shell(store)
    expect(await screen.findByText("node-pty did not load")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })
})

describe("output", () => {
  function output(store: ReturnType<typeof createStore>) {
    render(
      <Provider store={store}>
        <PanelOutput visible onRetry={() => {}} />
      </Provider>
    )
  }

  test("empty, loading and error states", () => {
    const store = createStore()
    output(store)
    expect(
      screen.getByRole("status", { name: "Loading the output" })
    ).toBeInTheDocument()
    act(() => store.set(activityLoadAtom, "error"))
    expect(screen.getByText("Could not load the output")).toBeInTheDocument()
    act(() => store.set(activityLoadAtom, "ready"))
    expect(
      screen.getByText("Nothing has happened in the background yet")
    ).toBeInTheDocument()
  })

  test("the channel filter shows one channel's lines", () => {
    const store = createStore()
    store.set(activityLoadAtom, "ready")
    store.set(activityEntriesAtom, [
      entry(1, { message: "Committed abc" }),
      entry(2, { channel: "agent", message: "Session started: x" }),
    ])
    output(store)
    expect(screen.getByText("Committed abc")).toBeInTheDocument()
    act(() => store.set(activityFilterAtom, "agent"))
    expect(screen.queryByText("Committed abc")).toBeNull()
    expect(screen.getByText("Session started: x")).toBeInTheDocument()
  })

  test("a line with detail expands", () => {
    const store = createStore()
    store.set(activityLoadAtom, "ready")
    store.set(activityEntriesAtom, [
      entry(1, {
        message: "Push failed",
        detail: "fatal: could not resolve host",
      }),
    ])
    output(store)
    expect(screen.queryByText("fatal: could not resolve host")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Push failed/ }))
    expect(
      screen.getByText("fatal: could not resolve host")
    ).toBeInTheDocument()
  })

  test("follows the foot, stops when scrolled up, and Jump to latest returns", () => {
    const store = createStore()
    store.set(activityLoadAtom, "ready")
    store.set(activityEntriesAtom, [entry(1)])
    output(store)
    const log = screen.getByRole("log")
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1000,
    })
    Object.defineProperty(log, "clientHeight", {
      configurable: true,
      value: 200,
    })
    act(() => store.set(activityEntriesAtom, [entry(1), entry(2)]))
    expect(log.scrollTop).toBe(1000)

    // Scrolled up to read: new lines leave it where it is.
    log.scrollTop = 100
    fireEvent.scroll(log)
    act(() => store.set(activityEntriesAtom, [entry(1), entry(2), entry(3)]))
    expect(log.scrollTop).toBe(100)
    const jump = screen.getByRole("button", { name: "Jump to latest" })
    fireEvent.click(jump)
    expect(log.scrollTop).toBe(1000)
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()
  })
})
