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

export const spring = { type: 'spring', duration: 0.4, bounce: 0.24 } as const

export const compress = { duration: 0.1, ease: [0.4, 0, 0.2, 1] } as const

/** The pill a surface squeezes to, across its thin axis, in px. */
export const PILL = 28

/** Where an arriving row starts, as inline style: set before the spring. */
export const rowFrom = { opacity: '0', transform: 'translateY(48px)', filter: 'blur(4px)' }

/** Where an arriving row lands. */
export const rowAt = { opacity: 1, y: 0, filter: 'blur(0px)' }

/** The nth arriving row's spring: after the squeeze, one step behind the last. */
export const rowArrive = (index: number) =>
  ({ ...spring, bounce: 0.3, delay: 0.2 + index * 0.02 }) as const

/** Where a leaving row goes, and how fast. */
export const rowGone = { opacity: 0, y: 16, filter: 'blur(2px)' }
export const rowLeave = { ...spring, duration: 0.12, bounce: 0 } as const
