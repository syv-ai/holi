/**
 * The springs the few JS-driven motions still use. A spring is physics rather
 * than one of the vocabulary's durations (`index.css`, Motion tier), so these
 * live here and not in CSS. Chrome (menus, dialogs, the board) moves only
 * through the CSS utilities; nothing new should reach for these.
 */

/** A surface springing to its size (the history panel's). */
export const spring = { type: 'spring', duration: 0.4, bounce: 0.24 } as const

/** A layout change settling: restrained, a hint of bounce and never a wobble. */
export const settle = { type: 'spring', duration: 0.4, bounce: 0.15 } as const

/** What reduced motion swaps in: the change, without the travel. */
export const instant = { duration: 0 } as const
