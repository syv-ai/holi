/**
 * The graph: every note a dot that opens it, a count of notes and links,
 * an empty vault offered a way in, and a failed read offered Retry.
 */
import { emptyVaultSnapshot } from "@holi/shared"
import { createStore, Provider } from "jotai"
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest"

import { fireEvent, render, screen, waitFor } from "@/test/render"
import { activeRemoteAtom, snapshotAtom } from "@/state/vaults"

import { GraphView } from "../graph-view"

const graph = vi.hoisted(() => vi.fn())
vi.mock("@/lib/trpc", () => ({
  trpc: { notes: { graph: { query: (input: unknown) => graph(input) } } },
}))

// jsdom lays nothing out: the picture needs a box to draw into.
const sizes = ["clientWidth", "clientHeight"] as const
beforeAll(() => {
  for (const size of sizes) {
    Object.defineProperty(HTMLElement.prototype, size, {
      configurable: true,
      get: () => 600,
    })
  }
})
afterAll(() => {
  for (const size of sizes) delete (HTMLElement.prototype as never)[size]
})

beforeEach(() => graph.mockReset())

function mount() {
  const store = createStore()
  store.set(activeRemoteAtom, "syv/vault")
  store.set(snapshotAtom, emptyVaultSnapshot())
  const onOpen = vi.fn()
  render(
    <Provider store={store}>
      <GraphView onOpen={onOpen} reading="Plan.md" />
    </Provider>
  )
  return onOpen
}

test("draws every note as a dot that opens it, and counts them", async () => {
  graph.mockResolvedValue({
    nodes: ["Plan.md", "Notes/Idea.md", ".holi/memory/user.md"],
    edges: [[0, 1]],
    total: 3,
  })
  const onOpen = mount()
  expect(await screen.findByText(/3 notes · 1 link/)).toBeInTheDocument()
  expect(graph).toHaveBeenCalledWith({ remote: "syv/vault", hidden: false })
  // Queried by its node: jsdom's role lookup is unreliable inside an SVG.
  const dot = (path: string) =>
    document.querySelector<SVGGElement>(`[data-graph-node="${path}"]`)!
  // Drawn once the box has been measured, a render after the count.
  await waitFor(() => expect(dot("Notes/Idea.md")).not.toBeNull())
  expect(dot("Notes/Idea.md")).toHaveAttribute("role", "link")
  expect(dot("Notes/Idea.md")).toHaveAttribute("aria-label", "Notes/Idea.md")
  fireEvent.click(dot("Notes/Idea.md"))
  expect(onOpen).toHaveBeenCalledWith("Notes/Idea.md")
  fireEvent.keyDown(dot("Plan.md"), { key: "Enter" })
  expect(onOpen).toHaveBeenCalledWith("Plan.md")
  // The note being read beside the graph is drawn in the theme colour.
  expect(
    document.querySelector('[data-graph-node="Plan.md"] circle')
  ).toHaveClass("fill-primary")
})

test("a vault with no notes says how to get some", async () => {
  graph.mockResolvedValue({ nodes: [], edges: [], total: 0 })
  mount()
  expect(await screen.findByText("No notes to draw yet")).toBeInTheDocument()
})

test("a read that failed offers Retry, which asks again", async () => {
  graph.mockRejectedValueOnce(new Error("offline"))
  graph.mockResolvedValue({ nodes: ["Plan.md"], edges: [], total: 1 })
  mount()
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
  expect(await screen.findByText(/1 note · 0 links/)).toBeInTheDocument()
})
