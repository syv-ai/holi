/**
 * Dragging a tab to another pane, or to a pane's edge to split
 * (docs/features/tabs-panes.md, Split view). Native HTML5 drag with a MIME
 * type of Holi's own, so nothing else on the page (the files tree, an
 * editor) takes a tab for a file, and a tab takes nothing else.
 *
 * While a tab is dragged, `tabDragAtom` holds its key, and every pane lays a
 * drop target over its content (`panes-view.tsx`): a pane's view may be an
 * iframe or a terminal, which would swallow the drag events.
 *
 * The keyboard's way to the same places is the tab's menu: Open in split
 * view, Split right, Move to the left or right pane.
 */
import { atom, useSetAtom } from "jotai"
import type { DragEvent } from "react"

import type { DropZone } from "@/state/shell-workspace"

/** The drag's MIME type; its data is the tab's key. */
export const TAB_MIME = "application/x-holi-tab"

/** The tab being dragged, or null. */
export const tabDragAtom = atom<string | null>(null)

/** What a tab's element spreads to be draggable, by its key. */
export function useTabDragSource(): (key: string) => {
  draggable: true
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
} {
  const setDrag = useSetAtom(tabDragAtom)
  return (key) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(TAB_MIME, key)
      event.dataTransfer.effectAllowed = "move"
      // A frame later: changing the page under the pointer in dragstart
      // itself can cancel the drag.
      window.setTimeout(() => setDrag(key), 0)
    },
    onDragEnd: () => setDrag(null),
  })
}

/**
 * The zone under the pointer, from where it is across the pane: the outer
 * thirds are its edges, the middle third the pane itself. Over the dragged
 * tab's own pane there is no middle (dropping a tab into its own pane does
 * nothing), so each half is an edge.
 */
export function zoneAt(
  x: number,
  rect: { left: number; width: number },
  own: boolean
): DropZone {
  const at = rect.width > 0 ? (x - rect.left) / rect.width : 0.5
  if (own) return at < 0.5 ? "left" : "right"
  if (at < 1 / 3) return "left"
  if (at > 2 / 3) return "right"
  return "center"
}
