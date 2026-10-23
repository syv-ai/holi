/**
 * The small pieces every planning tab draws a task with: its status, its
 * priority, its dates, its people. One place, so the board, the list and the
 * table say a task's facts the same way.
 */
import type { ComponentProps } from "react"
import type { Priority, StatusDef } from "@holi/shared"
import { CalendarDaysIcon, FlagIcon, TimerIcon } from "lucide-react"

import { Badge } from "@/components/reui/badge"
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar"
import { cn } from "@/lib/cn"
import {
  avatarUrl,
  CATEGORY_DOT,
  initials,
  priorityName,
  shortDate,
} from "@/lib/planning"

export function StatusDot({
  status,
  className,
}: {
  status: StatusDef
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        CATEGORY_DOT[status.category],
        className
      )}
    />
  )
}

export function StatusBadge({ status }: { status: StatusDef }) {
  return (
    <Badge variant="outline" className="bg-background gap-1.5">
      <StatusDot status={status} className="size-1.5" />
      {status.name}
    </Badge>
  )
}

const PRIORITY_VARIANT: Record<
  Priority,
  ComponentProps<typeof Badge>["variant"]
> = {
  urgent: "destructive-light",
  high: "warning-light",
  medium: "info-light",
  low: "secondary",
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge variant={PRIORITY_VARIANT[priority]} className="gap-1">
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
      variant={overdue ? "destructive-light" : "outline"}
      className={cn("gap-1.5 font-normal", !overdue && "bg-background")}
      aria-label={`${label} ${shortDate(stamp, today)}${overdue ? ", overdue" : ""}`}
    >
      <CalendarDaysIcon
        className={cn("size-3.5", !overdue && "text-muted-foreground")}
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
      className="bg-background gap-1 font-normal"
      aria-label={`Estimate ${estimate}`}
    >
      <TimerIcon
        className="text-muted-foreground size-3.5"
        aria-hidden="true"
      />
      <span className="tabular-nums">{estimate}</span>
    </Badge>
  )
}

export function PersonAvatar({
  login,
  size = "sm",
  className,
}: {
  login: string
  size?: "sm" | "default"
  className?: string
}) {
  return (
    <Avatar size={size} className={className}>
      <AvatarImage src={avatarUrl(login)} alt={login} />
      <AvatarFallback>{initials(login)}</AvatarFallback>
    </Avatar>
  )
}

/** Up to `max` faces, then a count. */
export function PeopleStack({
  logins,
  max = 3,
}: {
  logins: readonly string[]
  max?: number
}) {
  if (logins.length === 0) return null
  const shown = logins.slice(0, max)
  const rest = logins.length - shown.length
  return (
    <AvatarGroup aria-label={logins.join(", ")}>
      {shown.map((login) => (
        <PersonAvatar key={login} login={login} />
      ))}
      {rest > 0 ? (
        <AvatarGroupCount className="tabular-nums">+{rest}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
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
