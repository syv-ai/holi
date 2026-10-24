import { HoverCard as HoverCardPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

/**
 * A card that shows while the pointer rests on what opened it: a preview of
 * something, never a control only it holds, since a keyboard or a touch never
 * opens it.
 */
function HoverCard(props: React.ComponentProps<typeof HoverCardPrimitive.Root>): React.JSX.Element {
  return <HoverCardPrimitive.Root data-slot="hover-card" openDelay={400} closeDelay={100} {...props} />
}

function HoverCardTrigger(
  props: React.ComponentProps<typeof HoverCardPrimitive.Trigger>,
): React.JSX.Element {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>): React.JSX.Element {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // Borderless on the themeable `.shadow-popover`, like every overlay.
          'z-50 w-80 overflow-hidden rounded-md bg-popover text-popover-foreground shadow-popover outline-hidden',
          'origin-(--radix-hover-card-content-transform-origin) data-[state=open]:motion-in-origin data-[state=closed]:motion-out-origin',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
