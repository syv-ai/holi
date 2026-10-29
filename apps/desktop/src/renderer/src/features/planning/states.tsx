/**
 * The three states every planning region has (AGENTS.md, rule 6): a
 * skeleton in the region's own shape while it loads, an empty state with
 * the one thing to do next, and an inline error that can be retried.
 */
import type { ReactNode } from 'react'

import { EmptyState, ErrorState } from '@/composites/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import type { IconGlyph } from '@/lib/icon-glyph'

export function RegionError({
  title,
  message,
  onRetry,
}: {
  title: string
  message: string
  onRetry: () => void
}) {
  return <ErrorState title={title} message={message} onRetry={onRetry} className="h-auto" />
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
  const empty = (
    <EmptyState icon={icon} title={title} description={description} className="h-auto">
      {action}
    </EmptyState>
  )
  return outlined ? <div className="rounded-lg border">{empty}</div> : empty
}

/** Search and filters left nothing to show: says so, and is the one way back
 *  out. */
export function NoMatches({ search, onClear }: { search: string; onClear: () => void }) {
  const query = search.trim()
  return (
    <EmptyState
      title="No matching tasks"
      description={
        query !== ''
          ? `Nothing matches “${query}” with the filters you picked.`
          : 'No task matches the filters you picked.'
      }
      action={{ label: 'Clear filters', onClick: onClear }}
      className="h-auto bg-muted"
    />
  )
}

/** The loading state in the shape of what is loading: board columns of cards,
 *  or the rows of a list or table. */
export function TasksSkeleton({ variant }: { variant: 'board' | 'rows' }) {
  if (variant === 'rows') {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading tasks">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    )
  }
  return (
    <div className="flex gap-3" role="status" aria-label="Loading tasks">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex w-72 shrink-0 flex-col gap-2">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  )
}
