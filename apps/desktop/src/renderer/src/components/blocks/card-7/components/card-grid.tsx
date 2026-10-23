import { Frame } from "@/components/reui/frame"

import { CardItem } from "./card-item"
import type { ICard } from "./data"

export function CardGrid({ cards }: { cards: ICard[] }) {
  return (
    <Frame className="@container w-full">
      {/* Grid */}
      <div className="grid gap-1 @md:grid-cols-2">
        {cards.map((card) => (
          <CardItem key={card.label} card={card} />
        ))}
      </div>
    </Frame>
  )
}
