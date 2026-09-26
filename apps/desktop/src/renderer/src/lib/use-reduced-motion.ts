import { useCallback, useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Whether this machine asks for reduced motion, as a value a component
 * re-renders on.
 *
 * Reduce, not remove: the CSS half is in `index.css`. This hook covers what
 * CSS cannot reach (a JS stagger, a WAAPI keyframe, an awaited exit), and
 * follows the OS setting live. Non-component code uses `prefersReducedMotion()`.
 */
export function useReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    // `matchMedia` is absent in jsdom and plain Node: no preference.
    const mql = globalThis.matchMedia?.(QUERY)
    if (mql == null) return () => {}
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(QUERY).matches === true,
    // Server snapshot, required though Electron never server-renders.
    () => false,
  )
}
