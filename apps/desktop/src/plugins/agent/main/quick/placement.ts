/**
 * Where a quick panel goes: a prompt beside the pointer, wholly on the display
 * the pointer is on, and not on top of another panel; the dock against the
 * right edge of a display; an agent's panel to the left of the dock, level
 * with its dot. Pure.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The gap between the pointer and the panel's corner, and between a panel
 *  and the edge of the work area or another panel. */
export const GAP = 12

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** `r` moved (never resized, unless it is larger than the area) to lie inside `area`. */
export function clampInto(r: Rect, area: Rect): Rect {
  const width = Math.min(r.width, area.width - 2 * GAP)
  const height = Math.min(r.height, area.height - 2 * GAP)
  const x = Math.min(Math.max(r.x, area.x + GAP), area.x + area.width - GAP - width)
  const y = Math.min(Math.max(r.y, area.y + GAP), area.y + area.height - GAP - height)
  return { x: Math.round(x), y: Math.round(y), width, height }
}

/**
 * A panel of `size` placed at `cursor`: its top-left corner just below and
 * right of the pointer, then pushed inside `area`. Where that lands on one of
 * `taken` (the other panels showing), it steps down past it, and up when
 * there is no room below, so two panels never sit exactly on each other.
 */
export function placeAtCursor(
  cursor: Point,
  size: { width: number; height: number },
  area: Rect,
  taken: readonly Rect[] = [],
): Rect {
  let r = clampInto({ x: cursor.x + GAP, y: cursor.y + GAP, ...size }, area)
  for (let i = 0; i < taken.length + 1; i += 1) {
    const hit = taken.find((t) => overlaps(r, t))
    if (hit === undefined) return r
    const below = hit.y + hit.height + GAP
    const roomBelow = below + r.height <= area.y + area.height - GAP
    const next = clampInto({ ...r, y: roomBelow ? below : hit.y - GAP - r.height }, area)
    if (next.x === r.x && next.y === r.y) return r
    r = next
  }
  return r
}

/** A panel resized in place: its corner stays where it is unless the new size
 *  would leave the work area, in which case it moves just enough. */
export function resizeInPlace(r: Rect, size: { width: number; height: number }, area: Rect): Rect {
  return clampInto({ x: r.x, y: r.y, ...size }, area)
}

/** The gap between the dock and the right edge of the work area. */
export const DOCK_EDGE = 6
/** The gap between the dock and a panel out beside it. */
export const DOCK_GAP = 8

/** The dock: against the right edge of `area`, vertically centred, and never
 *  taller than the area. */
export function placeDock(size: { width: number; height: number }, area: Rect): Rect {
  const height = Math.min(size.height, area.height - 2 * DOCK_EDGE)
  return {
    x: Math.round(area.x + area.width - DOCK_EDGE - size.width),
    y: Math.round(area.y + (area.height - height) / 2),
    width: size.width,
    height,
  }
}

/**
 * An agent's panel of `size` out beside the dock at `dock`: to its left, with
 * the point `header` down the panel at `level` (its dot's centre, in screen
 * coordinates), then pushed inside `area`, so a dot near the bottom of a tall
 * dock still has its whole panel on screen.
 */
export function placeBesideDock(
  size: { width: number; height: number },
  dock: Rect,
  level: number,
  header: number,
  area: Rect,
): Rect {
  return clampInto({ x: dock.x - DOCK_GAP - size.width, y: level - header, ...size }, area)
}
