/**
 * The one loop behind every mounted orb (AgentFace): a single pointer
 * listener and a single animation frame, however many faces are on screen.
 * Each frame, per orb, the eyes look at the pointer, the features and the head
 * lean towards it, and the body breathes. Everything here is computed and
 * written as a transform, so none of it is a CSS transition or a literal at a
 * call site; the numbers are this file's constants, as `springs.ts` holds the
 * springs.
 *
 * Reduced motion keeps a static gaze: no tracking, no breathing, no blinking.
 */

/** Fractions of the orb's diameter, and the pointer distance (px) at which a
 *  look reaches its full reach. */
const EYE_REACH = 0.045
const EYE_FULL_AT = 220
const FEATURE_REACH = 0.035
const FEATURE_FULL_AT = 260
const TILT_DEGREES = 6
const TILT_FULL_AT = 320
/** The share of the way to the target covered each frame. */
const EYE_EASE = 0.22
const FEATURE_EASE = 0.14
const TILT_EASE = 0.08
const BREATH = 0.012
const BREATH_RATE = 1.7
const BREATH_PHASE = 1.3
/** Where a working orb looks, in units of the eye reach: up and to the right. */
const WORKING_GAZE: readonly [number, number] = [0.7, -0.9]

/** How long a blink holds, and the random wait before the next one (ms). */
export const BLINK_HOLD_MS = 110
export const BLINK_GAP_MS: readonly [number, number] = [2500, 6000]
/** One blink in five is followed, this long after, by a second. */
export const DOUBLE_BLINK_CHANCE = 0.2
export const DOUBLE_BLINK_AFTER_MS = 260

export interface OrbHandle {
  root: HTMLElement
  head: HTMLElement
  feat: HTMLElement
  pupils: readonly HTMLElement[]
}

interface Tracked extends OrbHandle {
  index: number
  rot: number
  fx: number
  fy: number
  eyes: { x: number; y: number }[]
}

const orbs = new Set<Tracked>()
let pointer: { x: number; y: number } | null = null
let frame = 0
let counter = 0

const reduced = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

function onMove(event: PointerEvent): void {
  pointer = { x: event.clientX, y: event.clientY }
}
function onLeave(): void {
  pointer = null
}

function step(now: number): void {
  const still = reduced()
  const t = now / 1000
  for (const orb of orbs) {
    const rect = orb.root.getBoundingClientRect()
    const d = rect.width
    const track = pointer !== null && !still
    const dx = track ? pointer!.x - (rect.left + d / 2) : 0
    const dy = track ? pointer!.y - (rect.top + d / 2) : 0
    const dist = Math.hypot(dx, dy) || 1

    const tilt = track ? clamp(dx / TILT_FULL_AT, -1, 1) * TILT_DEGREES : 0
    orb.rot += (tilt - orb.rot) * TILT_EASE
    const b = still ? 0 : Math.sin(t * BREATH_RATE + orb.index * BREATH_PHASE) * BREATH
    orb.head.style.transform = `rotate(${orb.rot}deg) scale(${1 - b * 0.4},${1 + b})`

    const k = Math.min(1, dist / FEATURE_FULL_AT)
    const fx = track ? (dx / dist) * FEATURE_REACH * d * k : 0
    const fy = track ? (dy / dist) * FEATURE_REACH * d * k : 0
    orb.fx += (fx - orb.fx) * FEATURE_EASE
    orb.fy += (fy - orb.fy) * FEATURE_EASE
    orb.feat.style.transform = `translate(${orb.fx}px,${orb.fy}px)`

    const working = orb.root.dataset.mood === 'working'
    orb.pupils.forEach((pupil, i) => {
      const eye = orb.eyes[i]!
      let tx = 0
      let ty = 0
      if (working) {
        tx = WORKING_GAZE[0] * EYE_REACH * d
        ty = WORKING_GAZE[1] * EYE_REACH * d
      } else if (track) {
        const box = pupil.parentElement!.getBoundingClientRect()
        const ex = pointer!.x - (box.left + box.width / 2)
        const ey = pointer!.y - (box.top + box.height / 2)
        const ed = Math.hypot(ex, ey) || 1
        const ek = Math.min(1, ed / EYE_FULL_AT)
        tx = (ex / ed) * EYE_REACH * d * ek
        ty = (ey / ed) * EYE_REACH * d * ek
      }
      eye.x += (tx - eye.x) * EYE_EASE
      eye.y += (ty - eye.y) * EYE_EASE
      pupil.style.transform = `translate(${eye.x}px,${eye.y}px)`
    })
  }
  frame = requestAnimationFrame(step)
}

/** Start driving an orb. Returns the way to stop. */
export function trackOrb(handle: OrbHandle): () => void {
  const orb: Tracked = {
    ...handle,
    index: counter++,
    rot: 0,
    fx: 0,
    fy: 0,
    eyes: handle.pupils.map(() => ({ x: 0, y: 0 })),
  }
  if (orbs.size === 0) {
    window.addEventListener('pointermove', onMove)
    document.documentElement.addEventListener('pointerleave', onLeave)
    frame = requestAnimationFrame(step)
  }
  orbs.add(orb)
  return () => {
    orbs.delete(orb)
    if (orbs.size > 0) return
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    document.documentElement.removeEventListener('pointerleave', onLeave)
    pointer = null
  }
}

/** Whether blinking is off for this machine. */
export const blinkingOff = reduced
