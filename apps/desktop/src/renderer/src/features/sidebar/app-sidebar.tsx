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
import { APPS_TAB, BOARD_TAB, DocumentsNav, useAppsOn } from "./documents-nav"
import { FilesSection } from "./files-section"
import { AccountMenu } from "./account-menu"
import { BrandMark } from "@/composites/brand-mark"
import { VaultSwitcher } from "./vault-switcher"
import { SidebarAppItem, useSidebarApps } from "./sidebar-apps"
import {
  AppWindowIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SquareKanbanIcon,
} from "lucide-react"

export function AppSidebar({
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
  const appsOn = useAppsOn()
  /** Off until the first switch, so the sidebar's first paint is never held
   *  back by a fade. */
  const [switched, setSwitched] = useState(false)
  const { isMobile } = useSidebar()
  const AgentsSidebar = useAtomValue(runningPluginsAtom).find(
    (plugin) => plugin.agentsMode
  )?.agentsMode?.sidebar

  if (collapsed) {
    // Same SidebarMenuButton as the expanded nav, so hover, active and the
    // label transition are the component's, not a second implementation.
    return (
      <Sidebar collapsible="none" className="h-full w-full overflow-hidden">
        <SidebarContent className="overflow-hidden">
          <div className="px-2 pt-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search"
                onClick={onOpenSearch}
                aria-label="Search"
                variant="fill"
                size="rail"
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
                variant="fill"
                size="rail"
              >
                <SquareKanbanIcon aria-hidden="true" />
                <span>Board</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {appsOn ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Apps"
                  isActive={activeId === APPS_TAB}
                  onClick={() => onOpen(APPS_TAB)}
                  aria-label="Apps"
                  variant="fill"
                size="rail"
                >
                  <AppWindowIcon aria-hidden="true" />
                  <span>Apps</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}

            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New document"
                onClick={onNewDocument}
                aria-label="New document"
                variant="fill"
                size="rail"
              >
                <PlusIcon aria-hidden="true" />
                <span>New document</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          </div>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            {apps.map((app) => (
              <SidebarAppItem
                key={app.id}
                app={app}
                collapsed
                active={app.id === activeApp}
                onSelect={onOpenApp}
              />
            ))}
          </SidebarMenu>
          <AccountMenu collapsed />
        </SidebarFooter>
      </Sidebar>
    )
  }

  return (
    <Sidebar collapsible="none" className="h-full w-full">
      {/* On desktop the title band carries these; the phone sheet has no band. */}
      {isMobile ? (
        <SidebarHeader>
          <div className="flex items-center gap-2 px-1 pt-1">
            <BrandMark variant="monogram" className="h-5" />
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
              "motion-in-fade"
          )}
        >
          {section === "documents" ? (
            // Space between the groups, not a rule, as in the Agents tab; the
            // Files group's own inset makes up the rest.
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <DocumentsNav
                activeId={activeId}
                onOpenSearch={onOpenSearch}
                onOpen={onOpen}
              />
              <FilesSection
                activeId={activeId}
                onOpen={onOpen}
                onMoved={onMoved}
              />
            </div>
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

      <SidebarFooter>
        {/* Apps that take the window over (Mail, Calendar), above the profile. */}
        <SidebarMenu>
          {apps.map((app) => (
            <SidebarAppItem
              key={app.id}
              app={app}
              collapsed={false}
              active={app.id === activeApp}
              onSelect={onOpenApp}
            />
          ))}
        </SidebarMenu>

        <AccountMenu />
      </SidebarFooter>
    </Sidebar>
  )
}
