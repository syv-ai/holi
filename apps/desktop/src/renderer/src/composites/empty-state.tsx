import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import type { IconGlyph } from '@/lib/icon-glyph'

/**
 * What a region shows when it has nothing to show: empty, disconnected,
 * failed, or "pick something". The one vocabulary for it (docs/ui-system.md,
 * States), built on the stock `Empty`: an optional icon, one sentence, an
 * optional muted line under it, and at most one action, centred in the region
 * it stands in for. An error passes `role="alert"` (or is an `ErrorState`)
 * and a Retry action; the reasons a region is empty are told apart by the
 * sentence, not by a second layout. `children` is for an action that is not a
 * plain button (a menu, a link).
 */
export function EmptyState({
  icon: Glyph,
  title,
  description,
  action,
  children,
  role,
  className,
}: {
  icon?: IconGlyph
  /** The one sentence: why it is empty, or what to do. */
  title: ReactNode
  /** A quieter second line: the detail, an error's own words. */
  description?: ReactNode
  /** The one thing to do about it. */
  action?: { label: string; onClick: () => void; icon?: IconGlyph }
  /** A custom action, under the text. */
  children?: ReactNode
  role?: 'status' | 'alert'
  className?: string
}): React.JSX.Element {
  const ActionGlyph = action?.icon
  return (
    <Empty data-slot="empty-state" role={role} className={cn('h-full min-h-0', className)}>
      <EmptyHeader>
        {Glyph && (
          <EmptyMedia variant="icon">
            <Glyph aria-hidden />
          </EmptyMedia>
        )}
        <EmptyTitle>{title}</EmptyTitle>
        {description && (
          <EmptyDescription className="text-xs text-pretty break-words">
            {description}
          </EmptyDescription>
        )}
      </EmptyHeader>
      {(action || children) && (
        <EmptyContent>
          {action && (
            <Button variant="secondary" size="sm" onClick={action.onClick}>
              {ActionGlyph && <ActionGlyph aria-hidden />}
              {action.label}
            </Button>
          )}
          {children}
        </EmptyContent>
      )}
    </Empty>
  )
}

/** A region that failed to load: the reason, in the error's own words, and Retry. */
export function ErrorState({
  title,
  message,
  onRetry,
  className,
}: {
  title: ReactNode
  message?: ReactNode
  onRetry: () => void
  className?: string
}): React.JSX.Element {
  return (
    <EmptyState
      role="alert"
      title={title}
      description={message}
      action={{ label: 'Retry', onClick: onRetry }}
      className={className}
    />
  )
}

/**
 * A region's loading state: skeleton rows the height of the real rows, so the
 * layout does not jump when the data lands. Three rows is enough; `lines` is
 * how many text lines a real row carries.
 */
export function LoadingRows({
  label,
  rows = 3,
  lines = 2,
  className,
}: {
  /** Announced to assistive tech: "Loading mail". */
  label: string
  rows?: number
  lines?: 1 | 2 | 3
  className?: string
}): React.JSX.Element {
  return (
    <div role="status" aria-label={label} className={cn('flex flex-col', className)}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex flex-col gap-2 border-b border-divider px-4 py-3">
          <Skeleton className="h-3.5 w-2/5" />
          {lines > 1 && <Skeleton className="h-3.5 w-4/5" />}
          {lines > 2 && <Skeleton className="h-3 w-3/5" />}
        </div>
      ))}
    </div>
  )
}
