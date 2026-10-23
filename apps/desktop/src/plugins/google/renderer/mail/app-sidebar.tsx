import type { ReactNode } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/plugin-api"
import { NAV_FOLDERS, type MailFolder } from "./data"

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
        left: expanded ? "var(--sidebar-width)" : "var(--sidebar-width-icon)",
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
  folder: MailFolder
  onSelectFolder: (folder: MailFolder) => void
  /** Folders with something unread get the block's dot. */
  unread: Partial<Record<MailFolder, boolean>>
  expanded: boolean
  onToggle: () => void
  /** The account menu, at the foot of the rail. */
  user: ReactNode
  /** The mail list column. */
  children: ReactNode
}

/**
 * The block's two inner sidebars: the icon rail of folders and the mail list.
 * Both are static (`collapsible="none"`): the block's outer sidebar was a
 * window-fixed one, which cannot sit inside Holi's own shell; collapsing the
 * list is the view's own state.
 */
export function AppSidebar({
  folder,
  onSelectFolder,
  unread,
  expanded,
  onToggle,
  user,
  children,
}: AppSidebarProps) {
  return (
    <>
      <div
        className={cn(
          "bg-sidebar text-sidebar-foreground flex h-full shrink-0 overflow-hidden border-r",
          expanded
            ? "w-(--sidebar-width)"
            : "w-[calc(var(--sidebar-width-icon)+1px)]"
        )}
      >
        {/* ── First inner sidebar: icon navigation rail ── */}
        <Sidebar
          collapsible="none"
          className="w-[calc(var(--sidebar-width-icon)+1px)]! border-r"
        >
          {/* Folder nav */}
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {NAV_FOLDERS.map((f) => (
                    <SidebarMenuItem key={f.id}>
                      <SidebarMenuButton
                        className="justify-center!"
                        tooltip={{ children: f.label, hidden: false }}
                        aria-label={f.label}
                        isActive={folder === f.id}
                        onClick={() => {
                          onSelectFolder(f.id)
                          if (!expanded) onToggle()
                        }}
                      >
                        <f.icon aria-hidden="true" />
                        {unread[f.id] === true && (
                          <span
                            className="bg-primary absolute top-0.5 right-0.5 size-1.5 rounded-full"
                            aria-hidden="true"
                          />
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          {/* Footer: the account */}
          <SidebarFooter>{user}</SidebarFooter>
        </Sidebar>

        {/* ── Second inner sidebar: mail list ── */}
        {expanded && children}
      </div>

      <SidebarRailToggle expanded={expanded} onToggle={onToggle} />
    </>
  )
}
