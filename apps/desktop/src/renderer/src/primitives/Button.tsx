import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/cn'
import { FIELD_LOOK } from './field-look'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap motion-respond outline-none active:scale-[0.97] focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      size: {
        // No `has-[>svg]:px-*` arms: tailwind-merge cannot see them as
        // padding, so they beat a caller's own `px-*` and broke shared edges.
        default: 'h-9 px-4 py-2',
        xs: 'h-6 gap-1 rounded-md px-2 text-xs',
        sm: 'h-8 gap-1.5 rounded-md px-3',
        lg: 'h-10 rounded-md px-6',
        // No icon sizes: a control that is only an icon is an `IconButton`.
      },
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-0 dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-brand underline-offset-4 hover:underline',
        // A value in a labelled row: `field-look.ts`. `shrink`, because the
        // base is `shrink-0` and a full-width button would overhang its row.
        field: `${FIELD_LOOK} shrink gap-2`,
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

// forwardRef: a ref must reach the element so Button can be a Radix trigger
// (Tooltip/Menu asChild anchor to it). asChild still composes via Slot.
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
    }
>(({ className, variant = 'default', size = 'default', asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})
Button.displayName = 'Button'

export { Button, buttonVariants }
