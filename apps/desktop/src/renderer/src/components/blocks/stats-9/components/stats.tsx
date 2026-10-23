import type { ReactNode } from "react"
import { Frame, FramePanel } from "@/components/reui/frame"

import { Progress } from "@/components/ui/progress"
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
          <h3 className="text-base font-semibold tracking-tight">{title}</h3>
          {action}
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">
                {percent}%
              </span>
              {meta}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm font-medium">
                {doneLabel}
              </span>
              <span className="text-muted-foreground text-sm font-semibold tabular-nums">
                {done} of {total}
              </span>
            </div>
            <Progress value={percent} aria-label={`${percent}% done`} />
          </div>

          {/* The split by status: one bar, then each status's count. */}
          <div className="flex flex-col gap-3">
            <div
              className="bg-muted flex h-2 w-full overflow-hidden rounded-full"
              aria-hidden="true"
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
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
              {buckets.map((bucket) => (
                <button
                  key={bucket.id}
                  type="button"
                  onClick={() => onSelectBucket?.(bucket.id)}
                  className="bg-muted/60 hover:bg-muted focus-visible:ring-ring/50 flex flex-col items-center justify-center gap-1 rounded-lg px-2 py-3.5 transition-colors outline-none focus-visible:ring-2"
                >
                  <span className="text-lg font-bold tabular-nums">
                    {bucket.value}
                  </span>
                  <span className="text-accent-foreground flex items-center gap-1.5 text-xs">
                    <span
                      aria-hidden="true"
                      className={cn("size-2 rounded-full", bucket.dotClassName)}
                    />
                    {bucket.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </FramePanel>
    </Frame>
  )
}
