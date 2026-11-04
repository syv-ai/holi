/**
 * The JavaScript half of the app's motion vocabulary. The vocabulary itself is
 * CSS (`index.css`, Motion tier); nothing here restates a duration or a curve.
 * See `docs/ui-system.md`.
 */

/**
 * A one-shot reduced-motion read for non-component code; components use
 * `useReducedMotion`. Guarded: `matchMedia` is absent in jsdom and plain Node.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}
