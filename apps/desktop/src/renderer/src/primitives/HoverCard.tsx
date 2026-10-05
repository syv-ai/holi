import { HoverCard as HoverCardPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

/**
 * A card that opens while the pointer rests on its trigger and stays while the
 * pointer is inside it, so what it holds can be pressed: a tooltip with
 * controls in it. Pointer only, so whatever it offers needs a keyboard route
 * of its own.
 *
 * The trigger is `asChild`, so the child must forward a ref.
 */
export function HoverCard({
  content,
  side = 'top',
  children,
  className,
}: {
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <HoverCardPrimitive.Root openDelay={150} closeDelay={120}>
      <HoverCardPrimitive.Trigger asChild>{children}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          data-slot="hover-card-content"
          side={side}
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            // Borderless on the themeable `.shadow-popover`, like every overlay.
            'z-50 rounded-xl bg-popover p-1.5 text-popover-foreground shadow-popover outline-hidden',
            'origin-(--radix-hover-card-content-transform-origin) data-[state=closed]:motion-out-origin data-[state=open]:motion-in-origin',
            className,
          )}
        >
          {content}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  )
}
