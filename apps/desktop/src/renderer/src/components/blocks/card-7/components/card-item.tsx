import { FramePanel } from "@/components/reui/frame"

import type { ICard } from "./data"

export function CardItem({ card }: { card: ICard }) {
  return (
    <FramePanel className="flex flex-col gap-6">
      <div className="flex grow items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm">{card.label}</span>
        <div className="[&_svg]:text-muted-foreground [&_svg]:size-4">
          {card.icon}
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate text-sm leading-tight font-medium">
            {card.primary}
          </span>
          {card.secondary != null ? (
            <p className="text-muted-foreground text-sm leading-none">
              {card.secondary}
            </p>
          ) : null}
        </div>
        {card.bottom != null && (
          <div className="flex shrink-0 justify-end pt-1">{card.bottom}</div>
        )}
      </div>
    </FramePanel>
  )
}
