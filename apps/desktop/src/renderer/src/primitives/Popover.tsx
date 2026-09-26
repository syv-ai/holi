import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

/**
 * A panel anchored to what opened it, for content: unlike a tooltip, its
 * content is focusable and selectable, so it can hold a link or an address to
 * copy.
 */
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>): React.JSX.Element {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(
  props: React.ComponentProps<typeof PopoverPrimitive.Trigger>,
): React.JSX.Element {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** What the content is placed against when that is not the trigger: an element,
 *  or a `virtualRef` whose `getBoundingClientRect` says where (a button inside
 *  another tree's shadow root, say). */
function PopoverAnchor(
  props: React.ComponentProps<typeof PopoverPrimitive.Anchor>,
): React.JSX.Element {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>): React.JSX.Element {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // Borderless on the themeable `.shadow-popover`, like every overlay.
          'z-50 w-72 rounded-md bg-popover p-3 text-popover-foreground shadow-popover outline-hidden',
          'origin-(--radix-popover-content-transform-origin) data-[state=open]:motion-in-origin data-[state=closed]:motion-out-origin',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
