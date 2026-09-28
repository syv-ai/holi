/**
 * A number that rolls when it changes: the old value leaves the way the count
 * went (up for more, down for fewer) and the new one arrives behind it.
 * One line tall, tabular figures, so a column header never shifts its width
 * mid-roll by more than a digit.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { instant, roll } from './springs'

const TRAVEL = 12

export function RollingCount({
  value,
  className,
}: {
  value: number
  className?: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const [previous, setPrevious] = useState(value)
  const [direction, setDirection] = useState(1)
  // Adjusted during render: the render that changes the value must already
  // know which way it went, or the first frame travels the wrong way.
  if (previous !== value) {
    setDirection(value > previous ? 1 : -1)
    setPrevious(value)
  }
  return (
    <span
      className={cn('relative inline-flex h-[1lh] overflow-hidden tabular-nums', className)}
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.span
          key={value}
          custom={direction}
          variants={{
            enter: (d: number) => ({ y: d * TRAVEL, opacity: 0, filter: 'blur(2px)' }),
            at: { y: 0, opacity: 1, filter: 'blur(0px)' },
            leave: (d: number) => ({ y: -d * TRAVEL, opacity: 0, filter: 'blur(2px)' }),
          }}
          initial="enter"
          animate="at"
          exit="leave"
          transition={reduced ? instant : roll}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
