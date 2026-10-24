/**
 * Dragging a view (docs/features/tabs-panes.md, Drag targets): a strip
 * entry or a split member's part of the pill, along the strip to reorder,
 * onto the content to split or replace, and a member to the strip to leave
 * its split; and a sidebar row (a file in the tree, a session, a Holi) onto
 * the content or the strip to open it there. Native HTML5 drag with a MIME
 * type of Holi's own, so nothing else on the page (an editor) takes a tab,
 * and a tab takes nothing else.
 *
 * While one is dragged, `tabDragAtom` holds its id (a tab key, or a split's
 * id), and the content lays one transparent catcher over every view in front
 * (`panes-view.tsx`): a view may be an iframe or a terminal, which would
 * swallow the drag events. The catcher asks `slotAt` where the pointer is
 * and opens the gap `insertPreview` describes.
 *
 * The keyboard's way to the same places is the menus: Open in split view,
 * Separate, Replace with…, Move out of split, and ⌥-click.
 */
import { atom, useSetAtom } from "jotai"
import { useCallback, type DragEvent } from "react"

import { activeSplit, type ShellWorkspace } from "@/state/shell-workspace"
import { tabKey, type TabDescriptor } from "@/state/tab-descriptor"

/** The drag's MIME type; its data is the tab's key or the split's id. */
export const TAB_MIME = "application/x-holi-tab"

/** The tab or split being dragged, or null. */
export const tabDragAtom = atom<string | null>(null)

interface DragSourceProps {
  draggable: true
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
}

/** What a tab's element spreads to be draggable, by its key. */
export function useTabDragSource(): (key: string) => DragSourceProps {
  const setDrag = useSetAtom(tabDragAtom)
  return useCallback(
    (key: string) => ({
      draggable: true,
      onDragStart: (event: DragEvent) => {
        event.dataTransfer.setData(TAB_MIME, key)
        event.dataTransfer.effectAllowed = "move"
        // A frame later: changing the page under the pointer in dragstart
        // itself can cancel the drag.
        window.setTimeout(() => setDrag(key), 0)
      },
      onDragEnd: () => setDrag(null),
    }),
    [setDrag]
  )
}

/** A row with a drag of its own: the capture-phase handlers that add the
 *  tab to that drag, its own data and handlers left as they are. */
interface AlongsideProps {
  onDragStartCapture: (event: DragEvent) => void
  onDragEndCapture: () => void
}

type NoProps = Record<string, never>

/**
 * What a sidebar row spreads so it drags as the tab it opens (a document, a
 * vault app, a session, a Holi): dropped on the content it opens in that
 * place, on the strip as a tab there, or moves there when it is open
 * already. Nothing for a row that opens no tab (null).
 *
 * `alongside` is for a row that drags already (the files tree moves files
 * into folders): the tab's MIME joins the tree's own data in the same
 * dragstart, so a folder still takes the file and the content opens it.
 */
export function useTabDrag(): {
  (tab: TabDescriptor | null): DragSourceProps | NoProps
  (
    tab: TabDescriptor | null,
    options: { alongside: true }
  ): AlongsideProps | NoProps
} {
  const source = useTabDragSource()
  const setDrag = useSetAtom(tabDragAtom)
  return useCallback(
    (tab: TabDescriptor | null, options?: { alongside: true }) => {
      if (tab === null) return {}
      const key = tabKey(tab)
      if (options?.alongside !== true) return source(key)
      return {
        onDragStartCapture: (event: DragEvent) => {
          event.dataTransfer.setData(TAB_MIME, key)
          window.setTimeout(() => setDrag(key), 0)
        },
        onDragEndCapture: () => setDrag(null),
      }
    },
    [setDrag, source]
  ) as ReturnType<typeof useTabDrag>
}

/** Splits, at a member count, whose widths a drop placed (`split:count`). */
const placed = new Set<string>()

/** A drop committed `ws`: its active split's widths are what the preview
 *  showed, so nothing should reseed them. */
export function notePlaced(ws: ShellWorkspace): void {
  const split = activeSplit(ws)
  if (split !== null) placed.add(`${split.id}:${split.views.length}`)
}

/** Whether a drop placed this split's widths at this count: the shell then
 *  leaves them be rather than opening it at the widths last kept for the
 *  count, which would jump the layout the drop just landed. */
export function placedByDrop(splitId: string, count: number): boolean {
  return placed.has(`${splitId}:${count}`)
}

// ------------------------------------------------------------------ slots

/**
 * Where a drop over the content would land: before member `index` (0 to the
 * count: an outer edge or the gap between two members), or in member
 * `index`'s place.
 */
export type DropSlot =
  { kind: "insert"; index: number } | { kind: "replace"; index: number }

/**
 * The slot under the pointer at `x`, from the members' edges as laid out
 * (`edges[i]` is member i's left edge, the last one the right edge of the
 * last member), measured once as the drag arrives, so the sliding preview
 * never moves the zones under the pointer:
 *
 * - one view: its left half opens a gap on the left, its right half on the
 *   right; there is no middle (a single view's middle would take nothing);
 * - two or three: a member's outer thirds open the gap at that edge (the
 *   gap between two members is both neighbours' facing thirds), its middle
 *   third replaces it;
 * - a full split (`full`): every member is replaced, whole; nothing slides.
 */
export function slotAt(
  x: number,
  edges: readonly number[],
  full: boolean
): DropSlot | null {
  const count = edges.length - 1
  if (count < 1) return null
  const left = edges[0]!
  const right = edges[count]!
  const at = Math.max(left, Math.min(x, right - 0.01))
  let index = 0
  while (index < count - 1 && at >= edges[index + 1]!) index += 1
  if (full) return { kind: "replace", index }
  const start = edges[index]!
  const width = edges[index + 1]! - start
  const where = width > 0 ? (at - start) / width : 0.5
  if (count === 1) return { kind: "insert", index: where < 0.5 ? 0 : 1 }
  if (where < 1 / 3) return { kind: "insert", index }
  if (where > 2 / 3) return { kind: "insert", index: index + 1 }
  return { kind: "replace", index }
}

/**
 * The preview of a view landing at edge `index` of the members laid out
 * across `edges` (as `slotAt`'s): the gap is the share the newcomer gets,
 * `1 / (count + 1)` of the width, which is what the drop commits
 * (`insertIntoActive`), and it opens where the drop will put it. The
 * members before it slide left and those after it slide right, together,
 * by what the gap takes from each side, so the gap's two edges are where
 * the committed layout puts them and nothing jumps on drop.
 *
 * In pixels from the content's left edge: the gap's start and width, and
 * each member's shift.
 */
export function insertPreview(
  edges: readonly number[],
  index: number
): { gapStart: number; gapWidth: number; shifts: number[] } {
  const count = edges.length - 1
  const left = edges[0] ?? 0
  const width = (edges[count] ?? left) - left
  const gapWidth = width / (count + 1)
  const before = width > 0 ? ((edges[index] ?? left) - left) / width : 0
  const towardStart = before * gapWidth
  const towardEnd = gapWidth - towardStart
  return {
    gapStart: before * width - towardStart,
    gapWidth,
    shifts: Array.from({ length: count }, (_, i) =>
      i < index ? -towardStart : towardEnd
    ),
  }
}
