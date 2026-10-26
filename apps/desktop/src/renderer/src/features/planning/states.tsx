/**
 * The three states every planning region has (AGENTS.md, rule 6): a
 * skeleton in the region's own shape while it loads, an empty state with
 * the one thing to do next, and an inline error that can be retried.
 */
import type { ReactNode } from "react"
import { CircleAlertIcon } from "lucide-react"

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/reui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/cn"

export function RegionError({
  title,
  message,
  onRetry,
}: {
  title: string
  message: string
  onRetry: () => void
}) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** ReUI's empty states: inside a panel it stands bare (c-empty-12); as a
 *  whole tab's content it takes the dashed outline (c-empty-4), so the
 *  empty page still has an edge. */
export function RegionEmpty({
  icon,
  title,
  description,
  action,
  outlined = false,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
  outlined?: boolean
}) {
  return (
    <Empty className={cn(outlined && "border")}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action != null ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

/** Search and filters left nothing to show (c-empty-2): says so, and is the
 *  one way back out. */
export function NoMatches({
  search,
  onClear,
}: {
  search: string
  onClear: () => void
}) {
  const query = search.trim()
  return (
    <Empty className="bg-muted">
      <EmptyHeader>
        <EmptyTitle>No matching tasks</EmptyTitle>
        <EmptyDescription>
          {query !== ""
            ? `Nothing matches “${query}” with the filters you picked.`
            : "No task matches the filters you picked."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      </EmptyContent>
    </Empty>
  )
}
