import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * The one row of controls at the top of a plugin pane (Mail's toolbar,
 * selection bar, find bar and reader header; Agenda's list and month
 * headers): `h-11`, `px-4`, `gap-1`, so every pane's first control and first
 * line of text share one left edge, and content below it is `px-4` too.
 *
 * Unlike `PanelHeader` it draws no edge and binds no hotkeys: a pane's
 * toolbar is free-form (a picker, a search field, pills), and the seam under
 * it, where there is one, is the caller's. Domain-agnostic, so a composite.
 */
export function PaneToolbar({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="pane-toolbar"
      className={cn('flex h-11 shrink-0 items-center gap-1 px-4', className)}
      {...props}
    />
  )
}
