/**
 * The small pieces every planning tab draws a task with: its status, its
 * priority, its dates, its people. One place, so the board, the list and the
 * table say a task's facts the same way.
 */
import type { ComponentProps } from 'react'
import { isPrivateTask, type Priority, type StatusCategory, type StatusDef } from '@holi/shared'
import {
  CalendarDaysIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  CircleIcon,
  FlagIcon,
  LockIcon,
  TimerIcon,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/reui/badge'
import { cn } from '@/lib/cn'
import { priorityName, shortDate } from '@/lib/planning'

/** A status's mark, by what it means: its shape says the category even
 *  without its colour. Unsized, so a menu item or badge sizes it; elsewhere
 *  pass `size-4`. */
const CATEGORY_ICON: Record<StatusCategory, { icon: LucideIcon; className: string }> = {
  backlog: { icon: CircleDashedIcon, className: 'text-muted-foreground' },
  unstarted: { icon: CircleIcon, className: 'text-muted-foreground' },
  started: { icon: CircleDotIcon, className: 'text-warning' },
  review: { icon: CircleEllipsisIcon, className: 'text-info' },
  completed: { icon: CircleCheckIcon, className: 'text-success' },
}

export function StatusIcon({ status, className }: { status: StatusDef; className?: string }) {
  const { icon: Icon, className: tone } = CATEGORY_ICON[status.category]
  return <Icon aria-hidden="true" className={cn('shrink-0', tone, className)} />
}

export function StatusBadge({ status }: { status: StatusDef }) {
  return (
    <Badge variant="outline">
      <StatusIcon status={status} />
      {status.name}
    </Badge>
  )
}

const PRIORITY_VARIANT: Record<Priority, ComponentProps<typeof Badge>['variant']> = {
  urgent: 'destructive-light',
  high: 'warning-light',
  medium: 'info-light',
  low: 'secondary',
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge variant={PRIORITY_VARIANT[priority]}>
      <FlagIcon aria-hidden="true" />
      {priorityName(priority)}
    </Badge>
  )
}

/** A due or start date; red once a due date has passed. */
export function DateBadge({
  stamp,
  today,
  overdue = false,
  label,
}: {
  stamp: string
  today: string
  overdue?: boolean
  label: string
}) {
  return (
    <Badge
      variant={overdue ? 'destructive-light' : 'outline'}
      className={cn('font-normal', !overdue && 'bg-background')}
      aria-label={`${label} ${shortDate(stamp, today)}${overdue ? ', overdue' : ''}`}
    >
      <CalendarDaysIcon
        className={cn('size-3.5', !overdue && 'text-muted-foreground')}
        aria-hidden="true"
      />
      <span className="tabular-nums">{shortDate(stamp, today)}</span>
    </Badge>
  )
}

export function EstimateBadge({ estimate }: { estimate: string }) {
  return (
    <Badge
      variant="outline"
      className="bg-background font-normal"
      aria-label={`Estimate ${estimate}`}
    >
      <TimerIcon className="text-muted-foreground size-3.5" aria-hidden="true" />
      <span className="tabular-nums">{estimate}</span>
    </Badge>
  )
}

export function TagBadges({ tags }: { tags: readonly string[] }) {
  return (
    <>
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary">
          {tag}
        </Badge>
      ))}
    </>
  )
}

/** A private task's mark beside its title: the file is `.local.`, on this
 *  machine only (docs/features/tasks.md). Nothing for a shared one. */
export function PrivateMark({ path }: { path: string }) {
  if (!isPrivateTask(path)) return null
  return (
    <span data-private-task className="text-muted-foreground inline-flex shrink-0">
      <LockIcon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">, private</span>
    </span>
  )
}
