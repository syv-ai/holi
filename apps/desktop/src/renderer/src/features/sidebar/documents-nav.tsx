import { useAtomValue } from "jotai"
import { cn } from "@/lib/cn"
import { SIDEBAR_ROW_FILL } from "@/composites/sidebar-nav-item"

import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { hotkeyLabels } from "@/lib/hotkey"
import { isMac } from "@/state/shortcuts"
import { useTabDrag } from "../shell/use-tab-drag"
import { surfacesAtom } from "@/state/plugins"
import { openTaskCountAtom } from "@/state/tasks"
import {
  AppWindowIcon,
  SearchIcon,
  SquareKanbanIcon,
} from "lucide-react"

/** The header tab id of the task board, beside the document paths. */
export const BOARD_TAB = "holi:board"

/** The header tab id of the vault's apps, beside the board. */
export const APPS_TAB = "holi:apps"

/** Whether vault apps are on: the Apps row is there only while they are. */
export function useAppsOn(): boolean {
  return useAtomValue(surfacesAtom).has("app")
}

/** The reveal curve for things that arrive (ReUI's motion rules). */
export const ARRIVE =
  "animate-in fade-in-0 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"

/** Search, Board and Apps, at the top of the Documents tab. */
export function DocumentsNav({
  activeId,
  onOpenSearch,
  onOpen,
}: {
  activeId: string | null
  onOpenSearch: () => void
  onOpen: (id: string) => void
}) {
  const openTasks = useAtomValue(openTaskCountAtom)
  // The Board row drags as its tab, onto the content or the strip.
  const tabDrag = useTabDrag()
  const appsOn = useAppsOn()

  return (
    <SidebarMenu className="gap-0.5 px-2">
      <SidebarMenuItem>
        <SidebarMenuButton onClick={onOpenSearch} className={SIDEBAR_ROW_FILL}>
          <SearchIcon aria-hidden="true" />
          <span>Search</span>
          <KbdGroup className="ms-auto">
            {hotkeyLabels("⌘K", isMac()).map((label) => (
              <Kbd key={label}>{label}</Kbd>
            ))}
          </KbdGroup>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={activeId === BOARD_TAB}
          aria-current={activeId === BOARD_TAB ? "page" : undefined}
          onClick={() => onOpen(BOARD_TAB)}
          {...tabDrag({ kind: "board" })}
          className={SIDEBAR_ROW_FILL}
        >
          <SquareKanbanIcon aria-hidden="true" />
          <span>Board</span>
          {openTasks > 0 ? (
            <span className="sr-only">, {openTasks} open tasks</span>
          ) : null}
        </SidebarMenuButton>
        {/* A sibling of the button, where the badge's own placement applies;
            keyed on the count, so a change pops it in again. */}
        {openTasks > 0 ? (
          <SidebarMenuBadge
            key={openTasks}
            aria-hidden="true"
            className={cn(ARRIVE, "zoom-in-95 motion-reduce:zoom-in-100")}
          >
            {openTasks}
          </SidebarMenuBadge>
        ) : null}
      </SidebarMenuItem>
      {appsOn ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={activeId === APPS_TAB}
            aria-current={activeId === APPS_TAB ? "page" : undefined}
            onClick={() => onOpen(APPS_TAB)}
            className={SIDEBAR_ROW_FILL}
          >
            <AppWindowIcon aria-hidden="true" />
            <span>Apps</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
    </SidebarMenu>
  )
}
