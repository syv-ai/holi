// ReUI block: @reui/timeline-4 (`npx shadcn@latest view @reui/timeline-4` shows the published source)
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "@/components/reui/timeline"

import { Button } from "@/components/ui/button"
import type { ActivityItem } from "./activity-data"

export function ActivityTimeline({
  items,
  onOpen,
  label = "Recent activity",
}: {
  items: ActivityItem[]
  onOpen?: (path: string) => void
  label?: string
}) {
  return (
    <section className="w-full" aria-label={label}>
      <Timeline defaultValue={0}>
        {items.map((item) => (
          <TimelineItem key={item.id} step={item.id}>
            <TimelineHeader className="flex min-w-0 items-start justify-between">
              <TimelineSeparator />
              <TimelineIndicator />

              <TimelineTitle className="min-w-0 text-sm leading-5">
                <span className="font-medium">{item.actor}</span>{" "}
                <span className="text-muted-foreground font-normal">
                  {item.action}
                </span>{" "}
                {item.path !== undefined && onOpen ? (
                  <Button
                    type="button"
                    variant="text"
                    size="inline"
                    className="hover:text-primary font-medium underline-offset-4 hover:underline"
                    onClick={() => onOpen(item.path!)}
                  >
                    {item.target}
                  </Button>
                ) : (
                  <span className="font-medium">{item.target}</span>
                )}
              </TimelineTitle>
            </TimelineHeader>

            <TimelineContent className="flex min-w-0 flex-col items-start">
              <TimelineDate dateTime={item.dateTime} className="mb-0">
                {item.date}
              </TimelineDate>
            </TimelineContent>
          </TimelineItem>
        ))}
      </Timeline>
    </section>
  )
}
