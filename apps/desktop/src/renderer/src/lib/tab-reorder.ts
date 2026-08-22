/**
 * Where every pill would sit if the drag ended now.
 *
 * The strip previews a reorder while you aim it: the pills between the dragged
 * tab's own slot and the one under the pointer slide aside, and the hole that
 * opens is where it will land. A caret line says *where*; a hole says *what it
 * will look like*, which is the same thing the drop is about to do.
 *
 * Offsets rather than a rearranged list, because the preview must not touch
 * layout. A `translateX` moves nothing else: the pills keep their real widths
 * and positions, so the midpoints a drop is decided against stay exactly where
 * they were and the hole cannot chase the pointer that opened it.
 *
 * Pure, and tested on numbers — jsdom computes no layout, so a rendered strip
 * measures 0×0. Same split as `tab-drop.ts` and `tab-overflow.ts`.
 */

/**
 * The x-offset each pill needs to preview moving `from` to before `to`.
 *
 * `to` is the index a drop would insert **before**, in the *current* array —
 * `dropIndex`'s convention, so one number drives both the preview and the drop.
 * Both are absolute tab indices; `to === widths.length` means "past the end".
 *
 * Returns all zeros when there is nothing to preview: a `from` outside the strip
 * (the drag began in another pane, and there is no slot here to move out of), or
 * a `to` outside it. A move that lands the tab back in its own slot — `to` of
 * `from` or of `from + 1`, both of which mean "leave it where it is" — falls out
 * of the arithmetic as zeros, so there is no special case for it to disagree
 * with. It must open no hole, and it does not.
 *
 * **The preview stays inside the strip's resting extent.** Only the tabs between
 * the two slots move: each steps back by the dragged pill's width plus one gap,
 * and the dragged pill covers the distance they gave back. So the strip is never
 * wider mid-drag than at rest and no preview can push a pill out of the scroll
 * viewport it is being aimed inside. (The offsets do *not* sum to zero — that
 * holds only when every pill is the same width.)
 */
/** A width that is safe to add up. `offsetWidth` is always a number, but a hole
 *  in the array — a pill whose element has not been seen yet — must count as
 *  nothing rather than poison every offset after it with `NaN`. */
function widthAt(widths: number[], index: number): number {
  const w = widths[index]
  return w === undefined || !Number.isFinite(w) ? 0 : w
}

export function reorderOffsets(widths: number[], from: number, to: number, gap: number): number[] {
  const n = widths.length
  const zeros = new Array<number>(n).fill(0)
  if (n === 0) return zeros
  if (from < 0 || from >= n || to < 0 || to > n) return zeros

  // Resting positions: each pill starts after everything before it, plus a gap.
  const restingAt: number[] = []
  let x = 0
  for (let i = 0; i < n; i++) {
    restingAt.push(x)
    x += widthAt(widths, i) + gap
  }

  // The order a drop would produce, and where each pill sits in it.
  const order = [...Array(n).keys()]
  order.splice(from, 1)
  order.splice(to > from ? to - 1 : to, 0, from)

  const offsets = zeros.slice()
  let cursor = 0
  for (const index of order) {
    offsets[index] = cursor - (restingAt[index] ?? 0)
    cursor += widthAt(widths, index) + gap
  }
  return offsets
}
