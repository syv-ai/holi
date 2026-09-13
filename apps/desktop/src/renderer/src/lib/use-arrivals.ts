import { useEffect, useLayoutEffect, useRef } from 'react'
import { arrivalIndex, playOnce, prefersReducedMotion, staggerDelay } from './motion'

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
const EMPTY: ReadonlyMap<string, number> = new Map()

/** Shallow, order-sensitive: a reorder is not an arrival, and neither is a new
 *  array holding the same ids, which React hands us on most renders. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function useArrivals(ids: readonly string[], variant = 'motion-in-row') {
  const previous = useRef<readonly string[] | null>(null)
  const arrived = useRef<ReadonlyMap<string, number>>(EMPTY)

  // **Recomputed only when the list actually changed.** Deriving the map fresh
  // on every render looks equivalent and is not: an unrelated re-render during
  // the 300ms an arrival takes would find nothing new, drop the class off a row
  // mid-animation, and cut it short. Holding the last map until the list moves
  // again means the class survives for as long as the animation needs it, and
  // leaving it on afterwards is harmless — a class that is already there is not
  // re-added, so nothing replays.
  if (previous.current === null) arrived.current = EMPTY
  else if (!sameIds(previous.current, ids)) arrived.current = arrivalIndex(previous.current, ids)

  useEffect(() => {
    previous.current = ids
  })

  return {
    /** Whether this row is arriving on this render. */
    isArriving: (id: string) => arrived.current.has(id),
    /**
     * Spread onto the row. Empty for a row that was already there, so nothing
     * is written to the DOM and there is no animation to restart.
     */
    arrivalProps: (id: string): { className?: string; style?: { animationDelay: string } } => {
      const index = arrived.current.get(id)
      if (index === undefined) return {}
      return {
        className: variant,
        style: { animationDelay: staggerDelay(index, { reduced: prefersReducedMotion() }) },
      }
    },
  }
}

/**
 * Arrive on a swap: replay an entrance whenever the thing being shown CHANGES
 * identity, without remounting it.
 *
 * `useArrivals` cannot do this job. It decides a class during render, and React
 * does not touch an attribute whose value has not changed — so navigating from
 * one note to a second and then a third would write the same class string every
 * time and the browser would replay nothing. Here the identity is the trigger,
 * so the class is removed, a reflow is forced, and it is added again, the same
 * way `useAck` replays a beat.
 *
 * **`useLayoutEffect`, not `useEffect`**, and it is load-bearing: an effect runs
 * after paint, so the new document would show at full opacity for one frame and
 * only then fade up from nothing. That reads as a flicker, which is the opposite
 * of the point.
 *
 * The first identity is deliberately silent — a pane showing its first document
 * has not navigated anywhere.
 */
export function useArrivalOnChange<T extends HTMLElement>(
  key: string,
  variant = 'motion-in-fade',
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const last = useRef<string | null>(null)

  useLayoutEffect(() => {
    const node = ref.current
    const previousKey = last.current
    last.current = key
    if (node === null || previousKey === null || previousKey === key) return

    return playOnce(node, variant)
  }, [key, variant])

  return ref
}
