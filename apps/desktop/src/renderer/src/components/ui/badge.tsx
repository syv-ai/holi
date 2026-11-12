// ReUI: @reui/badge (`npx shadcn@latest view @reui/badge` shows the published source)
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/cn"

const badgeVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center w-fit font-medium whitespace-nowrap outline-none transition-shadow",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        info: "bg-info text-badge-solid-foreground",
        success: "bg-success text-badge-solid-foreground",
        warning: "bg-warning text-badge-solid-foreground",
        destructive: "bg-destructive text-destructive-solid-foreground",
        focus: "bg-focus text-badge-solid-foreground",
        invert: "bg-invert text-invert-foreground",
      },
      size: {
        xs: "px-1 py-0.25 text-[0.6rem] leading-none h-4 min-w-4 gap-1",
        sm: "px-1 py-0.25 text-[0.625rem] leading-none h-4.5 min-w-4.5 gap-1",
        default: "px-1.25 py-0.5 text-xs h-5 min-w-5 gap-1",
        lg: "px-1.5 py-0.5 text-xs h-5.5 min-w-5.5 gap-1",
        xl: "px-2 py-0.75 text-sm h-6 min-w-6 gap-1.5",
      },
      /** `default`: active style radius. `full`: pill radius. */
      radius: {
        default: "rounded-sm",
        full: "rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      radius: "default",
    },
  }
)

interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  asChild?: boolean
}

function Badge({
  className,
  variant,
  size,
  radius,
  asChild = false,
  ...props
}: BadgeProps) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, size, radius, className }))}
      {...props}
    />
  )
}

export { Badge, badgeVariants, type BadgeProps }
