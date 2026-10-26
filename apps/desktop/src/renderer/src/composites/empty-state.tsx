import type { ReactNode } from 'react'
import { Button, Icon, type IconGlyph } from '@/primitives'
import { cn } from '@/lib/cn'

/**
 * What a pane shows when it has nothing to show: empty, disconnected, failed,
 * or "pick something". One look everywhere (docs/ui-system.md, States): an
 * optional muted icon (on a lit plate, unless it is an error), one sentence, an optional muted line under it, and at
 * most one action, centred in the region it stands in for. An error passes
 * `role="alert"` and a Retry action; the reasons a region is empty are told
 * apart by the sentence, not by a second layout.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
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
  role?: 'status' | 'alert'
  className?: string
}): React.JSX.Element {
  return (
    <div
      data-slot="empty-state"
      role={role}
      className={cn(
        'flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center',
        className,
      )}
    >
      {icon &&
        (role === 'alert' ? (
          <Icon icon={icon} size="lg" tone="muted" />
        ) : (
          // An empty view stands in the light of the screens before a vault:
          // its icon on a small plate lit from the top-left (index.css). Not an
          // error's: light on a failure would read as good news.
          <span data-slot="empty-plate" className="grid size-12 place-items-center rounded-xl">
            <Icon icon={icon} size="lg" tone="muted" />
          </span>
        ))}
      <div className="flex max-w-sm flex-col gap-0.5">
        <p className="text-sm font-medium text-pretty">{title}</p>
        {description && (
          <p className="text-xs text-pretty break-words text-muted-foreground">{description}</p>
        )}
      </div>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.icon && <Icon icon={action.icon} size="sm" />}
          {action.label}
        </Button>
      )}
    </div>
  )
}

/**
 * A region's loading state: skeleton rows the height of the real rows, so the
 * layout does not jump when the data lands. Three rows is enough; `lines` is
 * how many text lines a real row carries. The bars are the house
 * `motion-shimmer` (an in-flight loop that stops under reduced motion), as the
 * editor's and Home's loaders are, not the `Skeleton` primitive: its
 * `animate-pulse` wins over the shimmer and ignores reduced motion.
 */
const BAR = 'block rounded-md motion-shimmer'

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
          <span className={cn(BAR, 'h-3.5 w-2/5')} />
          {lines > 1 && <span className={cn(BAR, 'h-3.5 w-4/5')} />}
          {lines > 2 && <span className={cn(BAR, 'h-3 w-3/5')} />}
        </div>
      ))}
    </div>
  )
}
