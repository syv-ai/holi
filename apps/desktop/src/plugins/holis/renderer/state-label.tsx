/**
 * The small pieces a Holi's rows and pages share: a run's state in words
 * ("Need approval", "Working…", "Done").
 * After MonoCode's sidebar (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 *
 * Colour here is state, each with its `dark:` pair: amber for waiting on you,
 * green for done (`docs/ui-system.md`, Monotone).
 */
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { cn } from '@/plugin-api'

export function StateLabel({
  state,
  className,
}: {
  state: 'needs-you' | 'working' | 'done'
  className?: string
}): React.JSX.Element {
  if (state === 'needs-you') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-amber-600 dark:text-amber-400',
          className,
        )}
      >
        <CircleAlert className="size-3" />
        Need approval
      </span>
    )
  }
  if (state === 'working') {
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-1 text-foreground', className)}>
        {/* The one in-flight loop: the house orbit (docs/ui-system.md, Motion). */}
        <LoaderCircle className="size-3 motion-orbit" />
        Working…
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-emerald-600 dark:text-emerald-400',
        className,
      )}
    >
      <Check className="size-3" />
      Done
    </span>
  )
}
