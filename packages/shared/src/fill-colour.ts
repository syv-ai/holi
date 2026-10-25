/**
 * The colour ramp for a percent-full reading, shared by the agent's context
 * reading and a vault's repo size. The two tokens live in the renderer's
 * `index.css`.
 */

/** Below this, a fill reading (a session's context, a repo's size) is muted. */
export const FILL_WARM_AT = 60
/** Where the ramp reaches full red. */
const FILL_FULL_AT = 99

/**
 * The colour of a percent-full reading, or null for its holder's own muted
 * text.
 *
 * From 60% it ramps smoothly from `--fill-warm` to `--fill-full`, mixed rather
 * than stepped so a reading that climbs a point at a time never jumps, and
 * late so a third full still reads as nothing to see. Text colour only, on no
 * background.
 */
export function fillColour(percent: number): string | null {
  if (percent < FILL_WARM_AT) return null
  const span = FILL_FULL_AT - FILL_WARM_AT
  const t = Math.round((Math.min(percent - FILL_WARM_AT, span) / span) * 100)
  return `color-mix(in oklab, var(--fill-full) ${t}%, var(--fill-warm))`
}
