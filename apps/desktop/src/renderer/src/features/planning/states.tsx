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
import { EmptyState } from "@/composites/empty-state"
import { cn } from "@/lib/cn"
import type { IconGlyph } from "@/lib/icon-glyph"

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

/** A panel's empty state stands bare; as a whole tab's content it takes the
 *  dashed outline, so the empty page still has an edge. */
export function RegionEmpty({
  icon,
  title,
  description,
  action,
  outlined = false,
}: {
  icon: IconGlyph
  title: string
  description: string
  action?: ReactNode
  outlined?: boolean
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      className={cn("h-auto", outlined && "border")}
    >
      {action}
    </EmptyState>
  )
}

/** Search and filters left nothing to show: says so, and is the one way back
 *  out. */
export function NoMatches({
  search,
  onClear,
}: {
  search: string
  onClear: () => void
}) {
  const query = search.trim()
  return (
    <EmptyState
      title="No matching tasks"
      description={
        query !== ""
          ? `Nothing matches “${query}” with the filters you picked.`
          : "No task matches the filters you picked."
      }
      action={{ label: "Clear filters", onClick: onClear }}
      className="h-auto bg-muted"
    />
  )
}
