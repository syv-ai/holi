/**
 * The JavaScript half of the app's motion vocabulary. The vocabulary itself is
 * CSS (`index.css`, Motion tier); nothing here restates a duration or a curve.
 * See `docs/ui-system.md` (D98).
 */

/**
 * How many items a staggered list ramps over before everything else arrives
 * together.
 *
 * Uncapped, two hundred children would take nine seconds to open. Past the cap
 * every item shares the last delay.
 */
export const MOTION_STAGGER_CAP = 8

/**
 * The `animation-delay` for the nth item of a staggered list.
 *
 * A CSS `calc()` string, not milliseconds, so the step stays in
 * `--motion-stagger` and re-pacing is an `index.css` edit. It is also a call
 * rather than a literal, which the renderer's motion lint rule permits.
 *
 * `--motion-stagger` lives in a plain `:root` rule, not `@theme`, since
 * Tailwind cannot see this runtime string (see `index.css`).
 */
export function staggerDelay(
  index: number,
  opts: { reduced?: boolean; cap?: number } = {},
): string {
  const { reduced = false, cap = MOTION_STAGGER_CAP } = opts
  // Reduced motion flattens the ramp: a staggered arrival is travel.
  if (reduced) return '0ms'
  // A negative delay would read as an animation already part-played.
  const step = Number.isFinite(index) ? Math.min(Math.floor(index), cap) : 0
  if (step <= 0) return '0ms'
  return `calc(var(--motion-stagger) * ${step})`
}

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

/**
 * Which ids in a keyed list have just appeared, and in what order.
 *
 * The gate for an arrival: an `animation` on a list's children would replay on
 * every re-render (D92), so a row animates because it is new, a fact about two
 * renders.
 *
 * The first render returns nothing: a mount is the shell's arrival to make.
 * Only ids absent before and present now count. Pair with `staggerDelay`.
 */
export function arrivalIndex(
  prev: readonly string[] | null,
  next: readonly string[],
): Map<string, number> {
  const arrived = new Map<string, number>()
  if (prev === null) return arrived
  const before = new Set(prev)
  for (const id of next) {
    if (!before.has(id)) arrived.set(id, arrived.size)
  }
  return arrived
}

/**
 * A duration token, in the milliseconds a `setTimeout` or the Web Animations
 * API takes.
 *
 * Read off the document per use, so the token stays the single source. The
 * fallback is for jsdom and plain Node; keep it equal to the token in
 * index.css.
 */
export function motionDurationMs(token: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token)
  const ms = Number.parseFloat(raw)
  return Number.isFinite(ms) ? ms : fallback
}

/**
 * Play a one-shot animation class on an element, now, restarting it if it is
 * already running. Returns a cleanup for the listener.
 *
 * The forced reflow is not a no-op: removing and re-adding a class in one tick
 * coalesces into no change, so the animation would not restart. Do not
 * replace it with a `setTimeout`, which replays a frame late.
 *
 * The listener checks its target because `animationend` bubbles.
 */
export function playOnce(el: HTMLElement, className: string): () => void {
  el.classList.remove(className)
  void el.offsetWidth
  el.classList.add(className)

  const done = (e: AnimationEvent): void => {
    if (e.target !== el) return
    el.classList.remove(className)
    el.removeEventListener('animationend', done)
  }
  el.addEventListener('animationend', done)
  return () => el.removeEventListener('animationend', done)
}
