/**
 * The empty view: where you are, what to do next, and what was written last,
 * all read from the vault's own state.
 */
import { Provider, createStore } from "jotai"
import { expect, test, vi } from "vitest"
import { emptyVaultSnapshot, type VaultSnapshot } from "@holi/shared"
import { fireEvent, render, screen } from "@/test/render"
import { nowAtom } from "@/state/clock"
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from "@/state/vaults"
import { BOARD_TAB } from "../documents-section"
import { EmptyView, isNewTab, NEW_TAB_PREFIX } from "../empty-view"

function snapshotWith(docs: VaultSnapshot["docs"]): VaultSnapshot {
  return { ...emptyVaultSnapshot(), docs }
}

function mount(snapshot: VaultSnapshot | null) {
  const store = createStore()
  store.set(nowAtom, "2026-10-23T12:00")
  store.set(activeRemoteAtom, "mara/notes")
  store.set(vaultsAtom, [
    {
      remote: "mara/notes",
      path: "/vaults/mara/notes",
      name: "notes",
      lastOpenedAt: "2026-10-23T10:00:00.000Z",
    },
  ] as never)
  if (snapshot) store.set(snapshotAtom, snapshot)
  const onOpen = vi.fn()
  const onNewDocument = vi.fn()
  render(
    <Provider store={store}>
      <EmptyView
        onOpen={onOpen}
        onNewDocument={onNewDocument}
        onOpenSearch={() => {}}
      />
    </Provider>
  )
  return { onOpen, onNewDocument }
}

test("names the vault and the day", () => {
  mount(snapshotWith([]))
  expect(screen.getByText("notes")).toBeTruthy()
  expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/23/)
})

test("lists the newest documents first, leaving hidden ones out", () => {
  const { onOpen } = mount(
    snapshotWith([
      { path: "Old.md", kind: "note", updatedAt: "2026-09-01T10:00:00Z" },
      {
        path: "Meetings/Kickoff.md",
        kind: "note",
        updatedAt: "2026-10-23T09:00:00Z",
      },
      { path: ".holi/x.md", kind: "note", updatedAt: "2026-10-23T11:00:00Z" },
    ])
  )
  const rows = screen
    .getAllByRole("button")
    .map((row) => row.textContent ?? "")
    .filter((text) => /Kickoff|Old|x/.test(text))
  expect(rows[0]).toMatch(/^Kickoff/)
  expect(rows[1]).toMatch(/^Old/)
  expect(rows.some((text) => text.startsWith("x"))).toBe(false)
  // One line: the name, where it lives, and when.
  expect(rows[0]).toMatch(/^KickoffMeetingsToday$/)
  fireEvent.click(screen.getByText("Kickoff"))
  expect(onOpen).toHaveBeenCalledWith("Meetings/Kickoff.md")
})

test("opens the board", () => {
  const { onOpen } = mount(snapshotWith([]))
  fireEvent.click(screen.getByText("Board"))
  expect(onOpen).toHaveBeenCalledWith(BOARD_TAB)
})

test("an unscanned vault shows a loading state, an empty one an action", () => {
  mount(null)
  expect(
    screen.getByRole("status", { name: "Loading recent documents" })
  ).toBeTruthy()
  document.body.innerHTML = ""
  const { onNewDocument } = mount(snapshotWith([]))
  expect(screen.getByText("Nothing written in this vault yet.")).toBeTruthy()
  const buttons = screen.getAllByText("New document")
  fireEvent.click(buttons[buttons.length - 1]!)
  expect(onNewDocument).toHaveBeenCalled()
})

test("a New tab is told apart by its id", () => {
  expect(isNewTab(`${NEW_TAB_PREFIX}1`)).toBe(true)
  expect(isNewTab("Meetings/Kickoff.md")).toBe(false)
  expect(isNewTab(null)).toBe(false)
})
