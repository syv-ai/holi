/**
 * The Files menu's New items make things where the menu was opened: a
 * folder row's menu makes them in that folder, the empty space's at the root.
 */
import { Provider, createStore } from "jotai"
import { expect, test, vi } from "vitest"
import { emptyVaultSnapshot } from "@holi/shared"
import { fireEvent, render, screen, waitFor } from "@/test/render"
import { coreContributionAtom } from "@/state/plugins"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from "@/state/vaults"
import { SidebarProvider } from "@/components/ui/sidebar"
import { FilesSection } from "../documents-section"

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
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    dirs: ["kunder"],
    docs: [
      {
        path: "kunder/brief.md",
        title: "brief",
        updatedAt: "2026-10-23T10:00:00Z",
      },
    ] as never,
  })
  const run = vi.fn(
    async ({ parent, name }: { parent: string; name: string }) =>
      `${parent === "" ? "" : `${parent}/`}${name}.app/index.html`
  )
  store.set(coreContributionAtom, {
    surfaces: [],
    rail: [],
    claims: [
      {
        match: (p: string) => p.endsWith(".app"),
        folder: { surface: "app", entry: "index.html" },
        create: {
          id: "app",
          label: "New app",
          icon: () => null,
          placeholder: "App name",
          run,
        },
      },
    ],
  })
  const onOpen = vi.fn()
  render(
    <Provider store={store}>
      <SidebarProvider>
        <FilesSection
          activeId={null}
          onOpen={onOpen}
          onMoved={() => undefined}
        />
      </SidebarProvider>
    </Provider>
  )
  return { run, onOpen, store }
}

test("New app on a folder's menu makes the app in that folder", async () => {
  const { run, onOpen } = mount()
  fireEvent.contextMenu(await screen.findByText("kunder"))
  fireEvent.click(await screen.findByRole("menuitem", { name: "New app" }))
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      remote: "mara/notes",
      parent: "kunder",
      name: "Untitled",
    })
  )
  await waitFor(() =>
    expect(onOpen).toHaveBeenCalledWith("kunder/Untitled.app")
  )
})

test("New app on a file's menu makes the app beside the file", async () => {
  const { run } = mount()
  fireEvent.click(await screen.findByText("kunder"))
  fireEvent.contextMenu(await screen.findByText("brief"))
  fireEvent.click(await screen.findByRole("menuitem", { name: "New app" }))
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ parent: "kunder" })
    )
  )
})

test("a file's menu opens it in split view beside what is in front", async () => {
  const { store } = mount()
  fireEvent.click(await screen.findByText("kunder"))
  fireEvent.contextMenu(await screen.findByText("brief"))
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Open in split view" })
  )
  expect(JSON.stringify(store.get(shellWorkspaceAtom))).toContain(
    "kunder/brief.md"
  )
})

test("a folder's menu has no Open in split view", async () => {
  mount()
  fireEvent.contextMenu(await screen.findByText("kunder"))
  await screen.findByRole("menuitem", { name: "New app" })
  expect(
    screen.queryByRole("menuitem", { name: "Open in split view" })
  ).toBeNull()
})
