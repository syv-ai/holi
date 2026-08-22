/**
 * Which tabs are out of reach, and on which side.
 *
 * The strip scrolls: every pill is laid out and a viewport moves over them, so
 * the question is no longer *which tabs survive a clip* (that was
 * `tab-window.ts`, and it is gone) but *what is currently off each edge*. Two
 * answers, not one — a single count cannot say which way your tab went, and a
 * strip that has scrolled has tabs on both sides of you.
 *
 * Pure, and tested on numbers: jsdom computes no layout, so a rendered strip
 * measures 0×0 and could not check any of this. Same split `tab-drop.ts` makes.
 */

/** A laid-out pill, in the scroll container's **content** coordinates — i.e.
 *  `offsetLeft`/`offsetWidth`, which do not move when the strip is scrolled. */
export interface PillSpan {
  left: number
  width: number
}

/** Absolute tab indices off each edge, in tab order. */
export interface Offscreen {
  left: number[]
  right: number[]
}

/** Slack for fractional layout. Real pill widths are not integers, and a pill
 *  ending a third of a pixel past the edge is visible, not missing. */
const EPSILON = 1

/**
 * The tabs you cannot fully read at this scroll position.
 *
 * **Partly visible counts as offscreen.** The count exists to answer "is there
 * more that way, and how much", and half a filename answers neither — so a pill
 * the viewport cuts is listed, and clicking it in the menu is what brings it
 * fully into view. A pill clipped at *both* edges (wider than the viewport) is
 * reported on the left, since that is the direction its start lies in.
 *
 * An unmeasured strip (`viewport <= 0`, before the first ResizeObserver
 * callback) reports nothing. The alternative is a count that flashes on mount
 * saying every tab is missing.
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
