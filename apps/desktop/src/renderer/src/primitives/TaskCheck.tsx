/**
 * A task's check: a dashed ring that fills with the brand, pops, and draws a
 * tick (ported from rare-ui's task list, fitted to the house tokens).
 *
 * **Presentational.** `filled` is what it shows, not the task's status: the
 * board drives it from its completion sequence, which runs ahead of the write
 * and behind it (`features/tasks/use-check-sequence.ts`). `onDrawn` fires when
 * the tick has finished drawing, or undrawing, so the next beat can start.
 *
 * Genuine checkboxes (settings, filters, PDF fields) stay `Checkbox`.
 */
import { motion, useReducedMotion, type Transition } from 'motion/react'
import { cn } from '@/lib/cn'
import { check, instant } from './springs'

/** Dashes that divide the circumference evenly, so the ring closes without a seam. */
const RING_R = 10
const RING_DASH = `1 ${(2 * Math.PI * RING_R) / 13 - 1}`

export function TaskCheck({
  filled,
  onDrawn,
  label,
  onClick,
  className,
}: {
  filled: boolean
  onDrawn?: () => void
  /** The accessible name: "Complete Fix login", "Reopen Fix login". */
  label: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  className?: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const timing = (transition: Transition) => (reduced ? instant : transition)
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={filled}
      aria-label={label}
      data-slot="task-check"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      <motion.svg
        viewBox="0 0 24 24"
        aria-hidden
        className="size-4 text-muted-foreground"
        initial={false}
        animate={{ scale: filled ? check.popScale : 1 }}
        transition={filled ? timing(check.pop) : instant}
      >
        <motion.circle
          cx="12"
          cy="12"
          r={RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray={RING_DASH}
          initial={false}
          animate={{ opacity: filled ? 0 : 1 }}
          transition={timing(check.fill)}
        />
        <motion.circle
          cx="12"
          cy="12"
          r="12"
          className="fill-primary"
          style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
          initial={false}
          animate={{ scale: filled ? 1 : 0 }}
          transition={timing(check.fill)}
        />
        <motion.path
          d="M7.4 12.4 10.6 15.5 16.6 8.9"
          fill="none"
          className="stroke-primary-foreground"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{ pathLength: filled ? 1 : 0, opacity: filled ? 1 : 0 }}
          transition={timing(check.tick)}
          onAnimationComplete={onDrawn}
        />
      </motion.svg>
    </button>
  )
}
