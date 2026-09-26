import { Tooltip as TooltipPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

/**
 * The one tooltip provider, mounted at the app root (main.tsx). A single
 * provider is what lets Radix's skip-delay show the next tooltip in a toolbar
 * instantly.
 */
export function TooltipProvider({
  delayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

/**
 * The house tooltip, never the native `title`. Passes through when `content`
 * is empty.
 *
 * The trigger is `asChild`, so the child must forward a ref. Radix wires
 * `content` as a description, so an icon-only trigger still needs its own
 * aria-label.
 */
export function Tooltip({
  content,
  side = 'bottom',
  children,
  className,
}: {
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  if (content === null || content === undefined || content === '') {
    return <>{children}</>
  }
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          data-slot="tooltip-content"
          side={side}
          sideOffset={4}
          className={cn(
            // The popover surface like the menus, not shadcn's inverted
            // bg-foreground. Arrowless and borderless: the shadow separates it.
            'z-50 w-fit origin-(--radix-tooltip-content-transform-origin) motion-in-origin rounded-md bg-popover px-2 py-1 text-xs text-balance text-popover-foreground shadow-popover data-[state=closed]:motion-out-origin',
            className,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
