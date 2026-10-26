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

import { PersonAvatar } from "@/composites/person-avatar"
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
          <TimelineItem
            key={item.id}
            step={item.id}
            className="group-data-[orientation=vertical]/timeline:ms-9 group-data-[orientation=vertical]/timeline:not-last:pb-6"
          >
            <TimelineHeader className="flex min-w-0 items-start justify-between gap-2.5">
              <TimelineSeparator className="bg-border group-data-[orientation=vertical]/timeline:top-1 group-data-[orientation=vertical]/timeline:-left-7 group-data-[orientation=vertical]/timeline:h-[calc(100%-2.25rem)] group-data-[orientation=vertical]/timeline:translate-y-6" />
              <TimelineIndicator className="bg-background flex size-6 items-center justify-center overflow-hidden rounded-full border-none group-data-[orientation=vertical]/timeline:-top-0.5 group-data-[orientation=vertical]/timeline:-left-7">
                <PersonAvatar login={item.actor} image={false} className="size-6" />
              </TimelineIndicator>

              <TimelineTitle className="min-w-0 text-sm leading-5">
                <span className="font-medium">{item.actor}</span>{" "}
                <span className="text-muted-foreground font-normal">
                  {item.action}
                </span>{" "}
                {item.path !== undefined && onOpen ? (
                  <button
                    type="button"
                    className="hover:text-primary focus-visible:ring-ring/50 rounded-sm font-medium underline-offset-4 transition-colors outline-none hover:underline focus-visible:ring-2"
                    onClick={() => onOpen(item.path!)}
                  >
                    {item.target}
                  </button>
                ) : (
                  <span className="font-medium">{item.target}</span>
                )}
              </TimelineTitle>
            </TimelineHeader>

            <TimelineContent className="flex min-w-0 flex-col items-start gap-2 pb-1">
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
