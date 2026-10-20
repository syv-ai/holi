/**
 * ReUI's badge, vendored: a short label in a pill-cornered chip, for a state or
 * a category beside a name ("Default", "Needs Agent", "Committed").
 *
 * Only the variants this theme has tokens for. ReUI also ships info, success,
 * warning, focus and invert, which read tokens Holi does not define, so they
 * are left out rather than rendered as nothing; add the token first, then the
 * variant. Sizes stop at `default` (`text-xs`): the smaller two set type below
 * the floor (`docs/ui-system.md`, Type).
 */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/cn'

const badgeVariants = cva(
  'relative inline-flex w-fit shrink-0 items-center justify-center gap-1 border border-transparent font-medium whitespace-nowrap outline-none [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        outline: 'border-border bg-transparent text-muted-foreground dark:bg-input/30',
        'primary-light':
          'border-primary/10 bg-primary/10 text-foreground dark:border-primary/20 dark:bg-primary/10',
        'destructive-light':
          'border-destructive/15 bg-destructive/10 text-destructive dark:border-destructive/25 dark:bg-destructive/15',
      },
      size: {
        default: 'h-5 min-w-5 px-1.5 text-xs',
        lg: 'h-6 min-w-6 px-2 text-xs',
      },
      radius: {
        default: 'rounded-sm',
        full: 'rounded-full',
      },
    },
    defaultVariants: { variant: 'default', size: 'default', radius: 'default' },
  },
)

interface BadgeProps extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  asChild?: boolean
}

function Badge({ className, variant, size, radius, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span'
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, size, radius, className }))}
      {...props}
    />
  )
}

export { Badge, type BadgeProps }
