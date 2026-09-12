/**
 * The JavaScript half of the app's motion vocabulary.
 *
 * The vocabulary itself is CSS — `index.css` §Motion tier, four behaviours
 * (respond / arrive / acknowledge / in flight) and the `motion-*` utilities.
 * Nothing here restates a duration or a curve; this module exists only for the
 * two things CSS cannot express on its own.
 *
 * Design of record: `docs/specs/2026-09-12-motion-system-design.md` (D97).
 */

/**
 * How many items a staggered list ramps over before everything else arrives
 * together.
 *
 * A stagger is a nice touch on a folder with six children and a disaster on one
 * with two hundred: at 45ms a step, an uncapped ramp would take nine seconds to
 * finish opening, during which the tree is unusable. Past the cap every
 * remaining item shares the last delay, so a long list still reads as "these
 * arrived in order" without anybody waiting for it.
 */
export const MOTION_STAGGER_CAP = 8

/**
 * The `animation-delay` for the nth item of a staggered list.
 *
 * **Returns a CSS `calc()` string, not a number of milliseconds, and that is the
 * point.** The step stays inside `--motion-stagger`, so re-pacing the app is an
 * edit to `index.css` and nothing else — resolving it here would copy the number
 * into every call site, which is the failure this whole system replaces. It also
 * means the value a component hands to `animationDelay` is a call rather than a
 * literal, which is exactly what the renderer's motion lint rule permits.
 *
 * Note `--motion-stagger` is declared in a plain `:root` rule rather than in
 * `@theme`: Tailwind tree-shakes theme variables it cannot see referenced, and
 * this string is built at runtime. `index.css` carries the full explanation.
 */
export function staggerDelay(
  index: number,
  opts: { reduced?: boolean; cap?: number } = {},
): string {
  const { reduced = false, cap = MOTION_STAGGER_CAP } = opts
  // Under reduced motion the ramp flattens rather than shortening: a staggered
  // arrival is travel, and travel is the half of motion the setting is for.
  if (reduced) return '0ms'
  // Floor rather than trust: a caller mapping over a list can hand us a
  // fractional or NaN index, and a negative delay reads to a browser as an
  // animation that is already part-played.
  const step = Number.isFinite(index) ? Math.min(Math.floor(index), cap) : 0
  if (step <= 0) return '0ms'
  return `calc(var(--motion-stagger) * ${step})`
}

/**
 * Whether this machine asks for reduced motion, for code that is not a React
 * component. Components use `useReducedMotion`, which re-renders when it
 * changes; this is the one-shot read for module-level and event-handler code.
 *
 * Guarded, because `matchMedia` is absent in jsdom and in the plain-Node test
 * environment, and this is imported by editor code that runs in both.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}
