/**
 * A task's check: a ring that fills with the brand and shows a tick. Todo is a
 * plain ring; doing is dotted, in the doing colour. The fill and the tick fade
 * in with the house's respond timing (`motion-respond`): one calm beat, no pop.
 *
 * **Presentational.** `filled` is what it shows, not the task's status: the
 * board fills it the moment it is clicked, ahead of the write.
 *
 * Genuine checkboxes (settings, filters, PDF fields) stay `Checkbox`.
 */
import { cn } from '@/lib/cn'

/** Dashes that divide the circumference evenly, so the ring closes without a seam. */
const RING_R = 10
const RING_DASH = `1 ${(2 * Math.PI * RING_R) / 13 - 1}`

export function TaskCheck({
  filled,
  doing = false,
  label,
  onClick,
  className,
}: {
  filled: boolean
  /** In progress: the ring goes dotted and takes the doing colour, as the
   *  file tree's icon does (`--task-doing`). */
  doing?: boolean
  /** The accessible name: "Complete Fix login", "Reopen Fix login". */
  label: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  className?: string
}): React.JSX.Element {
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
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className={cn('size-4', doing ? 'text-task-doing' : 'text-muted-foreground')}
      >
        <circle
          cx="12"
          cy="12"
          r={RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth={doing ? 2.2 : 1.8}
          strokeLinecap="round"
          strokeDasharray={doing ? RING_DASH : undefined}
          className={cn('motion-respond', filled && 'opacity-0')}
        />
        <g className={cn('motion-respond', !filled && 'opacity-0')}>
          <circle cx="12" cy="12" r="12" className="fill-primary" />
          <path
            d="M7.4 12.4 10.6 15.5 16.6 8.9"
            fill="none"
            className="stroke-primary-foreground"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </button>
  )
}
