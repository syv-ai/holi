import { useEffect, useLayoutEffect, useRef } from 'react'
import { arrivalIndex, playOnce, prefersReducedMotion, staggerDelay } from './motion'

const EMPTY: ReadonlyMap<string, number> = new Map()

/** Shallow and order-sensitive: most renders hand us a new array of the same
 *  ids. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The arrive half of a keyed list: which rows are new, and how long each waits.
 * Give every row the returned props; rows already there get nothing, so
 * nothing replays on re-render.
 *
 * The previous list is committed in an effect, not during render: StrictMode
 * double-invokes render, and the second pass would compare the list against
 * itself, so nothing would ever animate in dev while tests passed.
 */
export function useArrivals(ids: readonly string[], variant = 'motion-in-fade') {
  const previous = useRef<readonly string[] | null>(null)
  const arrived = useRef<ReadonlyMap<string, number>>(EMPTY)

  // Recomputed only when the list changed: an unrelated re-render mid-arrival
  // would otherwise drop the class and cut the animation short. Leaving it on
  // afterwards replays nothing.
  if (previous.current === null) arrived.current = EMPTY
  else if (!sameIds(previous.current, ids)) arrived.current = arrivalIndex(previous.current, ids)

  useEffect(() => {
    previous.current = ids
  })

  return {
    /** Whether this row is arriving on this render. */
    isArriving: (id: string) => arrived.current.has(id),
    /** Spread onto the row. Empty for a row that was already there. */
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
 * Not `useArrivals`: React leaves an unchanged class string alone, so nothing
 * would replay. The identity triggers `playOnce` instead.
 *
 * `useLayoutEffect`: after paint, the new content would flash at full opacity
 * for a frame. The first identity is silent.
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
