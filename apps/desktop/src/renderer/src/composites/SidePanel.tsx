import { X } from 'lucide-react'
import { Button } from '@/primitives'
import { cn } from '@/lib/cn'

/**
 * The chrome every workspace side panel shares: a full-height column with a
 * compact header bar (title · optional subtitle · optional actions · optional
 * close) over a body slot. It owns the shell, not the content — padding and
 * scroll belong to whatever fills `children`, because the panels differ there
 * (Settings pads and scrolls as one column; History splits a log over a diff).
 *
 * Domain-agnostic, so it lives in composites/ and every feature panel routes
 * through it — that is what makes them read as siblings instead of three
 * hand-rolled headers drifting apart. ≥2 uses justify the seam: VaultSettings
 * (a `close`), HistoryPanel (a `subtitle`); AgentPanel adopts it via `actions`.
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
  /** A dim, truncating second line of context (History's target path). When
   *  absent, a spacer takes its place so actions/close stay right-aligned. */
  subtitle?: React.ReactNode
  /** Right-aligned header controls, before the close (AgentPanel's restart/history). */
  actions?: React.ReactNode
  /** Renders a ghost close button when present; omit for panels toggled elsewhere. */
  onClose?: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <aside data-slot="side-panel" className={cn('flex h-full min-w-0 flex-col', className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="font-medium text-foreground">{title}</span>
        {subtitle === undefined ? (
          <span className="flex-1" />
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{subtitle}</span>
        )}
        {actions}
        {onClose && (
          <Button variant="ghost" size="icon-xs" onClick={onClose} title="close" aria-label="close panel">
            <X />
          </Button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </aside>
  )
}
