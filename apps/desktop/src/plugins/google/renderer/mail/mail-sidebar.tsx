import type { ReactNode } from "react"
import { cn } from "@/plugin-api"

// ── Sidebar Rail Toggle ──

/**
 * The block's rail toggle, positioned in the view rather than the window:
 * the view lives in a pane of Holi's shell, not at the window's edge.
 */
function SidebarRailToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={expanded ? "Collapse mail list" : "Expand mail list"}
      aria-expanded={expanded}
      onClick={onToggle}
      style={{
        left: expanded ? "var(--sidebar-width)" : 0,
      }}
      className={cn(
        "group/rail absolute top-1/2 z-30 flex h-12 w-7 -translate-y-1/2 cursor-pointer items-center pl-2 outline-none",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1",
        "focus-visible:rounded-sm"
      )}
    >
      <span className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className={cn(
            "bg-foreground/40 block h-2 w-0.5 rounded-t-full",
            "origin-bottom transition-transform duration-100 ease-linear",
            expanded
              ? "group-hover/rail:bg-foreground/60 group-hover/rail:rotate-40"
              : "group-hover/rail:bg-foreground/60 group-hover/rail:-rotate-40"
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            "bg-foreground/40 block h-2 w-0.5 rounded-b-full",
            "origin-top transition-transform duration-100 ease-linear",
            expanded
              ? "group-hover/rail:bg-foreground/60 group-hover/rail:-rotate-40"
              : "group-hover/rail:bg-foreground/60 group-hover/rail:rotate-40"
          )}
        />
      </span>

      <span
        className={cn(
          "border-border bg-foreground text-background absolute left-full -ml-2 border px-2 py-0.5 text-xs font-medium whitespace-nowrap shadow-xs shadow-black/5",
          "rounded-md",
          "pointer-events-none -translate-x-0.5 opacity-0 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
          "group-hover/rail:translate-x-0 group-hover/rail:opacity-100"
        )}
      >
        {expanded ? "Collapse" : "Expand"}
      </span>
    </button>
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
          "text-sidebar-foreground flex h-full shrink-0 overflow-hidden",
          expanded ? "w-(--sidebar-width) border-r" : "w-0"
        )}
      >
        {expanded && children}
      </div>

      <SidebarRailToggle expanded={expanded} onToggle={onToggle} />
    </>
  )
}
