import { useAtom, useAtomValue } from "jotai"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/cn"
import { runningPluginsAtom } from "@/state/plugins"
import {
  sidebarSectionAtom,
  type SidebarSection,
} from "@/state/sidebar-section"
import { activeRemoteAtom } from "@/state/vaults"
import type { Move } from "@/lib/tree-actions"
import {
  BOARD_TAB,
  DocumentsNav,
  FilesSection,
  NewDocumentNav,
} from "./documents-section"
import { NavUser } from "./nav-user"
import { ReuiMark } from "./reui-mark"
import { VaultSwitcher } from "./vault-switcher"
import { SidebarAppItem, useSidebarApps } from "./sidebar-apps"
import {
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SquareKanbanIcon,
} from "lucide-react"

const RAIL_BUTTON =
  "hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"

export function ThreadSidebar({
  activeId,
  collapsed = false,
  onOpen,
  onMoved,
  onNewDocument,
  onAddVault,
  onToggle,
  onOpenSearch,
  activeApp,
  onOpenApp,
}: {
  /** The open tab: a vault path, or the board. */
  activeId: string | null
  /** Rail mode: the list is closed but the shell keeps its spine. */
  collapsed?: boolean
  onOpen: (id: string) => void
  onMoved: (moves: Move[]) => void
  onNewDocument: () => void
  onAddVault: () => void
  onToggle: () => void
  onOpenSearch: () => void
  /** The app holding the window (Mail, Calendar), or null for the files. */
  activeApp: string | null
  onOpenApp: (id: string) => void
}) {
  const apps = useSidebarApps()
  const [section, setSection] = useAtom(sidebarSectionAtom)
  const remote = useAtomValue(activeRemoteAtom)
  /** Off until the first switch, so the sidebar's first paint is never held
   *  back by a fade. */
  const [switched, setSwitched] = useState(false)
  const { isMobile } = useSidebar()
  const AgentsSidebar = useAtomValue(runningPluginsAtom).find(
    (plugin) => plugin.agentsMode
  )?.agentsMode?.sidebar

  if (collapsed) {
    // Same SidebarMenuButton as the expanded nav, so hover, active and the
    // label transition are the primitive's, not a second implementation.
    return (
      <Sidebar collapsible="none" className="h-full w-full overflow-hidden">
        <SidebarContent className="overflow-hidden">
          <SidebarMenu className="gap-0.5 px-2 pt-2">
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search"
                onClick={onOpenSearch}
                aria-label="Search"
                className={RAIL_BUTTON}
              >
                <SearchIcon aria-hidden="true" />
                <span>Search</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Board"
                isActive={activeId === BOARD_TAB}
                onClick={() => onOpen(BOARD_TAB)}
                aria-label="Board"
                className={RAIL_BUTTON}
              >
                <SquareKanbanIcon aria-hidden="true" />
                <span>Board</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New document"
                onClick={onNewDocument}
                aria-label="New document"
                className={RAIL_BUTTON}
              >
                <PlusIcon aria-hidden="true" />
                <span>New document</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="gap-1 px-2 pb-3">
          <SidebarMenu className="gap-0.5">
            {apps.map((app) => (
              <SidebarAppItem
                key={app.id}
                app={app}
                collapsed
                active={app.id === activeApp}
                onSelect={onOpenApp}
                className={RAIL_BUTTON}
              />
            ))}
          </SidebarMenu>
          <NavUser collapsed />
        </SidebarFooter>
      </Sidebar>
    )
  }

  return (
    <Sidebar collapsible="none" className="h-full w-full">
      {/* On desktop the title band carries these; the phone sheet has no band. */}
      {isMobile ? (
        <SidebarHeader className="gap-2">
          <div className="flex items-center gap-2 px-1 pt-1">
            <ReuiMark />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
              Holi
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Search"
              onClick={onOpenSearch}
            >
              <SearchIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close sidebar"
              onClick={onToggle}
            >
              <PanelLeftIcon aria-hidden="true" />
            </Button>
          </div>
        </SidebarHeader>
      ) : null}

      {/* Two equal tabs: the body below switches with them. */}
      <SidebarContent className="overflow-hidden">
        <div className="flex flex-col gap-3 px-2 py-3">
          <VaultSwitcher onAddVault={onAddVault} />
          <Tabs
            value={section}
            onValueChange={(value) => {
              if (!value) return
              setSection(value as SidebarSection)
              setSwitched(true)
            }}
          >
            <TabsList className="bg-foreground/5 grid w-full grid-cols-2">
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* A switch of tab or vault cross-fades the body instead of swapping it. */}
        <div
          key={`${section}:${remote}`}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            switched &&
              "animate-in fade-in-0 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
          )}
        >
          {section === "documents" ? (
            <>
              <DocumentsNav
                activeId={activeId}
                onOpenSearch={onOpenSearch}
                onOpen={onOpen}
              />
              <SidebarSeparator className="mx-0 my-3" />
              <NewDocumentNav onNewDocument={onNewDocument} />
              <FilesSection
                activeId={activeId}
                onOpen={onOpen}
                onMoved={onMoved}
              />
            </>
          ) : null}

          {section === "agents" ? (
            // The agent plugin's own sidebar: Inbox, Automations, Holis, sessions.
            AgentsSidebar ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                <AgentsSidebar />
              </div>
            ) : null
          ) : null}
        </div>
      </SidebarContent>

      <SidebarFooter className="gap-2">
        {/* Apps that take the window over (Mail, Calendar), above the profile. */}
        <SidebarMenu className="gap-0.5">
          {apps.map((app) => (
            <SidebarAppItem
              key={app.id}
              app={app}
              collapsed={false}
              active={app.id === activeApp}
              onSelect={onOpenApp}
              className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
            />
          ))}
        </SidebarMenu>

        <NavUser />
      </SidebarFooter>
    </Sidebar>
  )
}
