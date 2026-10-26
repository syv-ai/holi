/** The automation editor's Runs tab: when each run started and how long it took. */
import { Clock } from 'lucide-react'
import type { RunRecord } from './schedules-cap'
import { EmptyState } from '@/composites/empty-state'
import { Badge } from '@/components/ui/badge'

const runFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

function duration(from: string, to: string | undefined): string {
  if (to === undefined) return ''
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000)
  if (minutes < 1) return '< 1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function RunHistory({ runs }: { runs: readonly RunRecord[] }): React.JSX.Element {
  if (runs.length === 0) {
    return <EmptyState icon={Clock} title="It has not run yet" />
  }
  return (
    <ul aria-label="Run history" className="flex flex-col divide-y divide-divider">
      {runs.map((r, i) => (
        <li key={`${r.at}-${i}`} className="flex min-h-11 items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {r.trigger === 'manual' ? 'Run now' : r.trigger === 'event' ? 'Event' : 'Scheduled'}
            {r.trigger === 'event' && r.cause !== undefined && (
              <span className="text-muted-foreground"> · {r.cause}</span>
            )}
            {r.message !== undefined && (
              <span className="text-muted-foreground"> · {r.message}</span>
            )}
          </span>
          <span className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
            {runFormat.format(new Date(r.at))}
          </span>
          <span className="w-24 shrink-0">
            <Badge
              variant={
                r.outcome === 'failed'
                  ? 'destructive-light'
                  : r.outcome === 'started'
                    ? 'primary-light'
                    : 'outline'
              }
            >
              {r.outcome === 'started'
                ? r.finishedAt === undefined
                  ? 'Running'
                  : 'Finished'
                : r.outcome === 'failed'
                  ? 'Failed'
                  : 'Skipped'}
            </Badge>
          </span>
          <span className="w-14 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
            {duration(r.at, r.finishedAt)}
          </span>
        </li>
      ))}
    </ul>
  )
}
