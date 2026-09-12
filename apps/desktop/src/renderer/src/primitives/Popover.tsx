import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

/**
 * A panel anchored to what opened it — for content, where a tooltip is for a
 * label and a dropdown is for a list of commands.
 *
 * The distinction matters at the keyboard: a popover's content is focusable and
 * selectable, so it can hold a link the user actually clicks or an address they
 * copy. A tooltip cannot — it dismisses on the way to it.
 */
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>): React.JSX.Element {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(
  props: React.ComponentProps<typeof PopoverPrimitive.Trigger>,
): React.JSX.Element {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
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
          // Borderless and on `.shadow-popover`, like every other overlay since
          // 2026-08-14. `shadow-md` was Tailwind's baked utility, which is not
          // themeable — the whole reason `.shadow-popover` exists (see index.css).
          'z-50 w-72 rounded-md bg-popover p-3 text-popover-foreground shadow-popover outline-hidden',
          'origin-(--radix-popover-content-transform-origin) data-[state=open]:motion-in-origin data-[state=closed]:motion-out-origin',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
