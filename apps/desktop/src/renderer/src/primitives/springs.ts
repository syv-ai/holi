/**
 * The morph's character, shared by the surfaces that morph: the nav menu
 * (`MorphingMenu`) and the command palette (`CommandDialog`). A spring is
 * physics rather than one of the vocabulary's durations (`index.css`, Motion
 * tier), so these live here and not in CSS. Tune here; both follow.
 *
 * The shape: the surface squeezes to a pill (`compress`), then springs to its
 * size with a little bounce (`spring`), while its rows cascade in from below,
 * blurred (`rowFrom`, `rowArrive`). Leaving rows drop a little and blur
 * (`rowLeave`), faster than they came.
 */
import type { Transition } from 'motion/react'

export const spring = { type: 'spring', duration: 0.4, bounce: 0.24 } as const

export const compress = { duration: 0.1, ease: [0.4, 0, 0.2, 1] } as const

/** The pill a surface squeezes to, across its thin axis, in px. */
export const PILL = 28

/** Where an arriving row starts, as inline style: set before the spring. */
export const rowFrom = { opacity: '0', transform: 'translateY(48px)', filter: 'blur(4px)' }

/** Where an arriving row lands. */
export const rowAt = { opacity: 1, y: 0, filter: 'blur(0px)' }

/** The nth arriving row's spring: `after` the surface has made room (by
 *  default, the squeeze), one step behind the last. */
export const rowArrive = (index: number, after = 0.2) =>
  ({ ...spring, bounce: 0.3, delay: after + index * 0.02 }) as const

/** Where a leaving row goes, and how fast. */
export const rowGone = { opacity: 0, y: 16, filter: 'blur(2px)' }
export const rowLeave = { ...spring, duration: 0.12, bounce: 0 } as const

/** `rowFrom` in motion's own keys, for a declarative `initial`. The raw
 *  `transform` string above is for the imperative `animate()` the morphs
 *  run; given to `initial`, `y` never overrides it and the row stays 48px
 *  low. */
export const rowFromMotion = { opacity: 0, y: 48, filter: 'blur(4px)' }

/**
 * The board's spring (`docs/ui-system.md`, Motion): a card taking its new
 * place, a gap opening under a drag, a lane group opening, a card landing.
 * Restrained on purpose: it settles with a hint of bounce and never wobbles,
 * because these run all day, not once per menu.
 */
export const settle = { type: 'spring', duration: 0.4, bounce: 0.15 } as const

/** How a count rolls to its new value. */
export const roll = { type: 'spring', duration: 0.35, bounce: 0.18 } as const

/**
 * Completing a task, ported from rare-ui's task list: the ring fills and
 * pops, the tick draws, the strike runs across the title, then the row gives a
 * small sideways flick. Each beat's end starts the next (`TaskCheck`,
 * `StrikeText`, the board's sequence).
 */
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]
const EASE_IN_OUT: [number, number, number, number] = [0.65, 0, 0.35, 1]
export const check: Record<'fill' | 'pop' | 'tick' | 'strike' | 'nudge', Transition> & {
  popScale: number[]
  nudgeX: number[]
} = {
  fill: { duration: 0.24, ease: EASE_OUT },
  pop: { duration: 0.34, ease: EASE_OUT, times: [0, 0.4, 1] },
  popScale: [1, 1.12, 1],
  tick: { duration: 0.22, ease: EASE_OUT, delay: 0.06 },
  strike: { duration: 0.38, ease: EASE_IN_OUT },
  nudge: { duration: 0.3, ease: EASE_OUT, times: [0, 0.35, 0.7, 1] },
  nudgeX: [0, 6, -2, 0],
}

/** What reduced motion swaps in: the change, without the travel. */
export const instant = { duration: 0 } as const
