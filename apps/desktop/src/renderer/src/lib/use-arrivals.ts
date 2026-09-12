import { useEffect, useRef } from 'react'
import { arrivalIndex, prefersReducedMotion, staggerDelay } from './motion'

/**
 * The arrive half of a keyed list: which rows are new, and how long each waits.
 *
 * Call it with the ids in render order and give every row the returned props.
 * Rows that were already there get nothing at all, which is the point — an
 * animation declared on the children replays on every re-render, and this makes
 * arriving a fact about two renders rather than about existing.
 *
 * **The previous list is committed in an effect, not written during render, and
 * that is not a style preference.** This app runs under `React.StrictMode`,
 * which double-invokes render in development: updating the ref during render
 * means the second pass compares the new list against itself, finds nothing
 * new, and React keeps that second result — so nothing would ever animate in
 * the dev app while the tests passed. Assigning after commit makes both passes
 * read the same previous list and agree. The ref therefore holds the last
 * COMMITTED list, which is exactly what "has this row just appeared" means.
 */
export function useArrivals(ids: readonly string[]) {
  const previous = useRef<readonly string[] | null>(null)
  const arrived = arrivalIndex(previous.current, ids)
  useEffect(() => {
    previous.current = ids
  })

  return {
    /** Whether this row is arriving on this render. */
    isArriving: (id: string) => arrived.has(id),
    /**
     * Spread onto the row. Empty for a row that was already there, so nothing
     * is written to the DOM and there is no animation to restart.
     */
    arrivalProps: (id: string): { className?: string; style?: { animationDelay: string } } => {
      const index = arrived.get(id)
      if (index === undefined) return {}
      return {
        className: 'motion-in-top',
        style: { animationDelay: staggerDelay(index, { reduced: prefersReducedMotion() }) },
      }
    },
  }
}
