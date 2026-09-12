import { useCallback, useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Whether this machine asks for reduced motion, as a value a component
 * re-renders on.
 *
 * **Reduce, not remove.** The CSS half of this lives beside the vocabulary in
 * `index.css`: looping motion stops dead, arrivals become instant, and respond
 * plus the painting half of acknowledge survive. The setting is for vestibular
 * discomfort rather than taste, so blanking colour and opacity would make the
 * app worse for someone who never asked for that. This hook exists for the
 * cases CSS cannot reach on its own — a stagger delay computed in JavaScript,
 * a WAAPI keyframe, an exit the code must wait for.
 *
 * **A hook rather than a one-shot read** because the OS setting can change while
 * the app is running, and the window should follow it without a reload. Code
 * outside a component uses `prefersReducedMotion()` in `lib/motion.ts`.
 */
export function useReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    // `matchMedia` is absent in jsdom and in plain Node, and this module is
    // reachable from editor code that runs in both. Absent reads as "no
    // preference"; there is simply nothing to subscribe to.
    const mql = globalThis.matchMedia?.(QUERY)
    if (mql == null) return () => {}
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(QUERY).matches === true,
    // Server snapshot: Electron never server-renders, but useSyncExternalStore
    // wants one, and "no preference" is the honest answer with no window.
    () => false,
  )
}
