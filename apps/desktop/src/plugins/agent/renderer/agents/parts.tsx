/**
 * The small pieces every row and header share: the state ("Need approval",
 * "Working…", "Done"), how long ago, and a session's card. After MonoCode's
 * sidebar rows (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 *
 * Colour here is state, each with its `dark:` pair: amber for waiting on you,
 * green for done (`docs/ui-system.md`, Monotone).
 */
import { Check, CircleAlert, GitBranch, LoaderCircle } from 'lucide-react'
import type { ComponentProps } from 'react'
import { AgentMark } from '@/composites'
import { Button, Icon } from '@/primitives'
import { providerLabel } from '../state/providers'
import { cn } from '@/plugin-api'
import type { AgentSession } from '../state/sessions'

type RowState = 'needs-you' | 'working' | 'done' | 'idle'

/** The state, in MonoCode's words, with its glyph. */
function StateLabel({
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

/** "now", "10m", "2h", "1d", then a date: how long ago, as MonoCode puts it. */
function ago(at: number, now: number): string {
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

/**
 * A live session as MonoCode's session card draws one: the provider's mark
 * and its model with the state or how long ago on the right, its title, and
 * where it runs. One that needs you is a dashed card, so it reads at a glance
 * among the others.
 */
export function SessionCard({
  session,
  vault,
  current,
  now,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children'> & {
  session: AgentSession
  /** Where it runs: the vault's `owner/repo`. */
  vault: string
  current: boolean
  now: number
}): React.JSX.Element {
  const needs = session.state === 'needs-you'
  return (
    <Button
      {...props}
      variant="ghost"
      className={cn(
        'h-auto w-full min-w-0 flex-col items-stretch gap-1 rounded-lg border border-transparent px-2.5 py-2 text-start font-normal motion-respond hover:bg-foreground/[0.04] active:bg-foreground/[0.07] aria-[current=page]:bg-foreground/[0.06]',
        needs && 'border-dashed border-foreground/25 bg-foreground/[0.05]',
        className,
      )}
      aria-current={current ? 'page' : undefined}
      data-session-row={session.id}
      data-session-state={session.state}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <AgentMark agent={session.provider} />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {session.model ?? providerLabel(session.provider)}
          </span>
        </span>
        <span className="flex shrink-0 items-center text-xs text-muted-foreground tabular-nums">
          {session.state === 'idle' ? (
            session.startedAt === undefined ? (
              'Idle'
            ) : (
              ago(session.startedAt, now)
            )
          ) : (
            <StateLabel state={session.state} />
          )}
        </span>
      </span>
      <span className="line-clamp-1 text-sm font-semibold text-foreground">{session.name}</span>
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <Icon icon={GitBranch} size="sm" className="size-3" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {needs && session.waitingFor !== undefined ? session.waitingFor : vault}
        </span>
      </span>
    </Button>
  )
}
