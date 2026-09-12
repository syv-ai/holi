import { useCallback, useEffect, useRef } from 'react'
import { prefersReducedMotion } from './motion'

/**
 * The four shapes an acknowledgement takes. Every one is defined in
 * `index.css` §K; nothing here restates a duration or a curve.
 *
 * The split is not cosmetic. `bloom` and `flash` PAINT — a ring, a tint — and
 * survive reduced motion, because the setting is about movement rather than
 * about colour. `tick` and `nudge` MOVE, and do not.
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
 * **Why this is a hook and not `className={done && 'motion-ack-bloom'}`.**
 * Removing and re-adding a class in the same tick does not replay a CSS
 * animation — the browser coalesces the two mutations and nothing happens — so
 * a second save in a row would be silent, which is exactly when you most want
 * the feedback. Replaying needs a forced reflow in the gap, and that is not
 * something a render can express.
 *
 * `ack()` never blocks, never queues and never awaits. It is feedback about
 * something that has already happened; a second call interrupts the first
 * rather than lining up behind it.
 */
export function useAck<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  // A node mid-animation at unmount still has a listener on it. Dropping it
  // here keeps the hook from being the reason a detached node is retained.
  useEffect(() => () => cleanup.current?.(), [])

  const ack = useCallback((variant: AckVariant) => {
    const node = ref.current
    // Called from an effect or an event that beat the ref, or on a node that
    // has gone. Nothing to acknowledge on, and nothing worth throwing over.
    if (node == null) return
    // Read at use rather than subscribed: this runs inside an event, and the
    // answer only has to be right at the moment of the act.
    if (VARIANTS[variant].travels && prefersReducedMotion()) return

    cleanup.current?.()
    const className = `motion-ack-${variant}`

    node.classList.remove(...CLASSES)
    // Force a reflow between the removal and the add. Without this the browser
    // coalesces them into no change at all and a repeated ack is silent. It
    // looks like a no-op and is not; do not "tidy" it into a setTimeout, which
    // would put the replay a frame late instead of now.
    void node.offsetWidth
    node.classList.add(className)

    const done = (e: AnimationEvent) => {
      // `animationend` bubbles, and a K routinely lands on a row containing
      // chips, icons and spinners of its own. Without this check the first
      // descendant to finish anything clears the parent's ack early.
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
