import type { ReactNode } from 'react'
import { cn } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// ── Sidebar Rail Toggle ──

/**
 * The block's rail toggle, positioned in the view rather than the window:
 * the view lives in a pane of Holi's shell, not at the window's edge.
 */
function SidebarRailToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={expanded ? 'Collapse mail list' : 'Expand mail list'}
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(
            'group/rail absolute top-1/2 z-30 -translate-y-1/2 hover:bg-transparent dark:hover:bg-transparent',
            expanded ? 'left-(--sidebar-width)' : 'left-0',
          )}
        >
          <span className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className={cn(
                'bg-foreground/40 block h-2 w-0.5 rounded-t-full',
                'origin-bottom motion-respond',
                expanded
                  ? 'group-hover/rail:bg-foreground/60 group-hover/rail:rotate-40'
                  : 'group-hover/rail:bg-foreground/60 group-hover/rail:-rotate-40',
              )}
            />
            <span
              aria-hidden="true"
              className={cn(
                'bg-foreground/40 block h-2 w-0.5 rounded-b-full',
                'origin-top motion-respond',
                expanded
                  ? 'group-hover/rail:bg-foreground/60 group-hover/rail:-rotate-40'
                  : 'group-hover/rail:bg-foreground/60 group-hover/rail:rotate-40',
              )}
            />
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{expanded ? 'Collapse' : 'Expand'}</TooltipContent>
    </Tooltip>
  )
}

// ── App Sidebar ──

interface AppSidebarProps {
  expanded: boolean
  onToggle: () => void
  /** The mail list column. */
  children: ReactNode
}

/**
 * The mail list column and the toggle that folds it away. The block's icon
 * rail of folders is gone: the account sits at the top of the list and the
 * mailboxes are its title's menu. No fill of its own, so the window's surface
 * shows through.
 */
export function AppSidebar({ expanded, onToggle, children }: AppSidebarProps) {
  return (
    <>
      <div
        className={cn(
          'text-sidebar-foreground flex h-full shrink-0 overflow-hidden',
          expanded ? 'w-(--sidebar-width) border-r' : 'w-0',
        )}
      >
        {expanded && children}
      </div>

      <SidebarRailToggle expanded={expanded} onToggle={onToggle} />
    </>
  )
}
