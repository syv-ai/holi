import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * A mark on a small raised square: what a choice, a plugin or a setting IS,
 * at a glance, before its name is read (after ReUI's `settings-1`). The square
 * is a muted fill with a hairline and the faintest shadow, so a brand mark in
 * its own colour and a plain glyph in the foreground sit on the same ground.
 *
 * Holds an `<Icon size="lg">`, a brand mark from `marks.tsx`, or a `FileType`.
 */
export function IconTile({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/60 text-foreground shadow-xs',
        className,
      )}
    >
      {children}
    </span>
  )
}
