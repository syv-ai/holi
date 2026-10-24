import type { ReactNode } from "react"
import { Frame, FramePanel } from "@/components/reui/frame"

import { cn } from "@/lib/cn"

export type StatsBucket = {
  id: string
  label: string
  value: number
  /** The bucket's identity colour, as a `bg-*` class for its dot and bar. */
  dotClassName: string
}

export type StatsProps = {
  title: string
  /** Right of the title. */
  action?: ReactNode
  doneLabel: string
  done: number
  total: number
  percent: number
  /** One line under the headline figure: what is left, what is late. */
  meta?: ReactNode
  buckets: StatsBucket[]
  onSelectBucket?: (id: string) => void
}

export function Stats({
  title,
  action,
  doneLabel,
  done,
  total,
  percent,
  meta,
  buckets,
  onSelectBucket,
}: StatsProps) {
  return (
    <Frame className="w-full">
      {/* Content */}
      <FramePanel className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {action ?? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {done} of {total} {doneLabel.toLowerCase()}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">
              {percent}%
            </span>
            {meta}
          </div>

          {/* One bar, split by status: the done share and the rest at once. */}
          <div
            role="img"
            aria-label={`${percent}% done`}
            className="bg-muted flex h-2 w-full overflow-hidden rounded-full"
          >
            {buckets.map((bucket) =>
              bucket.value > 0 ? (
                <div
                  key={bucket.id}
                  className={cn("h-full", bucket.dotClassName)}
                  style={{
                    width: `${(bucket.value / Math.max(total, 1)) * 100}%`,
                  }}
                />
              ) : null
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {buckets.map((bucket) => (
              <button
                key={bucket.id}
                type="button"
                onClick={() => onSelectBucket?.(bucket.id)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-sm text-sm transition-colors outline-none focus-visible:ring-2"
              >
                <span
                  aria-hidden="true"
                  className={cn("size-2 rounded-full", bucket.dotClassName)}
                />
                {bucket.label}
                <span className="text-foreground font-medium tabular-nums">
                  {bucket.value}
                </span>
              </button>
            ))}
          </div>
        </div>
      </FramePanel>
    </Frame>
  )
}
