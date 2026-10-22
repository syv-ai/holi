// The sidebar (ReUI app-shell-21's thread sidebar, wired to Holi): open, the
// Documents and Agents tabs over that mode's body; collapsed, a 48px rail of
// the same places. The account and vault menu is at the foot of both. The
// header row the block had here lives in the shell's full-width header.
//
// Agents' body is the agent plugin's own sidebar (Inbox, Automations, Holis,
// sessions), which core draws without knowing its rows.
import { useAtom, useAtomValue } from "jotai"
import { BotIcon, FileTextIcon, SearchIcon } from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { appModeAtom, type AppMode } from "@/state/app-mode"
import { runningPluginsAtom } from "@/state/plugins"

import { NavUser } from "./nav-user"

const RAIL_BUTTON =
  "hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"

export function ThreadSidebar({
  collapsed = false,
  onOpenSearch,
  onAddVault,
}: {
  /** Rail mode: the body is closed but the shell keeps its spine. */
  collapsed?: boolean
  onOpenSearch: () => void
  onAddVault: () => void
}) {
  const [mode, setMode] = useAtom(appModeAtom)
  // The one plugin that provides the Agents mode (the agent), if it runs.
  const agentsMode = useAtomValue(runningPluginsAtom).find(
    (plugin) => plugin.agentsMode
  )?.agentsMode
  const shown: AppMode = agentsMode === undefined ? "documents" : mode

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
          </SidebarMenu>

          <SidebarSeparator className="mx-2 my-1 w-auto" />

          <SidebarMenu className="gap-0.5 px-2">
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Documents"
                isActive={shown === "documents"}
                onClick={() => setMode("documents")}
                className={RAIL_BUTTON}
              >
                <FileTextIcon aria-hidden="true" />
                <span>Documents</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {agentsMode !== undefined ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Agents"
                  isActive={shown === "agents"}
                  onClick={() => setMode("agents")}
                  className={RAIL_BUTTON}
                >
                  <BotIcon aria-hidden="true" />
                  <span>Agents</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="gap-1 px-2 pb-3">
          <NavUser collapsed onAddVault={onAddVault} />
        </SidebarFooter>
      </Sidebar>
    )
  }

  return (
    <Sidebar collapsible="none" className="h-full w-full">
      {/* Two equal tabs: the body below switches with them. */}
      <SidebarContent>
        {agentsMode !== undefined ? (
          <div className="px-2 py-3">
            <Tabs
              value={shown}
              onValueChange={(value) => value && setMode(value as AppMode)}
            >
              <TabsList className="bg-foreground/5 grid w-full grid-cols-2">
                <TabsTrigger value="documents">Documents</TabsTrigger>
                <TabsTrigger value="agents">Agents</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        ) : null}

        {shown === "agents" && agentsMode !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <agentsMode.sidebar />
          </div>
        ) : (
          <Empty className="border-0 bg-transparent py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileTextIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No Documents Yet</EmptyTitle>
              <EmptyDescription>
                The file tree comes back here in the new sidebar.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter className="gap-2">
        <NavUser onAddVault={onAddVault} />
      </SidebarFooter>
    </Sidebar>
  )
}
