/**
 * Where a drop lands, and what is on the wire.
 *
 * jsdom computes no layout, so the hit-testing arithmetic lives here and takes
 * numbers; the components only read rectangles and dispatch.
 */

import type { Tab } from '@/state/panes'

/**
 * The custom MIME type a tab drag carries.
 *
 * Custom because it is also the "is a tab being dragged" predicate: during
 * `dragover` only `types` is exposed, never the data.
 */
export const TAB_MIME = 'application/x-holi-tab'

/** Fraction of a pane's width that reads as an edge, and the ceiling on it. */
const EDGE_FRACTION = 0.25
const EDGE_MAX_PX = 120

/** The band at each end of a strip that arms auto-slide. */
const SLIDE_BAND_PX = 28

/** Auto-scroll step and interval: ~750px/s, fast enough to cross a strip,
 *  slow enough to stop where you want. */
export const AUTOSCROLL_PX = 12
export const AUTOSCROLL_MS = 16

/** A rendered pill: where it is, and which tab it actually is. */
export interface PillBox {
  /** The tab's index in `pane.tabs` — **absolute**, not the rendered offset. */
  index: number
  left: number
  width: number
}

/**
 * The absolute index a drop at `x` should insert before.
 *
 * Pills carry absolute indices: a scrolled strip's leftmost pill is often not
 * tab 0. Past the last pill this returns `last.index + 1`; the caller clamps.
 */
export function dropIndex(pills: PillBox[], x: number): number {
  for (const pill of pills) {
    if (x < pill.left + pill.width / 2) return pill.index
  }
  const last = pills.at(-1)
  return last === undefined ? 0 : last.index + 1
}

export type PaneDropZone = 'before' | 'into' | 'after'

/**
 * Which third of a pane a drop at `x` is aimed at: a new column on either side,
 * or into the pane itself.
 *
 * A quarter of the width, capped: on a wide pane an uncapped quarter makes
 * dropping into the pane the hard gesture.
 */
export function paneDropZone(rect: { left: number; width: number }, x: number): PaneDropZone {
  const edge = Math.min(rect.width * EDGE_FRACTION, EDGE_MAX_PX)
  if (x < rect.left + edge) return 'before'
  if (x > rect.left + rect.width - edge) return 'after'
  return 'into'
}

/**
 * Which end of the strip a drag is hovering, or null in the middle.
 *
 * The wheel is unavailable mid-drag, so this is what reaches off-screen
 * positions. On a strip narrower than two bands the left one wins, harmlessly.
 */
export function stripEdge(
  rect: { left: number; width: number },
  x: number,
): 'left' | 'right' | null {
  if (x < rect.left + SLIDE_BAND_PX) return 'left'
  if (x > rect.left + rect.width - SLIDE_BAND_PX) return 'right'
  return null
}

/**
 * What rides on the drag: the tab's identity only. Indices could go stale
 * mid-drag, and `findTab` spans the workspace. `preview` is read from the
 * workspace's own tab by `moveTab`.
 */
export function tabPayload(tab: Tab): string {
  return JSON.stringify(
    tab.kind === 'note'
      ? { kind: 'note', path: tab.path }
      : tab.kind === 'app'
        ? { kind: 'app', path: tab.path }
        : { kind: tab.kind },
  )
}

/**
 * Read a payload back, or null.
 *
 * The trust boundary: any drag source on the machine can write a
 * `DataTransfer`, so every field is checked and a fresh narrow object built.
 */
export function parseTabPayload(text: string): Tab | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const { kind, path } = value as Record<string, unknown>
  if (kind === 'note') {
    return typeof path === 'string' && path !== '' ? { kind: 'note', path } : null
  }
  if (kind === 'app') {
    return typeof path === 'string' && path !== '' ? { kind: 'app', path } : null
  }
  if (kind === 'board' || kind === 'agenda' || kind === 'mail' || kind === 'settings') {
    return { kind }
  }
  return null
}
