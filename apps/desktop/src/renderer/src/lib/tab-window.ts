/**
 * Which tabs the strip can show, and how many it must hide.
 *
 * The strip was a bare flex row: open more tabs than fit between the sidebars
 * and the row simply kept growing, pushing the editor pane wider than the
 * window. Nothing clipped it and nothing counted what had gone.
 *
 * Clipping is a stylesheet's job. **Which** tabs survive the clip is a decision,
 * and it is this — pure, so it is tested against numbers rather than against a
 * rendered strip whose widths depend on a font that may not have loaded.
 */

/** A half-open range `[start, end)` into the pane's tabs, plus what it costs. */
export interface TabWindow {
  start: number
  end: number
  /** Tabs before `start` and after `end` — what the "+N" control announces. */
  hidden: number
}

export interface TabWindowInput {
  /** Rendered pill widths, in tab order. */
  widths: number[]
  /** Horizontal space the strip may use, in px. */
  available: number
  /** The active tab's index, or -1 for an empty pane. */
  active: number
  /** Space the "+N" control needs, counted only when something is hidden. */
  overflowWidth: number
  /** Gap between pills (the strip's `gap-1`), counted between them only. */
  gap: number
}

/** Total width of `widths[from..to)` including the gaps between them. A tab that
 *  has not been measured yet counts as zero — `?? 0` alone would let a NaN
 *  through and poison every comparison downstream, which fails closed in the
 *  ugliest way: nothing fits, so the strip shows one tab. */
function span(widths: number[], from: number, to: number, gap: number): number {
  let total = 0
  for (let i = from; i < to; i++) {
    const w = widths[i]
    total += w === undefined || !Number.isFinite(w) ? 0 : w
  }
  const count = Math.max(0, to - from)
  return total + Math.max(0, count - 1) * gap
}

/**
 * The widest run of tabs that fits, containing the active one.
 *
 * Three rules, in order:
 *
 *  1. **If everything fits, everything shows** — and no space is reserved for a
 *     control that will not be drawn. This is the common case and it must cost
 *     nothing.
 *  2. **Fill from the left.** Tabs are ordered, and the order is the user's
 *     history of opening them; reading it from the middle would be strange.
 *  3. **The active tab always survives.** Only when it falls outside the
 *     left-anchored run does the window slide right, dropping the leftmost tabs
 *     — the same thing a scrolling strip does, without the scrolling. Otherwise
 *     the pane would render a document whose tab is nowhere on screen, which
 *     reads as a bug in the editor rather than a full strip.
 *
 * At least one tab is always returned, even if it does not fit: a strip that
 * clips a tab is legible, and a strip that is empty while a document is open is
 * not.
 */
export function tabWindow({
  widths,
  available,
  active,
  overflowWidth,
  gap,
}: TabWindowInput): TabWindow {
  const n = widths.length
  if (n === 0) return { start: 0, end: 0, hidden: 0 }

  // 1. Everything fits, with nothing reserved for the control.
  if (span(widths, 0, n, gap) <= available) return { start: 0, end: n, hidden: 0 }

  // Something will be hidden, so the control is drawn and costs its width.
  const room = available - overflowWidth - gap

  // 2. Fill from the left.
  let end = 0
  while (end < n && span(widths, 0, end + 1, gap) <= room) end++
  let start = 0

  // 3. Slide right until the active tab is inside. `end` moves first (the active
  //    tab becomes the last visible one), then `start` follows to make it fit.
  if (active >= end) {
    end = active + 1
    start = end - 1
    while (start > 0 && span(widths, start - 1, end, gap) <= room) start--
  }

  // A run of one, when even that overflows. `end` can still be 0 here — a single
  // tab wider than the whole strip — so take the active one, or the first.
  if (end <= start) {
    start = active >= 0 ? active : 0
    end = start + 1
  }

  return { start, end, hidden: n - (end - start) }
}
