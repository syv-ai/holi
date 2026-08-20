/**
 * Where a drop lands, and what is on the wire.
 *
 * The strip and the pane both hit-test a drag against rectangles they measure
 * themselves. None of that can be tested in place: jsdom computes no layout, so
 * every `getBoundingClientRect` is `0×0` — `test/setup.dom.ts` says so at length
 * and parks the resizable handles at (10000, 10000) to keep clicks working
 * around it. So the arithmetic lives here, takes numbers, and is checked on
 * numbers. It is the same split `tab-window.ts` made one file over: clipping is
 * a stylesheet's job, deciding *what* survives the clip is not.
 *
 * The components read rectangles and dispatch. That is all they do.
 */

import type { Tab } from '@/state/panes'

/**
 * The custom MIME type a tab drag carries.
 *
 * It is also the *"is a tab being dragged"* predicate, which is why it has to be
 * custom. `dataTransfer.getData` returns an empty string during `dragover` by
 * spec — only `types` is exposed while a drag is in flight — so a target cannot
 * ask *what* is being dragged before it decides whether to accept the drop. It
 * can only ask whether a type it recognises is present. `BoardView` uses bare
 * `text/plain` because it never needs that question answered mid-drag.
 */
export const TAB_MIME = 'application/x-holi-tab'

/** Fraction of a pane's width that reads as an edge, and the ceiling on it. */
const EDGE_FRACTION = 0.25
const EDGE_MAX_PX = 120

/** The band at each end of a strip that arms auto-slide. */
const SLIDE_BAND_PX = 28

/** How long the strip waits between sliding one tab further under a drag. Fast
 *  enough to cross a full strip, slow enough to stop on the one you want. */
export const SLIDE_MS = 350

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
 * `pills` are the **visible** pills, in order, carrying their absolute indices.
 * That distinction is the whole reason this takes `PillBox` rather than a plain
 * width array: the strip renders a *window* (`tab-window.ts`), so the leftmost
 * pill is very often not tab 0, and a caret computed against the rendered offset
 * reorders a different tab than the one under the pointer.
 *
 * Past the last pill this returns `lastVisible + 1` — *after that pill*, which
 * is not the same as "the end of the strip" when tabs are hidden beyond it. The
 * caret is where the caret is, and this function is deliberately never told how
 * many tabs exist.
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
 * A quarter of the width, **capped**. Proportional alone is wrong at both ends
 * of the range this app runs at: at the 179px-per-pane split measured on
 * 2026-08-20 a quarter is a usable 45px, but at 1200px it would turn half the
 * window into a split target and make dropping *into* a pane the hard gesture.
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
 * This is what makes a clipped drop position reachable at all: the strip only
 * slides its window for the *active* tab, so without it "move this to position 9
 * of 12" is not expressible. On a strip narrower than two bands the left one
 * wins, which is harmless — sliding left from the left end is already a no-op.
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
 * What rides on the drag: the tab's **identity**, and nothing else.
 *
 * Not its pane, not its index — `findTab` spans the workspace, so the drop can
 * look it up, and a pair of indices could go stale between `dragstart` and
 * `drop` (close a tab mid-drag and they point somewhere else). Not `preview`
 * either: `moveTab` pins from the tab it finds in the workspace, so a stale flag
 * on the wire could never contradict it.
 */
export function tabPayload(tab: Tab): string {
  return JSON.stringify(
    tab.kind === 'note'
      ? { kind: 'note', path: tab.path }
      : tab.kind === 'app'
        ? { kind: 'app', appId: tab.appId }
        : { kind: tab.kind },
  )
}

/**
 * Read a payload back, or null.
 *
 * The trust boundary. This string crossed a `DataTransfer`, which any drag
 * source on the machine can write to, so every field is checked and a fresh
 * narrow object is built per kind — returning the parsed value would let
 * whatever else was in the JSON ride into the workspace.
 */
export function parseTabPayload(text: string): Tab | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const { kind, path, appId } = value as Record<string, unknown>
  if (kind === 'note') {
    return typeof path === 'string' && path !== '' ? { kind: 'note', path } : null
  }
  if (kind === 'app') {
    return typeof appId === 'string' && appId !== '' ? { kind: 'app', appId } : null
  }
  if (kind === 'board' || kind === 'agenda' || kind === 'mail') return { kind }
  return null
}
