/**
 * The JavaScript half of the app's motion vocabulary.
 *
 * The vocabulary itself is CSS — `index.css` §Motion tier, four behaviours
 * (respond / arrive / acknowledge / in flight) and the `motion-*` utilities.
 * Nothing here restates a duration or a curve; this module exists only for the
 * two things CSS cannot express on its own.
 *
 * Design of record: `docs/specs/2026-09-12-motion-system-design.md` (D98).
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

/**
 * Which ids in a keyed list have just appeared, and in what order.
 *
 * **An arrival needs a gate, and this is it.** An `animation` declared on a
 * list's children replays every time the list re-renders, for any reason — the
 * same shape as the bug D92 hit, where every heading in a file animated its
 * marks shut the moment the file opened. So a row animates because it is new,
 * which is a fact about two renders, rather than because it exists, which is a
 * fact about one.
 *
 * The first render returns nothing on purpose. A tree appearing because the app
 * started, or because the vault switched, is the shell's arrival to make; two
 * hundred rows coming in one after another on every mount is noise rather than
 * life.
 *
 * Reordering is not arriving, and neither is removal: only ids absent before
 * and present now count. Pair the returned ordinal with `staggerDelay`.
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
 * Code that must WAIT for an animation needs the number, and CSS cannot hand it
 * over — so it is read off the document rather than restated, and the token
 * stays the single place the value lives. Read per use rather than cached: a
 * theme that ever moves these must not leave a stale copy behind.
 *
 * The fallback is only for the environments with no computed style at all
 * (jsdom, plain Node). Keep it equal to the token's value in index.css, or a
 * missing token silently reinstates a pace nobody chose.
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
 * The remove / force-reflow / add dance is the whole of it, and it is not
 * decoration: removing and re-adding a class in one tick does NOT restart a CSS
 * animation, because the browser coalesces the two mutations into no change at
 * all. Reading a layout property in the gap is what separates them. It looks
 * like a no-op and is not; do not replace it with a `setTimeout`, which would
 * put the replay a frame late instead of now.
 *
 * The listener checks its target because `animationend` bubbles, and these
 * classes land on containers full of other animating things.
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
