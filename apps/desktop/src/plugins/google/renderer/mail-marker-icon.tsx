import { CircleHelp, RefreshCw, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { MailMarker } from '../shared/mail-markers'

const MARKER_LABELS: Record<MailMarker, string> = {
  'yellow-star': 'Yellow star',
  'red-star': 'Red star',
  'blue-question': 'Blue question mark',
}

/** The visible symbol and accessible name for one confirmed mail annotation. */
function MailMarkerIcon({ marker, className }: { marker: MailMarker; className?: string }) {
  const color =
    marker === 'yellow-star'
      ? 'fill-amber-400 text-amber-400 dark:fill-amber-500 dark:text-amber-500'
      : marker === 'red-star'
        ? 'fill-red-500 text-red-500 dark:fill-red-400 dark:text-red-400'
        : 'text-blue-500 dark:text-blue-400'
  const Icon = marker === 'blue-question' ? CircleHelp : Star
  return (
    <Icon className={`${color} ${className ?? ''}`} role="img" aria-label={MARKER_LABELS[marker]} />
  )
}

/** Shows an annotation read's state without confusing it with Gmail's star flag. */
export function MailMarkerStatus({
  state,
  starred,
  onRetry,
  className,
}: {
  state: { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; marker: MailMarker | null }
  starred: boolean
  onRetry?: () => void
  className?: string
}) {
  if (!starred) return null
  if (state.kind === 'loading')
    return (
      <Skeleton className={`size-3.5 shrink-0 ${className ?? ''}`} aria-label="Loading marker" />
    )
  if (state.kind === 'error')
    return (
      <span role="status" className={`inline-flex items-center gap-1 ${className ?? ''}`}>
        <Star
          className="size-3.5 shrink-0 fill-amber-400 text-amber-400 dark:fill-amber-500 dark:text-amber-500"
          role="img"
          aria-label="Starred"
        />
        <span className="text-destructive text-xs">Marker unavailable</span>
        {onRetry !== undefined && <MailMarkerRetry onRetry={onRetry} />}
      </span>
    )
  if (state.marker !== null)
    return (
      <MailMarkerIcon marker={state.marker} className={`size-3.5 shrink-0 ${className ?? ''}`} />
    )
  return starred ? (
    <Star
      className={`size-3.5 shrink-0 fill-amber-400 text-amber-400 dark:fill-amber-500 dark:text-amber-500 ${className ?? ''}`}
      role="img"
      aria-label="Starred"
    />
  ) : null
}

/** A standalone retry control, for rows whose primary action is a button. */
export function MailMarkerRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Retry marker"
      onClick={(event) => {
        event.stopPropagation()
        onRetry()
      }}
    >
      <RefreshCw aria-hidden="true" />
    </Button>
  )
}
