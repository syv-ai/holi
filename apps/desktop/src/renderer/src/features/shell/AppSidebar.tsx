/**
 * The sidebar's two faces (app-shell-21's thread sidebar): open, the mode tabs
 * over that mode's body; folded, a 48px rail of the same places, one icon
 * each. The account and vault menu is at the foot of both.
 *
 * Agents' body is the agent plugin's own sidebar (Inbox, Automations, Holis,
 * sessions), drawn without core knowing its rows. Documents has no body yet.
 */
import { useAtom, useAtomValue } from 'jotai'
import { Bot, FileText, Search } from 'lucide-react'
import { EmptyState } from '@/composites'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  Tabs,
  TabsList,
  TabsTrigger,
  Icon,
} from '@/primitives'
import { appModeAtom, type AppMode } from '@/state/app-mode'
import { runningPluginsAtom } from '@/state/plugins'
import { NavUser } from './NavUser'

/** A rail button: the expanded row's button at icon size, its label hidden. */
const RAIL_BUTTON = 'size-8 p-2 [&>span:last-child]:sr-only'

export function AppSidebar({
  collapsed = false,
  onAddVault,
  onOpenSearch,
}: {
  /** Rail mode: the body is closed but the shell keeps its spine. */
  collapsed?: boolean
  onAddVault: () => void
  onOpenSearch: () => void
}): React.JSX.Element {
  const [mode, setMode] = useAtom(appModeAtom)
  // The one plugin that provides the Agents mode (the agent), if it runs.
  const agentsMode = useAtomValue(runningPluginsAtom).find((p) => p.agentsMode)?.agentsMode
  const shown: AppMode = agentsMode === undefined ? 'documents' : mode

  if (collapsed) {
    return (
      <Sidebar collapsible="none" className="h-full w-full overflow-hidden">
        <SidebarHeader className="px-2 pt-2 pb-0">
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search ⌘K"
                onClick={onOpenSearch}
                aria-label="Search"
                className={RAIL_BUTTON}
              >
                <Icon icon={Search} />
                <span>Search</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarSeparator className="mx-2 my-1 w-auto" />

        <SidebarContent className="overflow-hidden">
          <SidebarMenu className="gap-0.5 px-2">
            {agentsMode !== undefined && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Agents"
                  isActive={shown === 'agents'}
                  aria-current={shown === 'agents' ? 'page' : undefined}
                  onClick={() => setMode('agents')}
                  className={RAIL_BUTTON}
                >
                  <Icon icon={Bot} />
                  <span>Agents</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Documents"
                isActive={shown === 'documents'}
                aria-current={shown === 'documents' ? 'page' : undefined}
                onClick={() => setMode('documents')}
                className={RAIL_BUTTON}
              >
                <Icon icon={FileText} />
                <span>Documents</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="items-center px-2 pb-3">
          <NavUser collapsed onAddVault={onAddVault} />
        </SidebarFooter>
      </Sidebar>
    )
  }

  return (
    <Sidebar collapsible="none" className="h-full w-full">
      <SidebarContent className="gap-0">
        {agentsMode !== undefined && (
          <div className="px-2 pt-2 pb-3">
            <Tabs value={shown} onValueChange={(value) => value && setMode(value as AppMode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="agents">Agents</TabsTrigger>
                <TabsTrigger value="documents">Documents</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

        {shown === 'agents' && agentsMode !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <agentsMode.sidebar />
          </div>
        ) : (
          <EmptyState
            icon={FileText}
            title="Documents will live here"
            description="The file tree and pinned notes come back in the new sidebar."
          />
        )}
      </SidebarContent>

      <SidebarFooter>
        <NavUser onAddVault={onAddVault} />
      </SidebarFooter>
    </Sidebar>
  )
}
