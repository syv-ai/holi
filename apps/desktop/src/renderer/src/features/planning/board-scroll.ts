export type BoardScrollPosition = { top: number; left: number }

/** Read and restore the board's two-axis scroll position at its viewport seam. */
export function captureBoardScroll(viewport: Pick<HTMLElement, 'scrollTop' | 'scrollLeft'>) {
  return { top: viewport.scrollTop, left: viewport.scrollLeft }
}

export function restoreBoardScroll(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollLeft'>,
  position: BoardScrollPosition,
) {
  viewport.scrollTop = position.top
  viewport.scrollLeft = position.left
}
