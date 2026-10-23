import { useAtomValue } from "jotai"
import { AppWindowIcon, BotIcon, FileTextIcon, SearchIcon } from "lucide-react"

import { IconStackEmpty } from "@/components/reui/icon-stack-empty"
import { SettingsView } from "@/components/blocks/profile-9/components/settings-view"
import { runningPluginsAtom, surfacesAtom } from "@/state/plugins"
import { parseTabKey } from "@/state/tab-descriptor"

import { PlanningView } from "../../planning/planning-view"
import { EmptyView } from "./empty-view"
import { useSidebarApps } from "./sidebar-apps"

/**
 * What one tab shows (docs/features/tabs-panes.md): the view switch the shell
 * used to make for its one main area, now made once per pane for the pane's
 * active tab. A null tab is an empty pane, which shows the New tab's view.
 */
export function TabView({
  tab,
  settingsNavInSidebar,
  onOpen,
  onNewDocument,
  onOpenSearch,
}: {
  tab: string | null
  /** Whether the sidebar carries Settings' nav for this tab; otherwise the
   *  view draws its own. */
  settingsNavInSidebar: boolean
  /** Open a vault path or the board, the way the shell opens one. */
  onOpen: (key: string) => void
  onNewDocument: () => void
  onOpenSearch: () => void
}) {
  const running = useAtomValue(runningPluginsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const apps = useSidebarApps()
  const AgentsMain = running.find((plugin) => plugin.agentsMode)?.agentsMode
    ?.main
  const descriptor = tab === null ? null : parseTabKey(tab)

  switch (descriptor?.kind) {
    case undefined:
    case "new":
      return (
        <EmptyView
          key={tab ?? "none"}
          onOpen={onOpen}
          onNewDocument={onNewDocument}
          onOpenSearch={onOpenSearch}
        />
      )
    case "board":
      return <PlanningView onOpenTask={onOpen} />
    case "settings":
      return <SettingsView navHidden={!settingsNavInSidebar} />
    case "app": {
      const AppView = apps.find((app) => app.id === descriptor.id)?.render
      if (AppView === undefined) {
        return (
          <IconStackEmpty
            icon={AppWindowIcon}
            title="This app is not running"
            description="Turn its plugin on, or connect the account it needs, to open it here."
            action={{
              label: "Search",
              icon: SearchIcon,
              onClick: onOpenSearch,
            }}
          />
        )
      }
      // An app arrives from the rail's edge, where the files just folded
      // away: once per switch, keyed on the tab.
      return (
        <div
          key={tab}
          className="animate-in fade-in-0 slide-in-from-left-3 motion-reduce:slide-in-from-left-0 flex min-h-0 flex-1 flex-col duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
        >
          <AppView />
        </div>
      )
    }
    case "agents-home":
    case "session":
      if (AgentsMain === undefined) {
        return (
          <IconStackEmpty
            icon={BotIcon}
            title="Agents are not running"
            description="The agent plugin is off in this vault."
            action={{
              label: "Search",
              icon: SearchIcon,
              onClick: onOpenSearch,
            }}
          />
        )
      }
      return (
        <AgentsMain
          key={tab}
          selection={
            descriptor.kind === "session"
              ? { owner: descriptor.owner, id: descriptor.id }
              : null
          }
        />
      )
    case "vault-app": {
      // A vault app is the `app` surface, by its bundle's path.
      const AppSurface = surfaces.get("app")?.render
      if (AppSurface !== undefined) {
        return <AppSurface key={tab} id={descriptor.path} visible />
      }
      return (
        <IconStackEmpty
          icon={AppWindowIcon}
          title={descriptor.path}
          description="Vault apps open here once their runner is part of this shell."
          action={{ label: "Search", icon: SearchIcon, onClick: onOpenSearch }}
        />
      )
    }
    case "doc":
      // The document editor's slot: `DocumentView` renders `descriptor.path`
      // here once it is part of this shell.
      return (
        <IconStackEmpty
          key={tab}
          icon={FileTextIcon}
          title={descriptor.path}
          description="Documents open here once the editor is part of this shell."
          action={{ label: "Search", icon: SearchIcon, onClick: onOpenSearch }}
        />
      )
  }
}
