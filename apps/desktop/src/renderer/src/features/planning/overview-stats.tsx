// ReUI block: @reui/stats-9 (`npx shadcn@latest view @reui/stats-9` shows the published source)
import type { CSSProperties, ReactNode } from "react"
import { Frame, FramePanel } from "@/components/reui/frame"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

type StatsBucket = {
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

export function OverviewStats({
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
      <FramePanel>
        <div className="flex flex-col gap-5">
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
                    className={cn("h-full w-(--share)", bucket.dotClassName)}
                    style={
                      {
                        "--share": `${(bucket.value / Math.max(total, 1)) * 100}%`,
                      } as CSSProperties
                    }
                  />
                ) : null
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {buckets.map((bucket) => (
                <Button
                  key={bucket.id}
                  type="button"
                  variant="text"
                  size="inline"
                  onClick={() => onSelectBucket?.(bucket.id)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-2 rounded-full", bucket.dotClassName)}
                  />
                  {bucket.label}
                  <span className="text-foreground font-medium tabular-nums">
                    {bucket.value}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        </div>
      </FramePanel>
    </Frame>
  )
}
