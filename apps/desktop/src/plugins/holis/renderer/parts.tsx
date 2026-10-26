/**
 * The small pieces a Holi's rows and pages share: a run's state in words
 * ("Need approval", "Working…", "Done"), how long ago, and a clock that moves.
 * The agent's rows say the same in the same words (after MonoCode's sidebar,
 * MIT, Copyright (c) 2026 Nick; see NOTICE.md); a plugin cannot import
 * another's, so the few lines are its own.
 *
 * Colour here is state, each with its `dark:` pair: amber for waiting on you,
 * green for done (`docs/ui-system.md`, Monotone).
 */
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/plugin-api'

/** The grey of a Holi that has no colour yet. */
export const DEFAULT_HOLI_COLOUR = '#8f8f94'

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

/** "now", "10m", "2h", "1d", then a date: how long ago, as MonoCode puts it. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(at))
}

/** "now" that moves, so the times on a page stay true.
 *  Reading the wall clock is the point: an age ("5m") counts from it. */
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs)
    return () => window.clearInterval(id)
  }, [stepMs])
  return now
}
