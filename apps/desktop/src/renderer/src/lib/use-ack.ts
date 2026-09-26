import { useCallback, useEffect, useRef } from 'react'
import { prefersReducedMotion } from './motion'

/**
 * The four acknowledgement shapes, defined in `index.css` (K). `bloom` and
 * `flash` paint and survive reduced motion; `tick` and `nudge` move and do not.
 */
const VARIANTS = {
  bloom: { travels: false },
  tick: { travels: true },
  flash: { travels: false },
  nudge: { travels: true },
} as const

export type AckVariant = keyof typeof VARIANTS

const CLASSES = Object.keys(VARIANTS).map((v) => `motion-ack-${v}`)

/**
 * Acknowledge: one beat, once, for a discrete act the reader committed. A save
 * blooms, a commit ticks, a field write flashes, a failed push nudges the thing
 * that failed instead of opening a dialog.
 *
 * A hook, not a conditional class: replaying an animation needs a forced
 * reflow between remove and add, which a render cannot express, so a second
 * save in a row would be silent.
 *
 * `ack()` never blocks or queues; a second call interrupts the first.
 */
export function useAck<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  // Drop the listener at unmount so a detached node is not retained.
  useEffect(() => () => cleanup.current?.(), [])

  const ack = useCallback((variant: AckVariant) => {
    const node = ref.current
    if (node == null) return
    // Read at use: it only has to be right at the moment of the act.
    if (VARIANTS[variant].travels && prefersReducedMotion()) return

    cleanup.current?.()
    const className = `motion-ack-${variant}`

    node.classList.remove(...CLASSES)
    // Forced reflow, or remove and add coalesce and a repeated ack is silent.
    // Not a no-op; a setTimeout would replay a frame late.
    void node.offsetWidth
    node.classList.add(className)

    const done = (e: AnimationEvent) => {
      // `animationend` bubbles from animating descendants.
      if (e.target !== node) return
      node.classList.remove(className)
      node.removeEventListener('animationend', done)
      cleanup.current = null
    }
    node.addEventListener('animationend', done)
    cleanup.current = () => {
      node.classList.remove(className)
      node.removeEventListener('animationend', done)
      cleanup.current = null
    }
  }, [])

  return { ref, ack }
}
