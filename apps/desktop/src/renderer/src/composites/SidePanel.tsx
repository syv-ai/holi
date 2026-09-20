import { X } from 'lucide-react'
import { PanelHeader, type HeaderAction } from './PanelHeader'
import { cn } from '@/lib/cn'

/**
 * The chrome every workspace side panel shares: a full-height column whose header
 * bar is the shared `PanelHeader`, over a body slot. It owns the shell, not the
 * content — padding and scroll belong to whatever fills `children`, because the
 * panels differ there (Settings pads and scrolls as one column; History splits a
 * log over a diff).
 *
 * A convenience over PanelHeader for the common panel shape: a string `title`, an
 * optional `subtitle`, structured header `actions`, and a plain `onClose` that
 * becomes the trailing close control. A panel that needs a richer header
 * composes PanelHeader directly instead.
 *
 * Width/resize is not this component's job — the Resizable group around it owns
 * that. A SidePanel only fills the panel it is given.
 */
export function SidePanel({
  title,
  subtitle,
  actions,
  onClose,
  className,
  children,
}: {
  title: string
  /** A dim, truncating second line of context (History's target path). */
  subtitle?: React.ReactNode
  /** Right-aligned header controls, before the close (structured, not raw JSX). */
  actions?: HeaderAction[]
  /** Renders a ghost close button when present; omit for panels toggled elsewhere. */
  onClose?: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <aside
      data-slot="side-panel"
      // Every side panel in the app arrives from the edge it lives on, which is
      // the right-hand one for all three of them (history, the last turn, the
      // agent). On the panel's CONTENT rather than on the `ResizablePanel`
      // around it: animating the panel itself fights the group's sizing maths
      // and the persisted layout, because the group is what decides its width.
      className={cn('motion-in-right flex h-full min-w-0 flex-col', className)}
    >
      <PanelHeader
        actions={actions}
        close={onClose ? { icon: <X />, label: 'Close panel', onSelect: onClose } : undefined}
      >
        <span className="font-medium text-foreground">{title}</span>
        {subtitle !== undefined && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{subtitle}</span>
        )}
      </PanelHeader>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </aside>
  )
}
