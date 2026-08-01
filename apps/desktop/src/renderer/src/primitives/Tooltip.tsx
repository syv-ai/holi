import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/cn"

/**
 * The one tooltip provider, mounted once at the app root (main.tsx). It owns the
 * shared timing: `delayDuration` before the first tooltip opens, and Radix's
 * skip-delay grace so moving across a toolbar of controls shows the next one
 * instantly. A single provider is what makes that coordination possible — hence
 * one at the root rather than one per tooltip.
 */
export function TooltipProvider({
  delayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
  )
}

/**
 * The house tooltip — our own, never the native `title` attribute. One ergonomic
 * component: wrap any trigger, pass `content`. It relies on the root
 * TooltipProvider (above), and passes through untouched when `content` is empty,
 * so a conditional tooltip is a one-liner.
 *
 * The trigger is `asChild`, so the child must forward a ref (Radix anchors and
 * binds hover to it) — our Button/Input primitives do. `content` is the VISIBLE
 * label; an icon-only trigger still needs its own aria-label for the accessible
 * name, since Radix wires `content` as a description, not the name.
 */
export function Tooltip({
  content,
  side = "bottom",
  children,
  className,
}: {
  content: React.ReactNode
  side?: "top" | "right" | "bottom" | "left"
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  if (content === null || content === undefined || content === "") {
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
            // Theme-consistent with the other overlays (ContextMenu/DropdownMenu):
            // the popover surface in both themes — NOT shadcn's inverted bg-foreground,
            // which reads light-on-dark in dark mode. Arrowless, like the menus.
            "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md border bg-popover px-2 py-1 text-xs text-balance text-popover-foreground shadow-md fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            className,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
