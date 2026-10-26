import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * A section's name over its rows (the sidebar's Pinned and Files): quiet,
 * small, never a control. After Linear's and Craft's sidebars, where the
 * sections are told apart by a muted label rather than a rule or a card.
 * The inset matches a nav row's 8px (`px-2`) so the label's first letter sits
 * over the row icons' left edge.
 */
export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn('px-2 pb-1 text-xs font-medium text-muted-foreground select-none', className)}
    >
      {children}
    </div>
  )
}
