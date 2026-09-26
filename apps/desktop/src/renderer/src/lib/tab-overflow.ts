/**
 * Which tabs are out of reach, and on which side.
 *
 * One answer per side: a single count cannot say which way your tab went. Pure,
 * because jsdom computes no layout.
 */

/** A laid-out pill, in the scroller's content coordinates (`offsetLeft`), which
 *  do not move when the strip scrolls. */
export interface PillSpan {
  left: number
  width: number
}

/** Absolute tab indices off each edge, in tab order. */
export interface Offscreen {
  left: number[]
  right: number[]
}

/** Slack for fractional layout: a third of a pixel past the edge is visible. */
const EPSILON = 1

/**
 * The tabs you cannot fully read at this scroll position.
 *
 * Partly visible counts as offscreen: half a filename is not readable, and the
 * menu brings it into view. A pill clipped at both edges is reported left.
 *
 * An unmeasured strip (`viewport <= 0`) reports nothing, or every tab would
 * flash as missing on mount.
 */
export function offscreenTabs(pills: PillSpan[], scrollLeft: number, viewport: number): Offscreen {
  const left: number[] = []
  const right: number[] = []
  if (!Number.isFinite(scrollLeft) || !Number.isFinite(viewport) || viewport <= 0) {
    return { left, right }
  }

  const end = scrollLeft + viewport
  pills.forEach((pill, index) => {
    if (pill.left < scrollLeft - EPSILON) left.push(index)
    else if (pill.left + pill.width > end + EPSILON) right.push(index)
  })
  return { left, right }
}
