/**
 * The small pieces every row and header share: the state ("Need approval",
 * "Working…", "Done"), the lines a turn changed, and how long ago. After
 * MonoCode's sidebar rows (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 *
 * Colour here is state, each with its `dark:` pair: amber for waiting on you,
 * green for done, and the diff's own added and removed tokens
 * (`docs/ui-system.md`, Monotone).
 */
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { Icon } from '@/primitives'
import { cn } from '@/plugin-api'

export type RowState = 'needs-you' | 'working' | 'done' | 'idle'

/** The state, in MonoCode's words, with its glyph. */
export function StateLabel({
  state,
  className,
}: {
  state: RowState
  className?: string
}): React.JSX.Element | null {
  if (state === 'needs-you') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-amber-600 dark:text-amber-400',
          className,
        )}
      >
        <Icon icon={CircleAlert} size="sm" className="size-3" />
        Need approval
      </span>
    )
  }
  if (state === 'working') {
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-1 text-foreground', className)}>
        {/* The one in-flight loop: the house orbit (docs/ui-system.md, Motion). */}
        <Icon icon={LoaderCircle} size="sm" className="size-3 motion-orbit" />
        Working…
      </span>
    )
  }
  if (state === 'done') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-emerald-600 dark:text-emerald-400',
          className,
        )}
      >
        <Icon icon={Check} size="sm" className="size-3" />
        Done
      </span>
    )
  }
  return null
}

/** `+135 −21`: what a turn changed, in lines. */
export function Churn({ added, removed }: { added: number; removed: number }): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
      <span className="text-diff-added-foreground">+{added}</span>
      <span className="text-diff-removed-foreground">−{removed}</span>
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
