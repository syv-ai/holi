/**
 * Where every pill would sit if the drag ended now.
 *
 * Offsets rather than a rearranged list: a `translateX` preview leaves layout,
 * and so the drop midpoints, untouched. Pure, since jsdom has no layout.
 */

/** A width safe to add up: a missing pill counts as 0, not `NaN`. */
function widthAt(widths: number[], index: number): number {
  const w = widths[index]
  return w === undefined || !Number.isFinite(w) ? 0 : w
}

/**
 * The x-offset each pill needs to preview moving `from` to before `to`.
 *
 * `to` follows `dropIndex`'s convention (insert before, in the current array;
 * `widths.length` is past the end), so one number drives preview and drop.
 * All zeros when `from` or `to` is outside the strip; a move back into its own
 * slot also comes out as zeros.
 *
 * Only the tabs between the slots move, so the strip is never wider mid-drag
 * than at rest.
 */
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
