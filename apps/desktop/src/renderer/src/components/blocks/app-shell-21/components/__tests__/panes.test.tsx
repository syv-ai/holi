/**
 * Panes in the shell: ⌘\\ splits the main area, each pane carries its own
 * strip, a tab moves to the other pane from its menu, and closing a split
 * pane's last tab closes the pane.
 */
import { Provider, createStore } from "jotai"
import { expect, test, vi } from "vitest"
import {
  VAULT_SETTING_DEFAULTS,
  emptyVaultSnapshot,
  type ResolvedVaultSettings,
} from "@holi/shared"

import { fireEvent, render, screen, waitFor, within } from "@/test/render"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import { openTab } from "@/state/shell-workspace"
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

function panes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-pane]"))
}

test("⌘\\ splits right: a second pane, focused, each with its own strip", async () => {
  const store = mount()
  expect(panes()).toHaveLength(1)
  fireEvent.keyDown(window, { key: "\\", ctrlKey: true })
  await waitFor(() => expect(panes()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.focused).toBe(ws.panes[1]!.id)
  expect(within(panes()[0]!).getByRole("tab", { name: /B/ })).toBeTruthy()
  expect(within(panes()[1]!).getByRole("tab", { name: /New tab/ })).toBeTruthy()
})

test("a tab moves to the other pane, and a pane goes with its last tab", async () => {
  const store = mount()
  fireEvent.keyDown(window, { key: "\\", ctrlKey: true })
  await waitFor(() => expect(panes()).toHaveLength(2))
  const left = panes()[0]!
  fireEvent.contextMenu(within(left).getByRole("tab", { name: /A/ }))
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /Move to right pane/ })
  )
  await waitFor(() =>
    expect(within(panes()[1]!).getByRole("tab", { name: /A/ })).toBeTruthy()
  )
  // Close the right pane's tabs: the pane closes, the left one stays.
  const right = panes()[1]!
  for (const name of ["Close A", "Close New tab"]) {
    fireEvent.click(within(right).getByRole("button", { name }))
  }
  await waitFor(() => expect(panes()).toHaveLength(1))
  expect(store.get(shellWorkspaceAtom).panes[0]!.tabs).toEqual(["B.md"])
})
