/**
 * Where a drag over the content lands, and how far the views slide for it
 * (docs/features/tabs-panes.md, Drag targets); a sidebar row's drag carries
 * the tab it opens.
 */
import { Provider, createStore } from "jotai"
import { expect, test, vi } from "vitest"

import { fireEvent, render, screen } from "@/test/render"

import {
  insertPreview,
  slotAt,
  TAB_MIME,
  tabDragAtom,
  useTabDrag,
} from "../use-tab-drag"

test("one view: each half opens a gap on its side, with no middle", () => {
  const edges = [0, 1000]
  expect(slotAt(100, edges, false)).toEqual({ kind: "insert", index: 0 })
  expect(slotAt(499, edges, false)).toEqual({ kind: "insert", index: 0 })
  expect(slotAt(500, edges, false)).toEqual({ kind: "insert", index: 1 })
  expect(slotAt(2000, edges, false)).toEqual({ kind: "insert", index: 1 })
})

test("two or three views: outer thirds open the gap at that edge, the middle third replaces", () => {
  const edges = [0, 600, 900]
  expect(slotAt(150, edges, false)).toEqual({ kind: "insert", index: 0 })
  expect(slotAt(300, edges, false)).toEqual({ kind: "replace", index: 0 })
  // The gap between two members is both neighbours' facing thirds.
  expect(slotAt(500, edges, false)).toEqual({ kind: "insert", index: 1 })
  expect(slotAt(650, edges, false)).toEqual({ kind: "insert", index: 1 })
  expect(slotAt(750, edges, false)).toEqual({ kind: "replace", index: 1 })
  expect(slotAt(880, edges, false)).toEqual({ kind: "insert", index: 2 })
})

test("a full split only replaces, member by member", () => {
  const edges = [0, 250, 500, 750, 1000]
  expect(slotAt(10, edges, true)).toEqual({ kind: "replace", index: 0 })
  expect(slotAt(600, edges, true)).toEqual({ kind: "replace", index: 2 })
  expect(slotAt(999, edges, true)).toEqual({ kind: "replace", index: 3 })
})

test("the gap is the newcomer's share, where the drop puts it", () => {
  // One view, gap on the right: half the width, the view slid half left.
  // One view shrinks to half, on the side away from the gap.
  const right = insertPreview([0, 1000], 1)
  expect(right.gapStart).toBe(500)
  expect(right.gapWidth).toBe(500)
  expect(right.spans).toEqual([{ offset: 0, width: 500 }])
  const leftGap = insertPreview([0, 1000], 0)
  expect(leftGap.gapStart).toBe(0)
  expect(leftGap.spans).toEqual([{ offset: 500, width: 500 }])
  // Two views 600/400, gap between: a third of the width, where the
  // committed shares (0.4, 1/3, 0.267) put it, and both shrink by a third.
  const two = insertPreview([0, 600, 1000], 1)
  expect(two.gapWidth).toBeCloseTo(1000 / 3)
  expect(two.gapStart).toBeCloseTo(400)
  expect(two.spans[0]!.offset).toBeCloseTo(0)
  expect(two.spans[0]!.width).toBeCloseTo(400)
  expect(two.spans[1]!.offset).toBeCloseTo(400 + 1000 / 3 - 600)
  expect(two.spans[1]!.width).toBeCloseTo(400 * (2 / 3))
  // Nothing leaves the screen: the last view ends at the right edge.
  expect(600 + two.spans[1]!.offset + two.spans[1]!.width).toBeCloseTo(1000)
  expect(two.boundaries[1]).toBeCloseTo(400 - 600)
})

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

function Rows({ own }: { own: (event: React.DragEvent) => void }) {
  const tabDrag = useTabDrag()
  return (
    <>
      <button
        type="button"
        {...tabDrag({ kind: "session", owner: "agent", id: "session:7" })}
      >
        Session
      </button>
      <div
        draggable
        onDragStart={own}
        {...tabDrag({ kind: "doc", path: "Notes/A.md" }, { alongside: true })}
      >
        File
      </div>
    </>
  )
}

test("a sidebar row's drag carries its tab, beside a row's own drag", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] })
  const store = createStore()
  const own = vi.fn((event: React.DragEvent) =>
    event.dataTransfer.setData("text/plain", "tree")
  )
  render(
    <Provider store={store}>
      <Rows own={own} />
    </Provider>
  )
  const session = transfer()
  fireEvent.dragStart(screen.getByText("Session"), { dataTransfer: session })
  expect(session.getData(TAB_MIME)).toBe("holi:session:agent:session:7")
  await vi.runAllTimersAsync()
  expect(store.get(tabDragAtom)).toBe("holi:session:agent:session:7")
  fireEvent.dragEnd(screen.getByText("Session"))
  expect(store.get(tabDragAtom)).toBeNull()

  const file = transfer()
  fireEvent.dragStart(screen.getByText("File"), { dataTransfer: file })
  expect(file.getData(TAB_MIME)).toBe("Notes/A.md")
  expect(file.getData("text/plain")).toBe("tree")
  expect(own).toHaveBeenCalledOnce()
  await vi.runAllTimersAsync()
  expect(store.get(tabDragAtom)).toBe("Notes/A.md")
  vi.useRealTimers()
})
