/**
 * The Apps page: a card per vault app on ReUI's c-card-7, with its icon,
 * whether it is shared or personal, its folder, its name, its manifest's
 * description and Open; a skeleton while the vault loads; and the empty
 * states for no apps and for the plugin being off.
 */
import { atom, createStore, Provider } from "jotai"
import { expect, test, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import type { VaultSnapshot } from "@holi/shared"
import { render, screen, within } from "@/test/render"
import { coreContributionAtom } from "@/state/plugins"
import { activeRemoteAtom, snapshotAtom } from "@/state/vaults"
import { AppsView } from "../apps-view"

const APPS = ["tools/Budget.app", "Home.local.app"]

function files(paths: string[], updatedAt = "2026-10-01T00:00:00Z") {
  return paths.flatMap((app) => [
    { path: `${app}/index.html`, updatedAt },
    { path: `${app}/app.yaml`, updatedAt },
  ])
}

function withApps({
  apps = APPS,
  describe,
  loaded = true,
  create,
}: {
  apps?: string[]
  describe?: (remote: string, id: string) => Promise<string | null>
  loaded?: boolean
  create?: () => Promise<string | null>
} = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, "syv-ai/site")
  if (loaded) {
    store.set(snapshotAtom, {
      docs: [],
      claimed: {},
      files: files(apps),
      dirs: [],
      icons: {},
    } as unknown as VaultSnapshot)
  }
  store.set(coreContributionAtom, {
    rail: [],
    claims:
      create === undefined
        ? []
        : [
            {
              match: () => true,
              folder: { surface: "app", entry: "index.html" },
              create: {
                id: "app",
                label: "New app",
                icon: () => null,
                placeholder: "App name",
                run: create,
              },
            },
          ],
    surfaces: [
      {
        kind: "app",
        label: (id?: string) =>
          (id ?? "App").replace(/^.*\//, "").replace(/(\.local)?\.app$/, ""),
        icon: () => <svg data-testid="app-icon" />,
        render: () => null,
        instances: atom(apps),
        describe,
      },
    ],
  } as never)
  return store
}

function renderView(store: ReturnType<typeof createStore>, onOpen = vi.fn()) {
  render(
    <Provider store={store}>
      <AppsView onOpen={onOpen} />
    </Provider>
  )
  return onOpen
}

test("each app is a card with its state, folder, name and description, and Open opens it", async () => {
  const describe = vi.fn(async (_remote: string, id: string) =>
    id === "tools/Budget.app" ? "What the month cost, by category" : null
  )
  const onOpen = renderView(withApps({ describe }))

  const cards = screen.getAllByRole("listitem")
  expect(cards).toHaveLength(2)

  const budget = within(cards[0]!)
  expect(budget.getByText("Budget")).toBeInTheDocument()
  expect(budget.getByText("Shared")).toBeInTheDocument()
  expect(budget.getByText("tools")).toBeInTheDocument()
  expect(
    await budget.findByText("What the month cost, by category")
  ).toBeInTheDocument()

  const home = within(cards[1]!)
  expect(home.getByText("Personal")).toBeInTheDocument()
  expect(home.getByText("Vault root")).toBeInTheDocument()
  expect(await home.findByText("No description yet.")).toBeInTheDocument()

  expect(describe).toHaveBeenCalledWith("syv-ai/site", "tools/Budget.app")

  await userEvent.click(screen.getByRole("button", { name: "Open Budget" }))
  expect(onOpen).toHaveBeenCalledWith("tools/Budget.app")
})

test("a description that cannot be read says so, and Retry reads it again", async () => {
  let fail = true
  const describe = vi.fn(async () => {
    if (fail) throw new Error("gone")
    return "Back again"
  })
  renderView(withApps({ apps: ["Budget.app"], describe }))

  expect(
    await screen.findByText("Couldn't read its description.")
  ).toBeInTheDocument()
  fail = false
  await userEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText("Back again")).toBeInTheDocument()
  expect(describe).toHaveBeenCalledTimes(2)
})

test("an app's description is read again when its files change", async () => {
  const describe = vi.fn(async () => "First")
  const store = withApps({ apps: ["Budget.app"], describe })
  renderView(store)
  expect(await screen.findByText("First")).toBeInTheDocument()

  describe.mockResolvedValue("Second")
  store.set(snapshotAtom, {
    ...store.get(snapshotAtom),
    files: files(["Budget.app"], "2026-10-02T00:00:00Z"),
  })
  expect(await screen.findByText("Second")).toBeInTheDocument()
})

test("while the vault loads, the page shows card skeletons", () => {
  renderView(withApps({ loaded: false }))
  expect(screen.getByRole("list", { name: "Loading apps" })).toBeInTheDocument()
  expect(screen.queryByText("No apps yet")).not.toBeInTheDocument()
})

test("with no apps, the empty state offers New app, which opens the new app", async () => {
  const create = vi.fn(async () => "Untitled.app/index.html")
  const onOpen = renderView(withApps({ apps: [], create }))
  expect(screen.getByText("No apps yet")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "New app" }))
  expect(create).toHaveBeenCalledWith({
    remote: "syv-ai/site",
    parent: "",
    name: "Untitled",
  })
  expect(onOpen).toHaveBeenCalledWith("Untitled.app")
})

test("with the plugin off, the page says how to turn it on", () => {
  renderView(createStore())
  expect(screen.getByText("Vault apps are off")).toBeInTheDocument()
})
