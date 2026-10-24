/**
 * Split tabs in the shell (docs/features/tabs-panes.md): one strip in the
 * title band holds every tab, a split view being one pill of it; ⌘\\, a
 * tab's menu and a drag make a split; its members carry thin headers.
 */
import { Provider, createStore } from "jotai"
import { expect, test, vi } from "vitest"
import {
  VAULT_SETTING_DEFAULTS,
  emptyVaultSnapshot,
  type ResolvedVaultSettings,
} from "@holi/shared"

import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/test/render"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import {
  activeSplit,
  focusedTab,
  isSplit,
  openTab,
} from "@/state/shell-workspace"
import { vaultSettingsAtom } from "@/state/settings"
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from "@/state/vaults"

const write = vi.fn(async (_input: unknown) => ({
  ok: true as const,
  warnings: [] as string[],
}))

const SETTINGS: ResolvedVaultSettings = {
  ...VAULT_SETTING_DEFAULTS,
  warnings: [],
}

// Every other call the shell makes answers nothing, and never rejects. Two
// levels deep, `trpc.<router>.<procedure>`, and nothing for a symbol, so
// nothing walking the mock can recurse forever.
vi.mock("@/lib/trpc", () => {
  const answer = (name: string): unknown =>
    name === "settings.read"
      ? SETTINGS
      : name === "settings.pluginFailures"
        ? {}
        : name === "github.collaborators"
          ? { visibility: "private", collaborators: [] }
          : null
  const procedure = (name: string) => ({
    query: async () => answer(name),
    mutate: name === "settings.write" ? write : async () => ({ ok: true }),
    subscribe: () => ({ unsubscribe() {} }),
  })
  const router = (routerName: string) =>
    new Proxy(
      {},
      {
        get: (_t, key) =>
          typeof key === "string"
            ? procedure(`${routerName}.${key}`)
            : undefined,
      }
    )
  const trpc = new Proxy(
    {},
    { get: (_t, key) => (typeof key === "string" ? router(key) : undefined) }
  )
  return { trpc }
})

// jsdom lays nothing out, and the resizable panels answer a zero width with
// a resize, forever: plain boxes stand in for them.
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}))

// The files sidebar's tree does not settle in jsdom; what matters here is
// only whether it or Settings' nav holds the sidebar.
vi.mock("@/components/blocks/app-shell-21/components/thread-sidebar", () => ({
  ThreadSidebar: ({ collapsed }: { collapsed?: boolean }) =>
    collapsed ? <div>Rail</div> : <div>Documents</div>,
}))

const { AppShell } =
  await import("@/components/blocks/app-shell-21/components/app-shell")

// jsdom measures nothing, so motion-panels' observers have nothing to
// watch: plain boxes stand in for its group and panels.
vi.mock("@/components/ui/motion-panels", () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelSeparator: () => <div role="separator" />,
}))
vi.mock("motion-panels/react", () => ({
  Separator: () => <div role="separator" />,
}))

function mount() {
  const store = createStore()
  store.set(activeRemoteAtom, "mara/notes")
  store.set(vaultsAtom, [
    {
      remote: "mara/notes",
      path: "/vaults/mara/notes",
      name: "notes",
      lastOpenedAt: "2026-10-23T10:00:00.000Z",
    },
  ] as never)
  store.set(snapshotAtom, emptyVaultSnapshot())
  store.set(vaultSettingsAtom, { remote: "mara/notes", settings: SETTINGS })
  store.set(shellWorkspaceAtom, (ws) => openTab(openTab(ws, "A.md"), "B.md"))
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>
  )
  return store
}

/** The views in front. */
function views(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-pane]"))
}

function stripOf(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-slot=site-header]")!
}

test("⌘\\ makes a split of the tab and a New tab: one pill, two views", async () => {
  const store = mount()
  expect(views()).toHaveLength(1)
  fireEvent.keyDown(window, { key: "\\", ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.entries).toHaveLength(2)
  expect(isSplit(ws.entries[1])).toBe(true)
  // Both tabs stay in the one strip: A as a tab, the split as a pill.
  const strip = within(stripOf())
  expect(strip.getByRole("tab", { name: "A" })).toBeTruthy()
  expect(
    strip.getByRole("tab", { name: "Split view: B, New tab" })
  ).toBeTruthy()
  // No member has a header of its own or holds tabs: the pill does.
  expect(document.querySelectorAll("[data-slot=pane-header]")).toHaveLength(0)
  expect(within(views()[0]!).queryByRole("tab")).toBeNull()
  expect(within(views()[1]!).queryByRole("tab")).toBeNull()
})

test("selecting another tab shows it alone, the split staying in the strip", async () => {
  const store = mount()
  fireEvent.keyDown(window, { key: "\\", ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  fireEvent.mouseDown(within(stripOf()).getByRole("tab", { name: "A" }))
  await waitFor(() => expect(views()).toHaveLength(1))
  expect(store.get(shellWorkspaceAtom).active).toBe("A.md")
  expect(
    within(stripOf()).getByRole("tab", { name: /Split view/ })
  ).toBeTruthy()
})

test("a tab's menu opens it in split view with the active tab", async () => {
  const store = mount()
  fireEvent.contextMenu(within(stripOf()).getByRole("tab", { name: "A" }))
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /Open in split view/ })
  )
  await waitFor(() => expect(views()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.entries).toHaveLength(1)
  expect(activeSplit(ws)?.views).toEqual(["B.md", "A.md"])
  expect(focusedTab(ws)).toBe("A.md")
})

test("a member moves out of its split from the pill's menu", async () => {
  const store = mount()
  fireEvent.contextMenu(within(stripOf()).getByRole("tab", { name: "A" }))
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /Open in split view/ })
  )
  await waitFor(() => expect(views()).toHaveLength(2))
  const left = document.querySelector("[data-member]")!
  fireEvent.contextMenu(left)
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /Move out of split/ })
  )
  await waitFor(() => expect(views()).toHaveLength(1))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.entries).toEqual(["A.md", "B.md"])
  expect(ws.active).toBe("B.md")
})

test("⌘T opens a New tab; ⇧⌘\\ separates; ⌃⌥→ focuses the next member", async () => {
  const store = mount()
  fireEvent.keyDown(window, { key: "t", ctrlKey: true })
  await waitFor(() =>
    expect(store.get(shellWorkspaceAtom).entries).toHaveLength(3)
  )
  expect(focusedTab(store.get(shellWorkspaceAtom))).toMatch(/^holi:new:/)
  fireEvent.keyDown(window, { key: "\\", ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  const first = focusedTab(store.get(shellWorkspaceAtom))
  fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true, altKey: true })
  await waitFor(() =>
    expect(focusedTab(store.get(shellWorkspaceAtom))).not.toBe(first)
  )
  fireEvent.keyDown(window, { key: "|", ctrlKey: true, shiftKey: true })
  await waitFor(() => expect(views()).toHaveLength(1))
  expect(store.get(shellWorkspaceAtom).entries).toHaveLength(4)
})

/** A drag event at `x`: jsdom's drag events carry no pointer position. */
function at(event: Event, x: number): Event {
  Object.defineProperty(event, "clientX", { value: x })
  return event
}

/** A drag's data, as jsdom has none. */
function transfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  } as unknown as DataTransfer
}

test("dragging a strip tab onto the view's right edge splits with it there", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] })
  const store = mount()
  const dataTransfer = transfer()
  const tab = document.querySelector<HTMLElement>("[data-tab-key='A.md']")!
  fireEvent.dragStart(tab, { dataTransfer })
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  const target = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-drop-target]")
    expect(el).toBeTruthy()
    return el!
  })
  // jsdom lays nothing out: a 1000px wide view, the pointer at 900.
  target.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
    }) as DOMRect
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer }), 900))
  await waitFor(() => expect(target.dataset.dropZone).toBe("right"))
  fireEvent(target, at(createEvent.drop(target, { dataTransfer }), 900))
  await waitFor(() => expect(views()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(activeSplit(ws)?.views).toEqual(["B.md", "A.md"])
  expect(ws.entries).toHaveLength(1)
  // The drag is over: no targets left over the views.
  await waitFor(() =>
    expect(document.querySelector("[data-drop-target]")).toBeNull()
  )
})
